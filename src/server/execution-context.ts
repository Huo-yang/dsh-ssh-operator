import { createHash } from "node:crypto";
import { shellQuote } from "./commands.js";

export type ShellMode = "default" | "login" | "interactive";
export type EnvironmentOverrides = Record<string, string | null>;

export function executionContextSummary(shellMode: ShellMode, environment: EnvironmentOverrides) {
  return {
    shellMode,
    environmentSet: Object.entries(environment).filter(([, value]) => value !== null).map(([name]) => name).sort(),
    environmentUnset: Object.entries(environment).filter(([, value]) => value === null).map(([name]) => name).sort(),
  };
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function validateEnvironmentOverrides(environment: EnvironmentOverrides): EnvironmentOverrides {
  const entries = Object.entries(environment);
  if (entries.length > 64) throw new Error("Environment overrides must contain at most 64 variables.");
  for (const [name, value] of entries) {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}.`);
    if (value !== null && value.includes("\0")) throw new Error(`Environment variable ${name} must not contain NUL bytes.`);
  }
  return environment;
}

export function environmentStatements(environment: EnvironmentOverrides): string {
  validateEnvironmentOverrides(environment);
  return Object.entries(environment).map(([name, value]) => value === null
    ? `unset ${name}`
    : `export ${name}=${shellQuote(value)}`).join("; ");
}

export function contextualizeCommand(command: string, shellMode: ShellMode, environment: EnvironmentOverrides): string {
  if (command.includes("\0")) throw new Error("Command must not contain NUL bytes.");
  const prefix = environmentStatements(environment);
  const body = prefix ? `${prefix}; ${command}` : command;
  if (shellMode === "default") return body;
  const flag = shellMode === "login" ? "-lc" : "-ic";
  return `ssh_operator_shell="\${SHELL:-/bin/sh}"; if [ ! -x "$ssh_operator_shell" ]; then ssh_operator_shell=/bin/sh; fi; "$ssh_operator_shell" ${flag} ${shellQuote(body)}`;
}

export const ENV_PROBE_START = "SSH_OPERATOR_ENV_BEGIN";
export const ENV_PROBE_END = "SSH_OPERATOR_ENV_END";

const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

export function environmentProbeCommand(): string {
  const initFiles = [".profile", ".bash_profile", ".bash_login", ".bashrc", ".zprofile", ".zshrc"];
  return [
    `printf '\\036${ENV_PROBE_START}\\037\\n'`,
    `printf 'identity.user|'; id -un | tr -d '\\n' | base64 -w 0; printf '\\n'`,
    `printf 'identity.shell|'; printf '%s' "\${SHELL:-}" | base64 -w 0; printf '\\n'`,
    `printf 'identity.cwd|'; pwd | tr -d '\\n' | base64 -w 0; printf '\\n'`,
    `printf 'environment.path|'; printf '%s' "\${PATH:-}" | base64 -w 0; printf '\\n'`,
    ...PROXY_NAMES.map((name) => `printf 'environment.${name}|'; if [ "\${${name}+x}" = x ]; then printf 'set:'; printf '%s' "\${${name}}" | base64 -w 0; else printf 'unset:'; fi; printf '\\n'`),
    ...initFiles.map((name) => `if [ -e "$HOME/${name}" ]; then readable=false; [ -r "$HOME/${name}" ] && readable=true; printf 'init.${name}|present:%s\\n' "$readable"; else printf 'init.${name}|absent\\n'; fi`),
    `printf '\\036${ENV_PROBE_END}\\037\\n'`,
  ].join("; ");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface EnvironmentSnapshot extends Record<string, unknown> {
  mode: ShellMode;
  identity: { user: string; shell: string; cwd: string };
  path: { value: string; entries: string[]; fingerprint: string };
  proxy: Record<string, { present: boolean; length: number; fingerprint: string | null }>;
  initFiles: Record<string, { present: boolean; readable: boolean }>;
  startupNoise: { stdoutBytes: number; stdoutFingerprint: string | null; stderrBytes: number; stderrFingerprint: string | null };
}

export function parseEnvironmentProbe(mode: ShellMode, stdout: string, stderr: string): EnvironmentSnapshot {
  const startMarker = `\x1e${ENV_PROBE_START}\x1f\n`;
  const endMarker = `\x1e${ENV_PROBE_END}\x1f\n`;
  const start = stdout.indexOf(startMarker);
  const end = stdout.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Environment probe markers were not found for shell mode ${mode}.`);
  const before = stdout.slice(0, start);
  const after = stdout.slice(end + endMarker.length);
  const values: Record<string, string> = {};
  for (const line of stdout.slice(start + startMarker.length, end).split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf("|");
    if (separator < 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const decode = (key: string) => Buffer.from(values[key] ?? "", "base64").toString("utf8");
  const path = decode("environment.path");
  const proxy = Object.fromEntries(PROXY_NAMES.map((name) => {
    const encoded = values[`environment.${name}`] ?? "unset:";
    const present = encoded.startsWith("set:");
    const value = present ? Buffer.from(encoded.slice(4), "base64").toString("utf8") : "";
    return [name, { present, length: value.length, fingerprint: present ? fingerprint(value) : null }];
  }));
  const initFiles = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("init.")).map(([key, value]) => [key.slice(5), { present: value.startsWith("present:"), readable: value === "present:true" }]));
  const noise = `${before}${after}`;
  return {
    mode,
    identity: { user: decode("identity.user"), shell: decode("identity.shell"), cwd: decode("identity.cwd") },
    path: { value: path, entries: path ? path.split(":") : [], fingerprint: fingerprint(path) },
    proxy,
    initFiles,
    startupNoise: {
      stdoutBytes: Buffer.byteLength(noise), stdoutFingerprint: noise ? fingerprint(noise) : null,
      stderrBytes: Buffer.byteLength(stderr), stderrFingerprint: stderr ? fingerprint(stderr) : null,
    },
  };
}

export function compareEnvironmentSnapshots(snapshots: EnvironmentSnapshot[]) {
  if (snapshots.length < 2) return [];
  const baseline = snapshots[0];
  return snapshots.slice(1).map((snapshot) => ({
    from: baseline.mode,
    to: snapshot.mode,
    pathChanged: baseline.path.fingerprint !== snapshot.path.fingerprint,
    proxyChanged: Object.fromEntries(PROXY_NAMES.map((name) => [name, baseline.proxy[name]?.fingerprint !== snapshot.proxy[name]?.fingerprint])),
    cwdChanged: baseline.identity.cwd !== snapshot.identity.cwd,
    startupNoisePresent: snapshot.startupNoise.stdoutBytes > 0 || snapshot.startupNoise.stderrBytes > 0,
  }));
}
