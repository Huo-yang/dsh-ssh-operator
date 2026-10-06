import { homedir } from "node:os";
import { join } from "node:path";

const HOST_ALIAS = /^[A-Za-z0-9._-]+$/;
export const REMOTE_PID_MARKER = "SSH_OPERATOR_PID=";
export const REMOTE_EXIT_MARKER = "SSH_OPERATOR_EXIT=";
export const CONTROL_START = 0x1e;
export const CONTROL_END = 0x1f;

export function validateHostAlias(host: string): string {
  if (!HOST_ALIAS.test(host)) {
    throw new Error(
      "Host must be an SSH config alias containing only letters, digits, dot, underscore, or hyphen.",
    );
  }
  return host;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteCommand(command: string, cwd?: string): string {
  if (command.includes("\0")) {
    throw new Error("Command must not contain NUL bytes.");
  }
  if (!cwd) return command;
  return `cd -- ${shellQuote(cwd)} && ${command}`;
}

export function buildManagedRemoteCommand(command: string, cwd?: string, token?: string): string {
  const identity = token ? `export SSH_OPERATOR_PROCESS_TOKEN=${shellQuote(token)}; ` : "";
  const managed = `${identity}printf '\\036${REMOTE_PID_MARKER}%s\\037' "$$" >&2; (\n${command}\n); ssh_operator_status=$?; printf '\\036${REMOTE_EXIT_MARKER}%s\\037' "$ssh_operator_status" >&2; exit "$ssh_operator_status"`;
  return buildRemoteCommand(cwd ? `{ ${managed}; }` : managed, cwd);
}

export function buildManagedSudoRemoteCommand(command: string, cwd?: string): string {
  if (command.includes("\0")) throw new Error("Command must not contain NUL bytes.");
  return buildManagedRemoteCommand(`sudo -n -- sh -c ${shellQuote(command)}`, cwd);
}

export function buildScriptCommand(
  interpreter: "bash" | "sh",
  args: string[],
  cwd?: string,
): string {
  const invocation = `exec ${interpreter} -s --${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
  return cwd ? `cd -- ${shellQuote(cwd)} && ${invocation}` : invocation;
}

export function buildManagedScriptCommand(
  interpreter: "bash" | "sh",
  args: string[],
  cwd?: string,
): string {
  const invocation = `${interpreter} -s --${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
  const managed = `printf '\\036${REMOTE_PID_MARKER}%s\\037' "$$" >&2; ${invocation}; ssh_operator_status=$?; printf '\\036${REMOTE_EXIT_MARKER}%s\\037' "$ssh_operator_status" >&2; exit "$ssh_operator_status"`;
  return cwd ? `cd -- ${shellQuote(cwd)} && { ${managed}; }` : managed;
}

export function buildManagedSudoScriptCommand(
  interpreter: "bash" | "sh",
  args: string[],
  cwd?: string,
): string {
  const invocation = `sudo -n -- ${interpreter} -s --${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
  const managed = `printf '\\036${REMOTE_PID_MARKER}%s\\037' "$$" >&2; ${invocation}; ssh_operator_status=$?; printf '\\036${REMOTE_EXIT_MARKER}%s\\037' "$ssh_operator_status" >&2; exit "$ssh_operator_status"`;
  return cwd ? `cd -- ${shellQuote(cwd)} && { ${managed}; }` : managed;
}

export function defaultSshConfigPath(): string {
  return process.env.SSH_OPERATOR_SSH_CONFIG ?? join(homedir(), ".ssh", "config");
}

export function sshExecutable(): string {
  return process.env.SSH_OPERATOR_SSH_PATH ?? "ssh";
}

export function scpExecutable(): string {
  return process.env.SSH_OPERATOR_SCP_PATH ?? "scp";
}

export function baseOpenSshArgs(connectTimeoutSeconds = 10): string[] {
  const args = process.env.SSH_OPERATOR_DEBUG === "1" ? ["-vv"] : [];
  args.push(
    "-F",
    defaultSshConfigPath(),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
  );
  return args;
}

export function baseSshArgs(host: string, connectTimeoutSeconds = 10): string[] {
  const args = baseOpenSshArgs(connectTimeoutSeconds);
  args.push(validateHostAlias(host));
  return args;
}

export function validateRemotePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || /[\r\n]/u.test(path)) {
    throw new Error("Remote path must be an absolute POSIX path without NUL or line breaks.");
  }
  return path;
}

export function remoteSpec(host: string, path: string): string {
  return `${validateHostAlias(host)}:${validateRemotePath(path)}`;
}
