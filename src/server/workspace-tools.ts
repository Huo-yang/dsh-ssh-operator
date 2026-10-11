import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baseSshArgs, buildManagedRemoteCommand, buildManagedScriptCommand, shellQuote, sshExecutable } from "./commands.js";
import { contextualizeCommand, executionContextSummary } from "./execution-context.js";
import type { ErrorDetails } from "./errors.js";
import { classifyProcessFailure } from "./errors.js";
import { runProcess, type ProcessResult, type RemoteTerminationResult } from "./process-runner.js";
import { errorResponse, jsonResponse, processResponse } from "./tool-response.js";
import { commonFields, executionContextFields } from "./tool-schemas.js";
import {
  parseSearchOutput,
  parseTreeOutput,
  SEARCH_SCRIPT,
  searchScriptArgs,
  TREE_SCRIPT,
  treeScriptArgs,
} from "./workspace-discovery.js";

type StopRemoteProcessGroup = (host: string, remotePid: number) => Promise<RemoteTerminationResult>;

function workspaceProcessResponse(result: ProcessResult) {
  const base = processResponse(result, "execute");
  const workspaceFailure: ErrorDetails | undefined = result.remoteExitCode === 20
    ? { errorCode: "WORKSPACE_ROOT_INVALID", phase: "validation", retryable: false }
    : result.remoteExitCode === 21
      ? { errorCode: "REMOTE_CAPABILITY_UNAVAILABLE", phase: "execute", retryable: false }
      : undefined;
  if (!workspaceFailure) return base;
  const payload = { ...base.structuredContent, ...workspaceFailure };
  return { ...jsonResponse(payload, true), isError: true };
}

export function registerWorkspaceTools(server: McpServer, stopRemoteProcessGroup: StopRemoteProcessGroup) {
  server.registerTool(
    "ssh_list_tree",
    {
      description: "List a bounded, paginated remote directory tree with structured metadata. Symlinks are reported but never followed.",
      inputSchema: {
        host: commonFields.host,
        root: z.string().min(1).describe("Absolute POSIX directory used as the workspace root"),
        maxDepth: z.number().int().min(0).max(20).default(4),
        cursor: z.number().int().min(0).max(10_000_000).default(0).describe("Entry offset returned by the previous page"),
        limit: z.number().int().min(1).max(500).default(200),
        excludeNames: z.array(z.string()).max(32).default([]).describe("Directory base names to prune, such as .git or node_modules"),
        timeoutMs: commonFields.timeoutMs,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ host, root, maxDepth, cursor, limit, excludeNames, timeoutMs }, extra) => {
      try {
        const result = await runProcess({
          executable: sshExecutable(),
          args: [...baseSshArgs(host), buildManagedScriptCommand("bash", treeScriptArgs(root, maxDepth, cursor, limit, excludeNames))],
          stdin: TREE_SCRIPT,
          timeoutMs,
          maxOutputBytes: 4 * 1024 * 1024,
          signal: extra.signal,
          expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        if (classifyProcessFailure(result, "execute")) return workspaceProcessResponse(result);
        const records = parseTreeOutput(result.stdout);
        const hasMore = records.length > limit;
        const entries = records.slice(0, limit);
        return jsonResponse({
          ok: true, host, root, maxDepth, cursor,
          nextCursor: hasMore ? cursor + entries.length : null,
          hasMore, entries,
          warnings: result.stderr || undefined,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "ssh_search_text",
    {
      description: "Search remote text with ripgrep and return bounded, paginated structured matches. Does not follow symlinks or return unbounded command output.",
      inputSchema: {
        host: commonFields.host,
        ...executionContextFields,
        root: z.string().min(1).describe("Absolute POSIX directory to search"),
        query: z.string().min(1).describe("Literal text by default, or a ripgrep regular expression when fixedStrings is false"),
        fixedStrings: z.boolean().default(true),
        globs: z.array(z.string()).max(32).default([]).describe("Optional ripgrep include or exclude globs"),
        includeHidden: z.boolean().default(false),
        maxFileBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
        maxColumns: z.number().int().min(80).max(4000).default(1000),
        cursor: z.number().int().min(0).max(10_000_000).default(0).describe("Match offset returned by the previous page"),
        limit: z.number().int().min(1).max(500).default(100),
        timeoutMs: commonFields.timeoutMs,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ host, root, query, shellMode, environment, fixedStrings, globs, includeHidden, maxFileBytes, maxColumns, cursor, limit, timeoutMs }, extra) => {
      try {
        const args = searchScriptArgs({ root, query, cursor, limit, maxFileSize: String(maxFileBytes), maxColumns, fixedStrings, includeHidden, globs });
        const defaultContext = shellMode === "default" && Object.keys(environment).length === 0;
        const invocation = `bash -s -- ${args.map(shellQuote).join(" ")}`;
        const remoteCommand = defaultContext
          ? buildManagedScriptCommand("bash", args)
          : buildManagedRemoteCommand(contextualizeCommand(invocation, shellMode, environment));
        const result = await runProcess({
          executable: sshExecutable(),
          args: [...baseSshArgs(host), remoteCommand],
          stdin: SEARCH_SCRIPT,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          signal: extra.signal,
          expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        if (classifyProcessFailure(result, "execute")) return workspaceProcessResponse(result);
        const records = parseSearchOutput(result.stdout);
        const hasMore = records.length > limit;
        const matches = records.slice(0, limit);
        return jsonResponse({
          ok: true, host, root, backend: "ripgrep", fixedStrings, cursor,
          nextCursor: hasMore ? cursor + matches.length : null,
          hasMore, matches,
          warnings: result.stderr || undefined,
          executionContext: executionContextSummary(shellMode, environment),
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
