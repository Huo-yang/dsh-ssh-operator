import { spawn } from "node:child_process";
import { CONTROL_END, CONTROL_START, REMOTE_EXIT_MARKER, REMOTE_PID_MARKER } from "./commands.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  expectRemotePid?: boolean;
  stopRemote?: (remotePid: number) => Promise<RemoteTerminationResult>;
}

export interface RemoteTerminationResult {
  remotePid: number;
  state: "already-exited" | "terminated" | "killed";
  termSent: boolean;
  killSent: boolean;
  durationMs: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  remotePid?: number;
  remoteExitCode?: number;
  terminationError?: string;
  termination?: RemoteTerminationResult;
}

function normalizeExitCode(exitCode: number | null): number | null {
  return exitCode === 0xffffffff ? -1 : exitCode;
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const timeoutMs = request.timeoutMs ?? 120_000;
  const maxOutputBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;
  const startedAt = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    if (process.env.SSH_OPERATOR_DEBUG === "1") {
      console.error(`[ssh-operator] spawn ${JSON.stringify([request.executable, ...request.args])}`);
    }
    const child = spawn(request.executable, request.args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let remotePid: number | undefined;
    let remoteExitCode: number | undefined;
    let terminationError: string | undefined;
    let termination: RemoteTerminationResult | undefined;
    let terminationPromise: Promise<void> | undefined;
    let controlBuffer = Buffer.alloc(0);
    const expectRemoteControl = request.expectRemotePid ?? false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      target.push(chunk.subarray(0, remaining));
      capturedBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (!expectRemoteControl) {
        capture(stderr, chunk);
        return;
      }
      controlBuffer = Buffer.concat([controlBuffer, chunk]);
      while (controlBuffer.length) {
        const start = controlBuffer.indexOf(CONTROL_START);
        if (start < 0) { capture(stderr, controlBuffer); controlBuffer = Buffer.alloc(0); break; }
        if (start > 0) { capture(stderr, controlBuffer.subarray(0, start)); controlBuffer = controlBuffer.subarray(start); }
        const end = controlBuffer.indexOf(CONTROL_END, 1);
        if (end < 0) {
          if (controlBuffer.length <= 128) break;
          capture(stderr, controlBuffer.subarray(0, 1));
          controlBuffer = controlBuffer.subarray(1);
          continue;
        }
        const framed = controlBuffer.subarray(0, end + 1);
        const frame = controlBuffer.subarray(1, end).toString("utf8");
        controlBuffer = controlBuffer.subarray(end + 1);
        const pidMatch = frame.match(new RegExp(`^${REMOTE_PID_MARKER}(\\d+)$`, "u"));
        const exitMatch = frame.match(new RegExp(`^${REMOTE_EXIT_MARKER}(\\d+)$`, "u"));
        if (pidMatch) remotePid = Number(pidMatch[1]);
        else if (exitMatch) remoteExitCode = Number(exitMatch[1]);
        else capture(stderr, framed);
      }
    });

    const waitForRemotePid = async (timeoutMs: number): Promise<number | undefined> => {
      const deadline = Date.now() + timeoutMs;
      while (!settled && remotePid === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return remotePid;
    };

    const terminate = (): Promise<void> => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        try {
          if (request.stopRemote) {
            const pid = await waitForRemotePid(1_000);
            if (pid !== undefined) termination = await request.stopRemote(pid);
          }
        } catch (error) {
          terminationError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!settled && !child.killed) child.kill();
      })();
      return terminationPromise;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      void terminate();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.once("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (controlBuffer.length) capture(stderr, controlBuffer);
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (terminationPromise) await terminationPromise;
      if (process.env.SSH_OPERATOR_DEBUG === "1") {
        console.error(`[ssh-operator] close ${JSON.stringify({ pid: child.pid, exitCode, signal, timedOut })}`);
      }
      resolve({
        exitCode: normalizeExitCode(exitCode),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
        aborted,
        remotePid,
        remoteExitCode,
        terminationError,
        termination,
      });
    });

    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();
  });
}
