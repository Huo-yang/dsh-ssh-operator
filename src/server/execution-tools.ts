import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  baseSshArgs,
  buildManagedRemoteCommand,
  buildManagedScriptCommand,
  buildManagedSudoRemoteCommand,
  buildManagedSudoScriptCommand,
  shellQuote,
  sshExecutable,
} from "./commands.js";
import {
  compareEnvironmentSnapshots,
  contextualizeCommand,
  environmentProbeCommand,
  executionContextSummary,
  parseEnvironmentProbe,
  type EnvironmentOverrides,
  type ShellMode,
} from "./execution-context.js";
import { classifyProcessFailure } from "./errors.js";
import { runProcess, type ProcessResult, type RemoteTerminationResult } from "./process-runner.js";
import { errorResponse, jsonResponse, processResponse } from "./tool-response.js";
import { commonFields, executionContextFields } from "./tool-schemas.js";

type StopRemoteProcessGroup = (host: string, remotePid: number) => Promise<RemoteTerminationResult>;

function processResponseWithContext(result: ProcessResult, shellMode: ShellMode, environment: EnvironmentOverrides) {
  const base = processResponse(result, "execute");
  const payload = { ...base.structuredContent, executionContext: executionContextSummary(shellMode, environment) };
  return { ...jsonResponse(payload, base.isError), isError: base.isError };
}

function sudoProcessResponse(result: ProcessResult) {
  const base = processResponse(result, "execute");
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
  return { ...jsonResponse(payload, true), isError: true };
}

export function registerExecutionTools(server: McpServer, stopRemoteProcessGroup: StopRemoteProcessGroup) {
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
        return processResponse(result, "connect");
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "ssh_env_probe",
    {
      description: "Compare default and login-shell environment metadata without revealing proxy values. Interactive-shell probing is opt-in and may run startup-file side effects; no PTY is allocated.",
      inputSchema: {
        host: commonFields.host,
        includeInteractive: z.boolean().default(false),
        timeoutMs: commonFields.timeoutMs,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ host, includeInteractive, timeoutMs }, extra) => {
      try {
        const modes: ShellMode[] = includeInteractive ? ["default", "login", "interactive"] : ["default", "login"];
        const snapshots = [];
        for (const mode of modes) {
          const probe = environmentProbeCommand();
          const command = mode === "default" ? probe : contextualizeCommand(probe, mode, {});
          const result = await runProcess({
            executable: sshExecutable(),
            args: [...baseSshArgs(host), buildManagedRemoteCommand(command)],
            timeoutMs,
            signal: extra.signal,
            expectRemotePid: true,
            stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
          });
          if (classifyProcessFailure(result, "execute")) return processResponse(result, "execute");
          snapshots.push(parseEnvironmentProbe(mode, result.stdout, result.stderr));
        }
        return jsonResponse({ ok: true, host, snapshots, comparisons: compareEnvironmentSnapshots(snapshots) });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "ssh_exec",
    {
      description: "Execute one remote shell command through system OpenSSH without invoking a local shell.",
      inputSchema: { ...commonFields, ...executionContextFields, command: z.string().min(1).describe("Command interpreted only by the remote login shell") },
    },
    async ({ host, cwd, command, shellMode, environment, timeoutMs, maxOutputBytes }, extra) => {
      try {
        const contextualized = shellMode === "default" && Object.keys(environment).length === 0
          ? command
          : contextualizeCommand(command, shellMode, environment);
        const result = await runProcess({
          executable: sshExecutable(),
          args: [...baseSshArgs(host), buildManagedRemoteCommand(contextualized, cwd)],
          timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        return processResponseWithContext(result, shellMode, environment);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.registerTool(
    "ssh_run_script",
    {
      description: "Send a Bash or POSIX shell script over SSH stdin so it never enters the Windows command line.",
      inputSchema: {
        ...commonFields,
        ...executionContextFields,
        interpreter: z.enum(["bash", "sh"]).default("bash"),
        script: z.string().min(1),
        args: z.array(z.string()).max(100).default([]),
      },
    },
    async ({ host, cwd, interpreter, script, args, shellMode, environment, timeoutMs, maxOutputBytes }, extra) => {
      try {
        const defaultContext = shellMode === "default" && Object.keys(environment).length === 0;
        const invocation = `${interpreter} -s --${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
        const remoteCommand = defaultContext
          ? buildManagedScriptCommand(interpreter, args, cwd)
          : buildManagedRemoteCommand(contextualizeCommand(invocation, shellMode, environment), cwd);
        const result = await runProcess({
          executable: sshExecutable(), args: [...baseSshArgs(host), remoteCommand], stdin: script,
          timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        return processResponseWithContext(result, shellMode, environment);
      } catch (error) {
        return errorResponse(error);
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
          executable: sshExecutable(), args: [...baseSshArgs(host), buildManagedScriptCommand("sh", [])], stdin: script,
          timeoutMs, signal: extra.signal, expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        if (classifyProcessFailure(result, "execute")) return processResponse(result, "execute");
        const state = /^state=(.+)$/mu.exec(result.stdout)?.[1] ?? "unknown";
        return jsonResponse({
          ok: true, host, state,
          alreadyRoot: state === "already-root",
          nonInteractive: state === "already-root" || state === "available",
          requiresAuthentication: state === "authentication-required",
          policyDenied: state === "policy-denied",
          durationMs: result.durationMs,
        });
      } catch (error) {
        return errorResponse(error, "execute");
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
          executable: sshExecutable(), args: [...baseSshArgs(host), buildManagedSudoRemoteCommand(command, cwd)],
          timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        return sudoProcessResponse(result);
      } catch (error) {
        return errorResponse(error, "execute");
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
          executable: sshExecutable(), args: [...baseSshArgs(host), buildManagedSudoScriptCommand(interpreter, args, cwd)],
          stdin: script, timeoutMs, maxOutputBytes, signal: extra.signal, expectRemotePid: true,
          stopRemote: (remotePid) => stopRemoteProcessGroup(host, remotePid),
        });
        return sudoProcessResponse(result);
      } catch (error) {
        return errorResponse(error, "execute");
      }
    },
  );
}
