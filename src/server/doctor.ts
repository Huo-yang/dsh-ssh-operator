import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { runProcess } from "./process-runner.js";
import { baseSshArgs, defaultSshConfigPath, sshExecutable } from "./commands.js";
import { listConcreteHosts } from "./ssh-config.js";
import type { ActiveProcessStore } from "./active-process-store.js";
import type { ProcessLogStore } from "./process-log-store.js";

const VERSION = "0.15.0";

async function pathCheck(path: string, mode: number): Promise<{ path: string; exists: boolean; accessible: boolean; error?: string }> {
  try {
    await access(path, mode);
    return { path, exists: true, accessible: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { path, exists: code !== "ENOENT", accessible: false, error: code ?? String(error) };
  }
}

async function writableLocation(path: string) {
  try {
    const info = await stat(path);
    return pathCheck(info.isDirectory() ? path : dirname(path), constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return pathCheck(path, constants.W_OK);
    return pathCheck(dirname(path), constants.W_OK);
  }
}

export async function runDoctor(activeStore: ActiveProcessStore, logStore: ProcessLogStore, host?: string, timeoutMs?: number) {
  const configPath = defaultSshConfigPath();
  const sshVersion = await runProcess({ executable: sshExecutable(), args: ["-V"], timeoutMs: 5_000 });
  const sshConfig = { ...(await pathCheck(configPath, constants.R_OK)), hosts: await listConcreteHosts(configPath) };
  const stateLocation = await writableLocation(activeStore.path);
  const logLocation = await writableLocation(logStore.directory);
  const programData = process.env.PROGRAMDATA ?? null;
  const local = {
    ok: sshVersion.exitCode === 0 && sshConfig.accessible && stateLocation.accessible && logLocation.accessible && (process.platform !== "win32" || programData !== null),
    packageVersion: VERSION,
    node: { version: process.version, platform: process.platform, arch: process.arch },
    ssh: { executable: sshExecutable(), ok: sshVersion.exitCode === 0, version: (sshVersion.stderr || sshVersion.stdout).trim() },
    programData,
    sshConfig,
    state: { path: activeStore.path, location: stateLocation, recoveryRecordCount: activeStore.list().length, storageDiagnostics: activeStore.diagnostics() },
    logs: { directory: logStore.directory, location: logLocation, persistedLogCount: logStore.list().length, storageDiagnostics: logStore.diagnostics() },
  };
  if (!host) return { ok: local.ok, local };

  const script = [
    "printf 'user=%s\\n' \"$(id -un)\"", "printf 'hostname=%s\\n' \"$(hostname)\"",
    "printf 'shell=%s\\n' \"${SHELL:-}\"", "printf 'pwd=%s\\n' \"$(pwd)\"",
    "printf 'os=%s\\n' \"$(uname -s)\"", "printf 'arch=%s\\n' \"$(uname -m)\"",
    "if [ -r /proc/$$/cmdline ]; then printf 'procCmdline=true\\n'; else printf 'procCmdline=false\\n'; fi",
    "if kill -0 -- -$$ 2>/dev/null; then printf 'processGroupSignals=true\\n'; else printf 'processGroupSignals=false\\n'; fi",
    "if [ -n \"${TMPDIR:-}\" ] && [ -d \"$TMPDIR\" ] && [ -w \"$TMPDIR\" ]; then tmp=$TMPDIR; elif [ -d /tmp ] && [ -w /tmp ]; then tmp=/tmp; else tmp=; fi",
    "printf 'tempDirectory=%s\\n' \"$tmp\"",
    "for tool in bash sh tar rsync sha256sum systemctl docker podman; do if command -v \"$tool\" >/dev/null 2>&1; then printf 'tool.%s=true\\n' \"$tool\"; else printf 'tool.%s=false\\n' \"$tool\"; fi; done",
    "if [ \"$(id -u)\" -eq 0 ]; then printf 'sudo.state=already-root\\n'; elif ! command -v sudo >/dev/null 2>&1; then printf 'sudo.state=sudo-not-found\\n'; elif sudo -n true >/dev/null 2>&1; then printf 'sudo.state=available\\n'; else printf 'sudo.state=authentication-or-policy-required\\n'; fi",
  ].join("; ");
  const result = await runProcess({ executable: sshExecutable(), args: [...baseSshArgs(host), script], timeoutMs });
  const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const index = line.indexOf("="); return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const tools = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("tool.")).map(([key, value]) => [key.slice(5), value === "true"]));
  const sudoState = values["sudo.state"] ?? "unknown";
  const remote = { host, connected: result.exitCode === 0 && !result.timedOut && !result.aborted, result, identity: { user: values.user, hostname: values.hostname, shell: values.shell, pwd: values.pwd }, system: { os: values.os, arch: values.arch }, capabilities: { procCmdline: values.procCmdline === "true", processGroupSignals: values.processGroupSignals === "true", tempDirectory: values.tempDirectory || null, tools, sudo: { state: sudoState, nonInteractive: sudoState === "already-root" || sudoState === "available" } } };
  return { ok: local.ok && remote.connected, local, remote };
}
