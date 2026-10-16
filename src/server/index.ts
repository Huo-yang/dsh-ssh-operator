#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, posix } from "node:path";
import {
  baseOpenSshArgs,
  baseSshArgs,
  buildManagedRemoteCommand,
  buildManagedSudoRemoteCommand,
  defaultSshConfigPath,
  remoteSpec,
  scpExecutable,
  shellQuote,
  sshExecutable,
  validateRemotePath,
} from "./commands.js";
import { runProcess, type RemoteTerminationResult } from "./process-runner.js";
import { ProcessManager } from "./process-manager.js";
import { listConcreteHosts } from "./ssh-config.js";
import { ActiveProcessStore, type ActiveProcessRecord } from "./active-process-store.js";
import { ProcessLogStore } from "./process-log-store.js";
import { TextOperationStore } from "./text-operation-store.js";
import { classifyProcessFailure, OperatorError } from "./errors.js";
import { runDoctor } from "./doctor.js";
import { parseRemoteStat, parseSha256, remoteHashCommand, remoteStatCommand, sha256File } from "./file-operations.js";
import {
  analyzeText,
  applyUnifiedPatch,
  normalizeOperationId,
  paginateText,
  parseRemoteText,
  remoteAtomicWriteCommand,
  remoteReadTextCommand,
  sha256Text,
  type RemoteTextDocument,
  type TextWriteMode,
} from "./remote-text.js";
import { contextualizeCommand, executionContextSummary } from "./execution-context.js";
import { errorResponse as toolError, processResponse as resultContent } from "./tool-response.js";
import { commonFields, executionContextFields } from "./tool-schemas.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";

const server = new McpServer({ name: "ssh-operator-mcp", version: "0.18.1" });
const processManager = new ProcessManager();
const activeProcessStore = new ActiveProcessStore();
const processLogStore = new ProcessLogStore();
const textOperationStore = new TextOperationStore();
const textOperationRequests = new Map<string, string>();

interface RecoveryEvent extends Record<string, unknown> {
  processId: string;
  host: string;
  remotePid: number;
  outcome: "skipped-live-owner" | "already-exited" | "terminated" | "killed" | "failed";
  error?: string;
}

const recoveryEvents: RecoveryEvent[] = [];

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopRemoteProcessGroup(
  host: string,
  remotePid: number,
  token?: string,
): Promise<RemoteTerminationResult> {
  const startedAt = Date.now();
  const target = `-${remotePid}`;
  const command = [
    `target=${shellQuote(target)}`,
    `if ! kill -0 -- "$target" 2>/dev/null; then printf 'already-exited\\n'; exit 0; fi`,
    ...(token
      ? [
          `if [ ! -r /proc/${remotePid}/cmdline ] || ! tr '\\000' '\\n' < /proc/${remotePid}/cmdline | grep -Fq -- ${shellQuote(token)}; then printf 'identity-mismatch\\n'; exit 24; fi`,
        ]
      : []),
    `kill -TERM -- "$target" 2>/dev/null || exit 21`,
    `i=0`,
    `while kill -0 -- "$target" 2>/dev/null && [ "$i" -lt 20 ]; do i=$((i + 1)); sleep 0.1; done`,
    `if ! kill -0 -- "$target" 2>/dev/null; then printf 'terminated\\n'; exit 0; fi`,
    `kill -KILL -- "$target" 2>/dev/null || exit 22`,
    `i=0`,
    `while kill -0 -- "$target" 2>/dev/null && [ "$i" -lt 10 ]; do i=$((i + 1)); sleep 0.1; done`,
    `if kill -0 -- "$target" 2>/dev/null; then exit 23; fi`,
    `printf 'killed\\n'`,
  ].join("; ");
  const result = await runProcess({
    executable: sshExecutable(),
    args: [...baseSshArgs(host), command],
    timeoutMs: 8_000,
  });
  const state = result.stdout.trim();
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    !["already-exited", "terminated", "killed"].includes(state)
  ) {
    throw new Error(
      `Remote process-group cleanup failed for PID ${remotePid}: exit=${result.exitCode}, stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return {
    remotePid,
    state: state as RemoteTerminationResult["state"],
    termSent: state !== "already-exited",
    killSent: state === "killed",
    durationMs: Date.now() - startedAt,
  };
}

async function reconcileActiveProcesses(records: ActiveProcessRecord[]): Promise<void> {
  for (const record of records) {
    if (!record.detached && isLocalProcessAlive(record.ownerPid)) {
      recoveryEvents.push({
        processId: record.processId,
        host: record.host,
        remotePid: record.remotePid,
        outcome: "skipped-live-owner",
      });
      continue;
    }
    try {
      const termination = await stopRemoteProcessGroup(record.host, record.remotePid, record.token);
      activeProcessStore.remove(record.processId);
      processLogStore.finish(record.processId, termination.state);
      recoveryEvents.push({
        processId: record.processId,
        host: record.host,
        remotePid: record.remotePid,
        outcome: termination.state,
      });
    } catch (error) {
      recoveryEvents.push({
        processId: record.processId,
        host: record.host,
        remotePid: record.remotePid,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}


server.registerTool(
  "ssh_list_hosts",
  {
    description: "List concrete Host aliases from the Windows user's OpenSSH config.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const configPath = defaultSshConfigPath();
      const hosts = await listConcreteHosts(configPath);
      return {
        content: [
          { type: "text", text: JSON.stringify({ configPath, hosts }, null, 2) },
        ],
        structuredContent: { configPath, hosts },
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_doctor",
  {
    description: "Diagnose local SSH-operator prerequisites and optionally inspect a remote host without changing configuration.",
    inputSchema: {
      host: z.string().optional().describe("Optional only for local diagnostics. Pass an explicit concrete Host alias to include remote checks."),
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ host, timeoutMs }) => {
    try {
      const payload = await runDoctor(activeProcessStore, processLogStore, textOperationStore, host, timeoutMs);
      const remoteFailure = payload.remote ? classifyProcessFailure(payload.remote.result, "connect") : undefined;
      const response = { ...payload, ...(remoteFailure ?? {}) };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response, isError: !response.ok };
    } catch (error) {
      return toolError(error, "local");
    }
  },
);

server.registerTool(
  "ssh_list_recovery_records",
  {
    description: "List durable managed-process recovery records and reconciliation outcomes from this MCP startup.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const payload = {
      statePath: activeProcessStore.path,
      records: activeProcessStore.list().map(({ token, ...record }) => ({
        ...record,
        tokenFingerprint: token.slice(0, 8),
      })),
      startupEvents: recoveryEvents,
      storageDiagnostics: activeProcessStore.diagnostics(),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "ssh_reconcile_processes",
  {
    description: "Retry safe reconciliation of retained or transport-detached managed-process records.",
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
  async () => {
    const eventOffset = recoveryEvents.length;
    await reconcileActiveProcesses(activeProcessStore.list());
    const payload = {
      events: recoveryEvents.slice(eventOffset),
      remainingRecords: activeProcessStore.list().map(({ token, ...record }) => ({
        ...record,
        tokenFingerprint: token.slice(0, 8),
      })),
    };
    const failed = payload.events.some((event) => event.outcome === "failed");
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: failed,
    };
  },
);

server.registerTool(
  "ssh_list_process_logs",
  {
    description: "List opt-in persisted managed-process logs available on the local control plane.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const payload = { directory: processLogStore.directory, logs: processLogStore.list(), storageDiagnostics: processLogStore.diagnostics() };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "ssh_read_process_log",
  {
    description: "Read an opt-in persisted managed-process log after a sequence cursor.",
    inputSchema: {
      processId: z.string().uuid(),
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ processId, cursor, limit }) => {
    try {
      const payload = await processLogStore.read(processId, cursor, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_delete_process_log",
  {
    description: "Permanently delete one completed persisted managed-process log from the local control plane.",
    inputSchema: { processId: z.string().uuid() },
    annotations: { destructiveHint: true },
  },
  async ({ processId }) => {
    try {
      const active = processManager.list().find((candidate) => candidate.processId === processId && candidate.running);
      if (active) throw new Error("Cannot delete the persisted log while its managed process is running.");
      processLogStore.delete(processId);
      const payload = { ok: true, processId };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/u).transform((value) => value.toLowerCase());
const textOperationFields = {
  host: commonFields.host,
  remotePath: z.string().min(1).describe("Absolute POSIX path to one remote text file"),
  timeoutMs: commonFields.timeoutMs,
  operationId: z.string().uuid().optional().describe("Optional stable UUID used to correlate a safe retry"),
};

function textOperatorError(
  message: string,
  errorCode: "FILE_CHANGED_CONCURRENTLY" | "FILE_LOCKED" | "FILE_TOO_LARGE" | "FILE_TYPE_UNSUPPORTED" | "PATCH_CONTEXT_MISMATCH" | "COMMIT_STATUS_UNKNOWN" | "OPERATION_ID_REUSED" | "VALIDATION_FAILED",
  context: Record<string, unknown> = {},
  retryable = false,
): OperatorError {
  return new OperatorError(message, { errorCode, phase: errorCode === "VALIDATION_FAILED" ? "validation" : "edit", retryable }, context);
}

function classifyTextState(output: string, remotePath: string, expectedSha256?: string): OperatorError | undefined {
  const stateLine = output.split(/\r?\n/u).find((line) => line.startsWith("STATE|"));
  if (!stateLine) return undefined;
  const [, state, detail] = stateLine.split("|");
  if (state === "locked") return textOperatorError("Another SSH Operator edit currently holds the remote directory lock.", "FILE_LOCKED", { remotePath }, true);
  if (["symlink-refused", "not-regular"].includes(state)) return textOperatorError(`Remote text target is unsupported: ${state}.`, "FILE_TYPE_UNSUPPORTED", { remotePath, state });
  if (state === "too-large") return textOperatorError("Remote text file exceeds the configured read limit.", "FILE_TOO_LARGE", { remotePath, actualBytes: Number(detail) });
  if (["conflict", "concurrent-create", "already-exists"].includes(state)) {
    return textOperatorError("Remote file changed or was created concurrently; reread it before editing.", "FILE_CHANGED_CONCURRENTLY", { remotePath, expectedSha256: expectedSha256 ?? null, actualSha256: detail ?? null, state }, true);
  }
  if (state === "missing") return textOperatorError("Remote file does not exist for replacement.", "VALIDATION_FAILED", { remotePath, state });
  if (state === "flock-missing") return textOperatorError("Remote host does not provide flock, which is required for coordinated text edits.", "VALIDATION_FAILED", { remotePath, state });
  if (["staged-hash-mismatch", "verify-failed"].includes(state)) return textOperatorError("Remote write failed hash verification.", "COMMIT_STATUS_UNKNOWN", { remotePath, observedSha256: detail ?? null, state }, true);
  return textOperatorError(`Remote text operation failed in state ${state}.`, "VALIDATION_FAILED", { remotePath, state, detail: detail ?? null });
}

async function readRemoteText(
  host: string,
  remotePath: string,
  maxFileBytes: number,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  elevated = false,
): Promise<RemoteTextDocument & { durationMs: number }> {
  validateRemotePath(remotePath);
  const command = remoteReadTextCommand(remotePath, maxFileBytes);
  const result = await runProcess({
    executable: sshExecutable(),
    args: [...baseSshArgs(host), elevated ? buildManagedSudoRemoteCommand(command) : buildManagedRemoteCommand(command)],
    timeoutMs,
    maxOutputBytes: Math.min(20 * 1024 * 1024, Math.ceil(maxFileBytes * 4 / 3) + 16 * 1024),
    signal,
    expectRemotePid: true,
    stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
  });
  const failure = classifyProcessFailure(result, "edit");
  if (failure) {
    const textFailure = classifyTextState(result.stdout, remotePath);
    if (textFailure) throw textFailure;
    if (elevated) {
      const sudoMessage = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (/sudo:.*(?:password|authentication is required|terminal)/su.test(sudoMessage)) {
        throw new OperatorError("Non-interactive sudo authorization is required.", { errorCode: "SUDO_AUTH_REQUIRED", phase: "authorize", retryable: false });
      }
    }
    throw new OperatorError(`Remote text read failed: ${result.stderr || result.stdout}`, failure);
  }
  try {
    return { ...parseRemoteText(result.stdout), durationMs: result.durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/changed while|hash mismatch/u.test(message)) throw textOperatorError(message, "FILE_CHANGED_CONCURRENTLY", { remotePath }, true);
    if (/NUL|utf-8|encoded data/u.test(message)) throw textOperatorError(message, "FILE_TYPE_UNSUPPORTED", { remotePath });
    throw error;
  }
}

async function observeRemoteHash(host: string, remotePath: string, elevated: boolean, timeoutMs?: number): Promise<string | "missing" | undefined> {
  const command = `if [ -f ${shellQuote(remotePath)} ]; then ${remoteHashCommand(remotePath)}; elif [ ! -e ${shellQuote(remotePath)} ]; then printf 'missing\\n'; else exit 3; fi`;
  const result = await runProcess({
    executable: sshExecutable(),
    args: [...baseSshArgs(host), elevated ? buildManagedSudoRemoteCommand(command) : buildManagedRemoteCommand(command)],
    timeoutMs: Math.min(timeoutMs ?? 120_000, 15_000),
    maxOutputBytes: 4096,
    expectRemotePid: true,
    stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
  });
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return value === "missing" ? "missing" : parseSha256(value);
}

async function replayStoredTextOperation(options: {
  host: string;
  remotePath: string;
  operationId: string;
  requestDigest: string;
  elevated: boolean;
  timeoutMs?: number;
}) {
  const record = textOperationStore.get(options.host, options.operationId);
  if (!record) return undefined;
  if (record.requestDigest !== options.requestDigest || record.remotePath !== options.remotePath) {
    throw textOperatorError("operationId was already committed for a different text mutation.", "OPERATION_ID_REUSED", { host: options.host, remotePath: options.remotePath, operationId: options.operationId, requestDigest: options.requestDigest, recordedRequestDigest: record.requestDigest });
  }
  const observed = await observeRemoteHash(options.host, options.remotePath, options.elevated, options.timeoutMs);
  if (observed === record.afterSha256) {
    return { ...record.result, state: "already-applied", alreadyApplied: true, observedSha256: observed, verified: true, replayedFromDurableReceipt: true };
  }
  throw textOperatorError("A previously committed operation was found, but the remote file has changed since that commit.", "FILE_CHANGED_CONCURRENTLY", { host: options.host, remotePath: options.remotePath, operationId: options.operationId, committedSha256: record.afterSha256, observedSha256: observed ?? null }, true);
}

async function writeRemoteTextAtomic(options: {
  host: string;
  remotePath: string;
  content: string;
  mode: TextWriteMode;
  expectedSha256?: string;
  preserveMetadata: boolean;
  operationId?: string;
  requestDigestOverride?: string;
  elevated: boolean;
  timeoutMs?: number;
  signal: AbortSignal;
}) {
  validateRemotePath(options.remotePath);
  const operationId = normalizeOperationId(options.operationId);
  const afterSha256 = sha256Text(options.content);
  const requestDigest = options.requestDigestOverride ?? sha256Text(JSON.stringify({ host: options.host, remotePath: options.remotePath, mode: options.mode, expectedSha256: options.expectedSha256 ?? null, afterSha256, preserveMetadata: options.preserveMetadata, elevated: options.elevated }));
  const replayed = await replayStoredTextOperation({ host: options.host, remotePath: options.remotePath, operationId, requestDigest, elevated: options.elevated, timeoutMs: options.timeoutMs });
  if (replayed) return replayed;
  const operationKey = `${options.host}\0${operationId}`;
  const previousRequest = textOperationRequests.get(operationKey);
  if (previousRequest && previousRequest !== requestDigest) {
    throw textOperatorError("operationId was already used for a different text mutation in this MCP instance.", "OPERATION_ID_REUSED", { host: options.host, remotePath: options.remotePath, operationId, requestDigest });
  }
  if (!previousRequest && textOperationRequests.size >= 1_000) {
    const oldestKey = textOperationRequests.keys().next().value as string | undefined;
    if (oldestKey) textOperationRequests.delete(oldestKey);
  }
  textOperationRequests.set(operationKey, requestDigest);
  const command = remoteAtomicWriteCommand({ path: options.remotePath, mode: options.mode, expectedSha256: options.expectedSha256, preserveMetadata: options.preserveMetadata, operationId, afterSha256 });
  const result = await runProcess({
    executable: sshExecutable(),
    args: [...baseSshArgs(options.host), options.elevated ? buildManagedSudoRemoteCommand(command) : buildManagedRemoteCommand(command)],
    stdin: options.content,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: 64 * 1024,
    signal: options.signal,
    expectRemotePid: true,
    stopRemote: (remotePid) => stopRemoteProcessGroup(options.host, remotePid),
  });
  const failure = classifyProcessFailure(result, "edit");
  if (failure) {
    const textFailure = classifyTextState(result.stdout, options.remotePath, options.expectedSha256);
    if (textFailure) throw textFailure;
    if (options.elevated) {
      const sudoMessage = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (/sudo:.*(?:password|authentication is required|terminal)/su.test(sudoMessage)) {
        throw new OperatorError("Non-interactive sudo authorization is required.", { errorCode: "SUDO_AUTH_REQUIRED", phase: "authorize", retryable: false });
      }
    }
    if (["SSH_TIMEOUT", "SSH_TRANSPORT_FAILED", "SSH_UNREACHABLE", "SSH_CONNECTION_REFUSED"].includes(failure.errorCode)) {
      const observed = await observeRemoteHash(options.host, options.remotePath, options.elevated, options.timeoutMs);
      if (observed === afterSha256) {
        const payload = { ok: true, host: options.host, remotePath: options.remotePath, operationId, requestDigest, state: "committed-after-reconcile", beforeSha256: options.expectedSha256 ?? "missing", afterSha256, observedSha256: observed, alreadyApplied: true, atomic: true, verified: true };
        textOperationStore.upsert({ operationId, host: options.host, remotePath: options.remotePath, requestDigest, afterSha256, completedAt: new Date().toISOString(), result: payload });
        return payload;
      }
      if (observed !== undefined && observed !== (options.expectedSha256 ?? "missing")) {
        throw textOperatorError("Remote commit result conflicts with both the expected and intended hashes.", "FILE_CHANGED_CONCURRENTLY", { remotePath: options.remotePath, expectedSha256: options.expectedSha256 ?? "missing", afterSha256, observedSha256: observed, operationId }, true);
      }
      if (observed === undefined) throw textOperatorError("The connection failed during commit and the remote result could not be reconciled.", "COMMIT_STATUS_UNKNOWN", { remotePath: options.remotePath, expectedSha256: options.expectedSha256 ?? "missing", afterSha256, operationId }, true);
    }
    throw new OperatorError(`Remote atomic text write failed: ${result.stderr || result.stdout}`, failure, { remotePath: options.remotePath, operationId, afterSha256 });
  }
  const resultLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("RESULT|"));
  if (!resultLine) throw textOperatorError("Remote write completed without a verifiable result envelope.", "COMMIT_STATUS_UNKNOWN", { remotePath: options.remotePath, operationId, afterSha256 }, true);
  const [, state, returnedOperation, beforeSha256, observedSha256] = resultLine.split("|");
  if (returnedOperation !== operationId || observedSha256 !== afterSha256) throw textOperatorError("Remote write result did not match the requested operation and hash.", "COMMIT_STATUS_UNKNOWN", { remotePath: options.remotePath, operationId, returnedOperation, afterSha256, observedSha256 }, true);
  const payload = {
    ok: true, host: options.host, remotePath: options.remotePath, operationId, requestDigest, state,
    beforeSha256, afterSha256, observedSha256,
    alreadyApplied: state === "already-applied", atomic: true, verified: true,
    bytesWritten: Buffer.byteLength(options.content, "utf8"), durationMs: result.durationMs,
  };
  textOperationStore.upsert({ operationId, host: options.host, remotePath: options.remotePath, requestDigest, afterSha256, completedAt: new Date().toISOString(), result: payload });
  return payload;
}

registerExecutionTools(server, stopRemoteProcessGroup);
registerWorkspaceTools(server, stopRemoteProcessGroup);

server.registerTool(
  "ssh_stat",
  {
    description: "Read remote Linux file metadata without modifying the path.",
    inputSchema: {
      host: commonFields.host,
      remotePath: z.string().min(1).describe("Absolute POSIX path"),
      followSymlinks: z.boolean().default(false),
      timeoutMs: commonFields.timeoutMs,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ host, remotePath, followSymlinks, timeoutMs }, extra) => {
    try {
      validateRemotePath(remotePath);
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedRemoteCommand(remoteStatCommand(remotePath, followSymlinks))],
        timeoutMs,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      const failure = classifyProcessFailure(result, "execute");
      if (failure) return resultContent(result, "execute");
      const payload = { ok: true, host, remotePath, followSymlinks, stat: parseRemoteStat(result.stdout), durationMs: result.durationMs };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "execute");
    }
  },
);

server.registerTool(
  "ssh_hash",
  {
    description: "Calculate the SHA-256 digest of one remote file.",
    inputSchema: { host: commonFields.host, remotePath: z.string().min(1).describe("Absolute POSIX file path"), timeoutMs: commonFields.timeoutMs },
    annotations: { readOnlyHint: true },
  },
  async ({ host, remotePath, timeoutMs }, extra) => {
    try {
      validateRemotePath(remotePath);
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedRemoteCommand(remoteHashCommand(remotePath))],
        timeoutMs,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      const failure = classifyProcessFailure(result, "execute");
      if (failure) return resultContent(result, "execute");
      const payload = { ok: true, host, remotePath, algorithm: "sha256", digest: parseSha256(result.stdout), durationMs: result.durationMs };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "execute");
    }
  },
);

server.registerTool(
  "ssh_read_text",
  {
    description: "Read a UTF-8 remote text file by line range with whole-file SHA-256 concurrency metadata. Refuses symlinks and binary data.",
    inputSchema: {
      host: commonFields.host,
      remotePath: z.string().min(1).describe("Absolute POSIX path to one remote text file"),
      startLine: z.number().int().min(1).default(1),
      maxLines: z.number().int().min(1).max(10_000).default(400),
      maxBytes: z.number().int().min(1024).max(1024 * 1024).default(256 * 1024),
      maxFileBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(5 * 1024 * 1024),
      timeoutMs: commonFields.timeoutMs,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ host, remotePath, startLine, maxLines, maxBytes, maxFileBytes, timeoutMs }, extra) => {
    try {
      const document = await readRemoteText(host, remotePath, maxFileBytes, timeoutMs, extra.signal);
      const page = paginateText(document.content, startLine, maxLines, maxBytes);
      const { content: _fullContent, ...metadata } = document;
      const payload = { ok: true, host, remotePath, ...metadata, ...page };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "edit");
    }
  },
);

server.registerTool(
  "ssh_write_text_atomic",
  {
    description: "Create or replace one UTF-8 remote text file using a directory lock, optimistic SHA-256 check, same-directory staging, atomic publication, and read-after-write verification.",
    inputSchema: {
      ...textOperationFields,
      content: z.string().max(5 * 1024 * 1024),
      mode: z.enum(["create", "replace"]),
      expectedSha256: sha256Schema.optional().describe("Required for replace; whole-file hash returned by ssh_read_text"),
      preserveMetadata: z.boolean().default(true),
    },
    annotations: { destructiveHint: true },
  },
  async ({ host, remotePath, content, mode, expectedSha256, preserveMetadata, operationId, timeoutMs }, extra) => {
    try {
      if (mode === "replace" && !expectedSha256) throw textOperatorError("expectedSha256 is required when mode=replace.", "VALIDATION_FAILED", { remotePath });
      if (mode === "create" && expectedSha256) throw textOperatorError("expectedSha256 must be omitted when mode=create.", "VALIDATION_FAILED", { remotePath });
      const payload = await writeRemoteTextAtomic({ host, remotePath, content, mode, expectedSha256, preserveMetadata, operationId, elevated: false, timeoutMs, signal: extra.signal });
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "edit");
    }
  },
);

const patchInputSchema = {
  ...textOperationFields,
  expectedSha256: sha256Schema,
  patch: z.string().min(1).max(5 * 1024 * 1024).describe("Unified diff for exactly the remotePath file; path headers are ignored"),
  dryRun: z.boolean().default(false),
  maxFileBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(5 * 1024 * 1024),
};

async function applyRemoteTextPatch(input: {
  host: string;
  remotePath: string;
  expectedSha256: string;
  patch: string;
  dryRun: boolean;
  maxFileBytes: number;
  operationId?: string;
  timeoutMs?: number;
}, signal: AbortSignal, elevated: boolean) {
  const operationId = normalizeOperationId(input.operationId);
  const requestDigest = sha256Text(JSON.stringify({ host: input.host, remotePath: input.remotePath, expectedSha256: input.expectedSha256, patch: input.patch, elevated }));
  if (!input.dryRun) {
    const replayed = await replayStoredTextOperation({ host: input.host, remotePath: input.remotePath, operationId, requestDigest, elevated, timeoutMs: input.timeoutMs });
    if (replayed) return replayed;
  }
  const document = await readRemoteText(input.host, input.remotePath, input.maxFileBytes, input.timeoutMs, signal, elevated);
  if (document.sha256 !== input.expectedSha256) {
    throw textOperatorError("Remote file changed since it was read; regenerate the patch from the current content.", "FILE_CHANGED_CONCURRENTLY", { remotePath: input.remotePath, expectedSha256: input.expectedSha256, actualSha256: document.sha256 }, true);
  }
  let applied;
  try {
    applied = applyUnifiedPatch(document.content, input.patch);
  } catch (error) {
    throw textOperatorError(error instanceof Error ? error.message : String(error), "PATCH_CONTEXT_MISMATCH", { remotePath: input.remotePath, expectedSha256: input.expectedSha256 });
  }
  const afterSha256 = sha256Text(applied.content);
  if (input.dryRun) {
    return { ok: true, host: input.host, remotePath: input.remotePath, operationId, requestDigest, state: "dry-run", beforeSha256: document.sha256, afterSha256, verified: false, dryRun: true, hunksApplied: applied.hunksApplied, linesAdded: applied.linesAdded, linesDeleted: applied.linesDeleted, resultingText: analyzeText(applied.content) };
  }
  const written = await writeRemoteTextAtomic({ host: input.host, remotePath: input.remotePath, content: applied.content, mode: "replace", expectedSha256: input.expectedSha256, preserveMetadata: true, operationId, requestDigestOverride: requestDigest, elevated, timeoutMs: input.timeoutMs, signal });
  return { ...written, dryRun: false, hunksApplied: applied.hunksApplied, linesAdded: applied.linesAdded, linesDeleted: applied.linesDeleted, resultingText: analyzeText(applied.content) };
}

server.registerTool(
  "ssh_apply_patch",
  {
    description: "Apply a single-file unified diff without a remote patch dependency, guarded by an expected whole-file hash and an atomic verified commit.",
    inputSchema: patchInputSchema,
    annotations: { destructiveHint: true },
  },
  async (input, extra) => {
    try {
      const payload = await applyRemoteTextPatch(input, extra.signal, false);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "edit");
    }
  },
);

server.registerTool(
  "ssh_sudo_apply_patch",
  {
    description: "Explicitly apply a single-file unified diff as root through sudo -n, with expected-hash concurrency protection and atomic verification. Never accepts a password.",
    inputSchema: patchInputSchema,
    annotations: { destructiveHint: true },
  },
  async (input, extra) => {
    try {
      const payload = await applyRemoteTextPatch(input, extra.signal, true);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "edit");
    }
  },
);

const transferFields = {
  host: commonFields.host,
  timeoutMs: commonFields.timeoutMs,
  maxOutputBytes: commonFields.maxOutputBytes,
  overwrite: z.boolean().default(false).describe("Allow replacing an existing destination"),
};

async function requireLocalFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Local path must be absolute.");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Local source must be a regular file.");
}

async function requireLocalParent(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Local path must be absolute.");
  const info = await stat(dirname(path));
  if (!info.isDirectory()) throw new Error("Local destination parent must be a directory.");
}

server.registerTool(
  "ssh_upload",
  {
    description: "Upload one local file over SCP/SFTP using the configured SSH host. Refuses overwrite by default.",
    inputSchema: {
      ...transferFields,
      localPath: z.string().min(1).describe("Absolute path to a local regular file"),
      remotePath: z.string().min(1).describe("Absolute POSIX destination path"),
    },
    annotations: { destructiveHint: true },
  },
  async ({ host, localPath, remotePath, overwrite, timeoutMs, maxOutputBytes }, extra) => {
    try {
      await requireLocalFile(localPath);
      validateRemotePath(remotePath);
      if (!overwrite) {
        const check = await runProcess({
          executable: sshExecutable(),
          args: [...baseSshArgs(host), `test ! -e ${shellQuote(remotePath)}`],
          timeoutMs,
          maxOutputBytes,
          signal: extra.signal,
        });
        if (check.exitCode !== 0) {
          throw new Error("Remote destination already exists or could not be checked; set overwrite=true to replace it.");
        }
      }
      const result = await runProcess({
        executable: scpExecutable(),
        args: [...baseOpenSshArgs(), "-B", localPath, remoteSpec(host, remotePath)],
        timeoutMs,
        maxOutputBytes,
        signal: extra.signal,
      });
      return resultContent(result, "transfer");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_upload_atomic",
  {
    description: "Upload one file to a same-directory temporary path, verify SHA-256, then publish it atomically. Refuses overwrite by default.",
    inputSchema: {
      ...transferFields,
      localPath: z.string().min(1).describe("Absolute path to a local regular file"),
      remotePath: z.string().min(1).describe("Absolute POSIX destination path"),
    },
    annotations: { destructiveHint: true },
  },
  async ({ host, localPath, remotePath, overwrite, timeoutMs, maxOutputBytes }, extra) => {
    let temporaryPath: string | undefined;
    try {
      await requireLocalFile(localPath);
      validateRemotePath(remotePath);
      const localHash = await sha256File(localPath);
      const localInfo = await stat(localPath);
      const remoteDirectory = posix.dirname(remotePath);
      temporaryPath = posix.join(remoteDirectory, `.${posix.basename(remotePath)}.ssh-operator-${randomUUID()}.tmp`);

      if (!overwrite) {
        const destinationCheck = await runProcess({ executable: sshExecutable(), args: [...baseSshArgs(host), `test ! -e ${shellQuote(remotePath)}`], timeoutMs, maxOutputBytes, signal: extra.signal });
        if (destinationCheck.exitCode !== 0) {
          const failure = destinationCheck.exitCode === 1
            ? { errorCode: "VALIDATION_FAILED" as const, phase: "validation" as const, retryable: false }
            : classifyProcessFailure(destinationCheck, "transfer") ?? { errorCode: "TRANSFER_FAILED" as const, phase: "transfer" as const, retryable: true };
          throw new OperatorError("Remote destination already exists or could not be checked; set overwrite=true to replace it.", failure);
        }
      }

      const upload = await runProcess({ executable: scpExecutable(), args: [...baseOpenSshArgs(), "-B", localPath, remoteSpec(host, temporaryPath)], timeoutMs, maxOutputBytes, signal: extra.signal });
      const uploadFailure = classifyProcessFailure(upload, "transfer");
      if (uploadFailure) throw new OperatorError(`Temporary upload failed: ${upload.stderr || upload.stdout}`, uploadFailure);

      const hashResult = await runProcess({ executable: sshExecutable(), args: [...baseSshArgs(host), remoteHashCommand(temporaryPath)], timeoutMs, maxOutputBytes, signal: extra.signal });
      const hashFailure = classifyProcessFailure(hashResult, "transfer");
      if (hashFailure) throw new OperatorError(`Remote hash verification failed: ${hashResult.stderr || hashResult.stdout}`, hashFailure);
      const remoteHash = parseSha256(hashResult.stdout);
      if (remoteHash !== localHash) throw new OperatorError(`SHA-256 mismatch: local=${localHash}, remote=${remoteHash}`, { errorCode: "TRANSFER_FAILED", phase: "transfer", retryable: true });

      const publishCommand = overwrite
        ? `mv -f -- ${shellQuote(temporaryPath)} ${shellQuote(remotePath)}`
        : `if ln -- ${shellQuote(temporaryPath)} ${shellQuote(remotePath)}; then if rm -f -- ${shellQuote(temporaryPath)}; then exit 0; fi; rm -f -- ${shellQuote(remotePath)}; exit 19; else status=$?; exit "$status"; fi`;
      const publish = await runProcess({ executable: sshExecutable(), args: [...baseSshArgs(host), publishCommand], timeoutMs, maxOutputBytes, signal: extra.signal });
      const publishFailure = classifyProcessFailure(publish, "transfer");
      if (publishFailure) throw new OperatorError(`Atomic publish failed: ${publish.stderr || publish.stdout}`, publishFailure);
      temporaryPath = undefined;
      const payload = { ok: true, host, localPath, remotePath, bytes: localInfo.size, algorithm: "sha256", digest: localHash, overwrite, atomic: true };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      if (temporaryPath) {
        const cleanup = await runProcess({ executable: sshExecutable(), args: [...baseSshArgs(host), `rm -f -- ${shellQuote(temporaryPath)}`], timeoutMs: Math.min(timeoutMs ?? 120_000, 15_000), maxOutputBytes });
        if (cleanup.exitCode !== 0) {
          const message = `${error instanceof Error ? error.message : String(error)}; temporary cleanup also failed: ${cleanup.stderr || cleanup.stdout}`;
          const details = error instanceof OperatorError ? error.details : { errorCode: "REMOTE_CLEANUP_FAILED" as const, phase: "cleanup" as const, retryable: true };
          return toolError(new OperatorError(message, details), "transfer");
        }
      }
      return toolError(error, "transfer");
    }
  },
);

server.registerTool(
  "ssh_download",
  {
    description: "Download one remote file over SCP/SFTP using the configured SSH host. Refuses overwrite by default.",
    inputSchema: {
      ...transferFields,
      remotePath: z.string().min(1).describe("Absolute POSIX path to a remote file"),
      localPath: z.string().min(1).describe("Absolute local destination path"),
    },
    annotations: { destructiveHint: true },
  },
  async ({ host, remotePath, localPath, overwrite, timeoutMs, maxOutputBytes }, extra) => {
    try {
      await requireLocalParent(localPath);
      validateRemotePath(remotePath);
      if (!overwrite) {
        try {
          await stat(localPath);
          throw new Error("Local destination already exists; set overwrite=true to replace it.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const result = await runProcess({
        executable: scpExecutable(),
        args: [...baseOpenSshArgs(), "-B", remoteSpec(host, remotePath), localPath],
        timeoutMs,
        maxOutputBytes,
        signal: extra.signal,
      });
      return resultContent(result, "transfer");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_start_process",
  {
    description: "Start a managed remote process over SSH and return immediately. Output is buffered for cursor-based reads.",
    inputSchema: {
      host: commonFields.host,
      cwd: commonFields.cwd,
      ...executionContextFields,
      command: z.string().min(1).describe("Long-running command interpreted by the remote login shell"),
      maxBufferBytes: z.number().int().min(64 * 1024).max(20 * 1024 * 1024).optional(),
      persistOutput: z.boolean().default(false).describe("Persist plaintext output locally for post-process pagination"),
      maxLogBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(100 * 1024 * 1024),
    },
  },
  async ({ host, cwd, command, shellMode, environment, maxBufferBytes, persistOutput, maxLogBytes }) => {
    try {
      const contextualized = shellMode === "default" && Object.keys(environment).length === 0
        ? command
        : contextualizeCommand(command, shellMode, environment);
      const processId = randomUUID();
      const token = randomUUID();
      const startedAt = new Date().toISOString();
      const logPath = persistOutput
        ? processLogStore.start({ processId, host, command, cwd, startedAt, maxBytes: maxLogBytes })
        : undefined;
      let summary;
      try {
        summary = processManager.start({
          executable: sshExecutable(),
          args: [...baseSshArgs(host), buildManagedRemoteCommand(contextualized, cwd, token)],
          host,
          command,
          cwd,
          maxBufferBytes,
          processId,
          expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid, token),
          onRemotePid: (remotePid) => activeProcessStore.upsert({
            processId,
            host,
            remotePid,
            token,
          startedAt,
          ownerPid: process.pid,
          detached: false,
          }),
          onOutput: persistOutput ? (chunk) => processLogStore.append(processId, chunk) : undefined,
          logPath,
          onExit: (exitCode, _signal, stopRequested, remoteExitCode) => {
            const transportLost = exitCode !== 0 && remoteExitCode === undefined && !stopRequested;
            if (transportLost) activeProcessStore.markDetached(processId);
            else activeProcessStore.remove(processId);
            if (persistOutput) processLogStore.finish(processId, transportLost ? "transport-lost" : undefined);
          },
        });
      } catch (error) {
        if (persistOutput) processLogStore.finish(processId, "start-failed");
        throw error;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ...summary, executionContext: executionContextSummary(shellMode, environment) }, null, 2) }],
        structuredContent: { ...summary, executionContext: executionContextSummary(shellMode, environment) },
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_list_processes",
  {
    description: "List managed SSH processes retained by this MCP server instance.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const processes = processManager.list();
    return {
      content: [{ type: "text", text: JSON.stringify({ processes }, null, 2) }],
      structuredContent: { processes },
    };
  },
);

server.registerTool(
  "ssh_read_process_output",
  {
    description: "Read buffered stdout and stderr chunks after a cursor and report current process status.",
    inputSchema: {
      processId: z.string().uuid(),
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ processId, cursor, limit }) => {
    try {
      const output = processManager.read(processId, cursor, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_stop_process",
  {
    description: "Stop a managed SSH process by terminating its tracked remote process group and SSH connection.",
    inputSchema: { processId: z.string().uuid() },
    annotations: { destructiveHint: true },
  },
  async ({ processId }) => {
    try {
      const summary = await processManager.stop(processId);
      const failure = summary.terminationError
        ? { errorCode: "REMOTE_CLEANUP_FAILED" as const, phase: "cleanup" as const, retryable: true }
        : undefined;
      const payload = { ...summary, ...(failure ?? {}) };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: summary.terminationError !== undefined,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_close_process",
  {
    description: "Forget a completed managed process and discard its buffered output.",
    inputSchema: { processId: z.string().uuid() },
    annotations: { destructiveHint: true },
  },
  async ({ processId }) => {
    try {
      processManager.close(processId);
      const payload = { ok: true, processId };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

process.once("SIGINT", async () => {
  await processManager.stopAll();
  process.exit(130);
});
process.once("SIGTERM", async () => {
  await processManager.stopAll();
  process.exit(143);
});

const transport = new StdioServerTransport();
await reconcileActiveProcesses(activeProcessStore.list());
await server.connect(transport);
