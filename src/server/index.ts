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
  buildManagedScriptCommand,
  buildManagedSudoRemoteCommand,
  buildManagedSudoScriptCommand,
  defaultSshConfigPath,
  remoteSpec,
  scpExecutable,
  shellQuote,
  sshExecutable,
  validateRemotePath,
} from "./commands.js";
import { runProcess, type ProcessResult, type RemoteTerminationResult } from "./process-runner.js";
import { ProcessManager } from "./process-manager.js";
import { listConcreteHosts } from "./ssh-config.js";
import { ActiveProcessStore, type ActiveProcessRecord } from "./active-process-store.js";
import { ProcessLogStore } from "./process-log-store.js";
import { classifyProcessFailure, classifyThrownError, OperatorError, type ErrorPhase } from "./errors.js";
import { runDoctor } from "./doctor.js";
import { parseRemoteStat, parseSha256, remoteHashCommand, remoteStatCommand, sha256File } from "./file-operations.js";

const server = new McpServer({ name: "ssh-operator-mcp", version: "0.15.0" });
const processManager = new ProcessManager();
const activeProcessStore = new ActiveProcessStore();
const processLogStore = new ProcessLogStore();

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

function resultContent(result: ProcessResult, phase: ErrorPhase) {
  const failure = classifyProcessFailure(result, phase);
  const payload = {
    ok: failure === undefined,
    ...result,
    ...(failure ?? {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: !payload.ok,
  };
}

function sudoResultContent(result: ProcessResult) {
  const base = resultContent(result, "execute");
  if (!base.isError) return base;
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const sudoFailure = !message.includes("sudo:") ? undefined
    : /password|authentication is required|a terminal is required/u.test(message)
      ? { errorCode: "SUDO_AUTH_REQUIRED" as const, phase: "authorize" as const, retryable: false }
      : /not allowed|not in the sudoers|may not run sudo/u.test(message)
        ? { errorCode: "SUDO_POLICY_DENIED" as const, phase: "authorize" as const, retryable: false }
        : undefined;
  if (!sudoFailure) return base;
  const payload = { ...base.structuredContent, ...sudoFailure };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

function toolError(error: unknown, phase: ErrorPhase = "internal") {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error), ...classifyThrownError(error, phase) };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: true,
  };
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
    inputSchema: { host: z.string().optional(), timeoutMs: z.number().int().min(1000).max(3_600_000).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ host, timeoutMs }) => {
    try {
      const payload = await runDoctor(activeProcessStore, processLogStore, host, timeoutMs);
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

const commonFields = {
  host: z.string().describe("A concrete Host alias from the local OpenSSH config"),
  cwd: z.string().optional().describe("Absolute working directory on the remote host"),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxOutputBytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional(),
};

server.registerTool(
  "ssh_probe",
  {
    description: "Verify a configured SSH host and report its user, hostname, shell, and working directory.",
    inputSchema: { host: commonFields.host, timeoutMs: commonFields.timeoutMs },
    annotations: { readOnlyHint: true },
  },
  async ({ host, timeoutMs }, extra) => {
    try {
      const command = "printf 'user=%s\\nhost=%s\\nshell=%s\\npwd=%s\\n' \"$(id -un)\" \"$(hostname)\" \"${SHELL:-}\" \"$(pwd)\"";
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedRemoteCommand(command)],
        timeoutMs,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      return resultContent(result, "connect");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_exec",
  {
    description: "Execute one remote shell command through system OpenSSH without invoking a local shell.",
    inputSchema: {
      ...commonFields,
      command: z.string().min(1).describe("Command interpreted only by the remote login shell"),
    },
  },
  async ({ host, cwd, command, timeoutMs, maxOutputBytes }, extra) => {
    try {
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedRemoteCommand(command, cwd)],
        timeoutMs,
        maxOutputBytes,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      return resultContent(result, "execute");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_run_script",
  {
    description: "Send a Bash or POSIX shell script over SSH stdin so it never enters the Windows command line.",
    inputSchema: {
      ...commonFields,
      interpreter: z.enum(["bash", "sh"]).default("bash"),
      script: z.string().min(1),
      args: z.array(z.string()).max(100).default([]),
    },
  },
  async ({ host, cwd, interpreter, script, args, timeoutMs, maxOutputBytes }, extra) => {
    try {
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedScriptCommand(interpreter, args, cwd)],
        stdin: script,
        timeoutMs,
        maxOutputBytes,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      return resultContent(result, "execute");
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "ssh_sudo_probe",
  {
    description: "Passively test whether a host is already root or permits passwordless non-interactive sudo. No password is accepted or requested.",
    inputSchema: { host: commonFields.host, timeoutMs: commonFields.timeoutMs },
    annotations: { readOnlyHint: true },
  },
  async ({ host, timeoutMs }, extra) => {
    try {
      const script = [
        "if [ \"$(id -u)\" -eq 0 ]; then printf 'state=already-root\\n'; exit 0; fi",
        "if ! command -v sudo >/dev/null 2>&1; then printf 'state=sudo-not-found\\n'; exit 0; fi",
        "sudo_error=$(mktemp 2>/dev/null || printf '/tmp/ssh-operator-sudo-$$')",
        "if sudo -n true 2>\"$sudo_error\"; then printf 'state=available\\n'; rm -f -- \"$sudo_error\"; exit 0; fi",
        "message=$(cat -- \"$sudo_error\" 2>/dev/null); rm -f -- \"$sudo_error\"",
        "case \"$message\" in *password*|*authentication*|*terminal*) state=authentication-required ;; *not\\ allowed*|*sudoers*) state=policy-denied ;; *) state=unavailable ;; esac",
        "printf 'state=%s\\n' \"$state\"",
      ].join("\n");
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedScriptCommand("sh", [])],
        stdin: script,
        timeoutMs,
        signal: extra.signal,
        expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      const failure = classifyProcessFailure(result, "execute");
      if (failure) return resultContent(result, "execute");
      const state = /^state=(.+)$/mu.exec(result.stdout)?.[1] ?? "unknown";
      const payload = {
        ok: true, host, state,
        alreadyRoot: state === "already-root",
        nonInteractive: state === "already-root" || state === "available",
        requiresAuthentication: state === "authentication-required",
        policyDenied: state === "policy-denied",
        durationMs: result.durationMs,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    } catch (error) {
      return toolError(error, "execute");
    }
  },
);

server.registerTool(
  "ssh_sudo_exec",
  {
    description: "Explicitly execute one remote command as root through passwordless non-interactive sudo. Never accepts a password.",
    inputSchema: { ...commonFields, command: z.string().min(1).describe("Command interpreted by a root POSIX shell") },
    annotations: { destructiveHint: true },
  },
  async ({ host, cwd, command, timeoutMs, maxOutputBytes }, extra) => {
    try {
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedSudoRemoteCommand(command, cwd)],
        timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      return sudoResultContent(result);
    } catch (error) {
      return toolError(error, "execute");
    }
  },
);

server.registerTool(
  "ssh_sudo_run_script",
  {
    description: "Explicitly send a Bash or POSIX shell script over stdin and run it as root through passwordless non-interactive sudo. Never accepts a password.",
    inputSchema: {
      ...commonFields,
      interpreter: z.enum(["bash", "sh"]).default("bash"),
      script: z.string().min(1),
      args: z.array(z.string()).max(100).default([]),
    },
    annotations: { destructiveHint: true },
  },
  async ({ host, cwd, interpreter, script, args, timeoutMs, maxOutputBytes }, extra) => {
    try {
      const result = await runProcess({
        executable: sshExecutable(),
        args: [...baseSshArgs(host), buildManagedSudoScriptCommand(interpreter, args, cwd)],
        stdin: script, timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
        stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
      });
      return sudoResultContent(result);
    } catch (error) {
      return toolError(error, "execute");
    }
  },
);

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
      command: z.string().min(1).describe("Long-running command interpreted by the remote login shell"),
      maxBufferBytes: z.number().int().min(64 * 1024).max(20 * 1024 * 1024).optional(),
      persistOutput: z.boolean().default(false).describe("Persist plaintext output locally for post-process pagination"),
      maxLogBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(100 * 1024 * 1024),
    },
  },
  async ({ host, cwd, command, maxBufferBytes, persistOutput, maxLogBytes }) => {
    try {
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
          args: [...baseSshArgs(host), buildManagedRemoteCommand(command, cwd, token)],
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
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
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
