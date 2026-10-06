import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { CONTROL_END, CONTROL_START, REMOTE_EXIT_MARKER, REMOTE_PID_MARKER } from "./commands.js";
import type { RemoteTerminationResult } from "./process-runner.js";

export type OutputStream = "stdout" | "stderr";

export interface OutputChunk {
  seq: number;
  stream: OutputStream;
  text: string;
  timestamp: string;
}

interface ManagedProcess {
  id: string;
  host: string;
  command: string;
  cwd?: string;
  child: ChildProcessWithoutNullStreams;
  chunks: OutputChunk[];
  nextSeq: number;
  bufferBytes: number;
  maxBufferBytes: number;
  droppedChunks: number;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: boolean;
  stopRequested: boolean;
  remotePid?: number;
  remoteExitCode?: number;
  controlBuffer: Buffer;
  expectRemotePid: boolean;
  stopRemote?: (remotePid: number) => Promise<RemoteTerminationResult>;
  termination?: RemoteTerminationResult;
  terminationError?: string;
  stateError?: string;
  onRemotePid?: (remotePid: number) => void;
  onExit?: (exitCode: number | null, signal: NodeJS.Signals | null, stopRequested: boolean, remoteExitCode?: number) => void;
  exitNotified: boolean;
  onOutput?: (chunk: OutputChunk) => void;
  logPath?: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
}

export interface StartProcessRequest {
  executable: string;
  args: string[];
  host: string;
  command: string;
  cwd?: string;
  maxBufferBytes?: number;
  expectRemotePid?: boolean;
  stopRemote?: (remotePid: number) => Promise<RemoteTerminationResult>;
  processId?: string;
  onRemotePid?: (remotePid: number) => void;
  onExit?: (exitCode: number | null, signal: NodeJS.Signals | null, stopRequested: boolean, remoteExitCode?: number) => void;
  onOutput?: (chunk: OutputChunk) => void;
  logPath?: string;
}

export interface ProcessSummary extends Record<string, unknown> {
  processId: string;
  host: string;
  command: string;
  cwd?: string;
  localPid?: number;
  running: boolean;
  stopRequested: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt?: string;
  latestCursor: number;
  bufferedBytes: number;
  droppedChunks: number;
  remotePid?: number;
  remoteExitCode?: number;
  termination?: RemoteTerminationResult;
  terminationError?: string;
  stateError?: string;
  logPath?: string;
}

export interface ProcessOutput extends ProcessSummary {
  chunks: OutputChunk[];
  nextCursor: number;
  hasMore: boolean;
  truncatedBefore: boolean;
}

const MAX_PROCESSES = 16;
const COMPLETED_RETENTION_MS = 60 * 60 * 1000;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  start(request: StartProcessRequest): ProcessSummary {
    this.prune();
    if (this.processes.size >= MAX_PROCESSES) {
      throw new Error(`At most ${MAX_PROCESSES} managed processes may be retained.`);
    }

    const child = spawn(request.executable, request.args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process: ManagedProcess = {
      id: request.processId ?? randomUUID(),
      host: request.host,
      command: request.command,
      cwd: request.cwd,
      child,
      chunks: [],
      nextSeq: 1,
      bufferBytes: 0,
      maxBufferBytes: request.maxBufferBytes ?? 2 * 1024 * 1024,
      droppedChunks: 0,
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      running: true,
      stopRequested: false,
      controlBuffer: Buffer.alloc(0),
      expectRemotePid: request.expectRemotePid ?? false,
      stopRemote: request.stopRemote,
      onRemotePid: request.onRemotePid,
      onExit: request.onExit,
      exitNotified: false,
      onOutput: request.onOutput,
      logPath: request.logPath,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
    };
    this.processes.set(process.id, process);

    child.stdout.on("data", (chunk: Buffer) => this.append(process, "stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(process, chunk));
    child.once("error", (error) => {
      this.append(process, "stderr", Buffer.from(`[local process error] ${error.message}\n`));
      process.running = false;
      process.endedAt = new Date().toISOString();
    });
    child.once("close", (exitCode, signal) => {
      if (process.controlBuffer.length) {
        this.append(process, "stderr", process.controlBuffer);
        process.controlBuffer = Buffer.alloc(0);
      }
      this.flushDecoders(process);
      process.running = false;
      process.exitCode = exitCode === 0xffffffff ? -1 : exitCode;
      process.signal = signal;
      process.endedAt = new Date().toISOString();
      this.notifyExit(process);
    });
    child.stdin.end();
    return this.summary(process);
  }

  list(): ProcessSummary[] {
    this.prune();
    return [...this.processes.values()].map((process) => this.summary(process));
  }

  read(processId: string, cursor = 0, limit = 100): ProcessOutput {
    const process = this.get(processId);
    const oldestSeq = process.chunks[0]?.seq ?? process.nextSeq;
    const available = process.chunks.filter((chunk) => chunk.seq > cursor);
    const chunks = available.slice(0, limit);
    const nextCursor = chunks.at(-1)?.seq ?? Math.max(cursor, process.nextSeq - 1);
    return {
      ...this.summary(process),
      chunks,
      nextCursor,
      hasMore: available.length > chunks.length,
      truncatedBefore: cursor < oldestSeq - 1,
    };
  }

  async stop(processId: string): Promise<ProcessSummary> {
    const process = this.get(processId);
    if (process.running) {
      process.stopRequested = true;
      if (process.stopRemote) {
        const remotePid = await this.waitForRemotePid(process, 3_000);
        try {
          if (remotePid !== undefined) process.termination = await process.stopRemote(remotePid);
          else process.terminationError = "Remote PID was not captured before the cleanup deadline.";
        } catch (error) {
          process.terminationError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (process.running) process.child.kill();
    }
    return this.summary(process);
  }

  close(processId: string): void {
    const process = this.get(processId);
    if (process.running) throw new Error("Process is still running; stop it before closing its record.");
    this.processes.delete(processId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.processes.values()]
        .filter((process) => process.running)
        .map((process) => this.stop(process.id)),
    );
  }

  private append(process: ManagedProcess, stream: OutputStream, data: Buffer): void {
    const decoder = stream === "stdout" ? process.stdoutDecoder : process.stderrDecoder;
    const text = decoder.write(data);
    if (!text) return;
    this.appendText(process, stream, text);
  }

  private appendText(process: ManagedProcess, stream: OutputStream, text: string): void {
    const textBytes = Buffer.byteLength(text);
    if (textBytes > process.maxBufferBytes) {
      process.droppedChunks += process.chunks.length + 1;
      process.chunks = [];
      process.bufferBytes = 0;
      text = Buffer.from(text).subarray(textBytes - process.maxBufferBytes).toString("utf8");
    }
    const chunk: OutputChunk = {
      seq: process.nextSeq++,
      stream,
      text,
      timestamp: new Date().toISOString(),
    };
    process.chunks.push(chunk);
    try {
      process.onOutput?.(chunk);
    } catch (error) {
      process.stateError = error instanceof Error ? error.message : String(error);
    }
    process.bufferBytes += Buffer.byteLength(text);
    while (process.bufferBytes > process.maxBufferBytes && process.chunks.length > 1) {
      const removed = process.chunks.shift();
      if (!removed) break;
      process.bufferBytes -= Buffer.byteLength(removed.text);
      process.droppedChunks += 1;
    }
  }

  private summary(process: ManagedProcess): ProcessSummary {
    return {
      processId: process.id,
      host: process.host,
      command: process.command,
      cwd: process.cwd,
      localPid: process.child.pid,
      running: process.running,
      stopRequested: process.stopRequested,
      exitCode: process.exitCode,
      signal: process.signal,
      startedAt: process.startedAt,
      endedAt: process.endedAt,
      latestCursor: process.nextSeq - 1,
      bufferedBytes: process.bufferBytes,
      droppedChunks: process.droppedChunks,
      remotePid: process.remotePid,
      remoteExitCode: process.remoteExitCode,
      termination: process.termination,
      terminationError: process.terminationError,
      stateError: process.stateError,
      logPath: process.logPath,
    };
  }

  private handleStderr(process: ManagedProcess, data: Buffer): void {
    if (!process.expectRemotePid) {
      this.append(process, "stderr", data);
      return;
    }
    process.controlBuffer = Buffer.concat([process.controlBuffer, data]);
    while (process.controlBuffer.length) {
      const start = process.controlBuffer.indexOf(CONTROL_START);
      if (start < 0) { this.append(process, "stderr", process.controlBuffer); process.controlBuffer = Buffer.alloc(0); break; }
      if (start > 0) { this.append(process, "stderr", process.controlBuffer.subarray(0, start)); process.controlBuffer = process.controlBuffer.subarray(start); }
      const end = process.controlBuffer.indexOf(CONTROL_END, 1);
      if (end < 0) {
        if (process.controlBuffer.length <= 128) break;
        this.append(process, "stderr", process.controlBuffer.subarray(0, 1));
        process.controlBuffer = process.controlBuffer.subarray(1);
        continue;
      }
      const framed = process.controlBuffer.subarray(0, end + 1);
      const frame = process.controlBuffer.subarray(1, end).toString("utf8");
      process.controlBuffer = process.controlBuffer.subarray(end + 1);
      const pidMatch = frame.match(new RegExp(`^${REMOTE_PID_MARKER}(\\d+)$`, "u"));
      const exitMatch = frame.match(new RegExp(`^${REMOTE_EXIT_MARKER}(\\d+)$`, "u"));
      if (pidMatch) {
        process.remotePid = Number(pidMatch[1]);
        try { process.onRemotePid?.(process.remotePid); } catch (error) { process.stateError = error instanceof Error ? error.message : String(error); }
      } else if (exitMatch) process.remoteExitCode = Number(exitMatch[1]);
      else this.append(process, "stderr", framed);
    }
  }

  private flushDecoders(process: ManagedProcess): void {
    const stdout = process.stdoutDecoder.end();
    const stderr = process.stderrDecoder.end();
    if (stdout) this.appendText(process, "stdout", stdout);
    if (stderr) this.appendText(process, "stderr", stderr);
  }

  private notifyExit(process: ManagedProcess): void {
    if (process.exitNotified) return;
    process.exitNotified = true;
    try {
      process.onExit?.(process.exitCode, process.signal, process.stopRequested, process.remoteExitCode);
    } catch (error) {
      process.stateError = error instanceof Error ? error.message : String(error);
    }
  }

  private async waitForRemotePid(process: ManagedProcess, timeoutMs: number): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (process.running && process.remotePid === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return process.remotePid;
  }

  private get(processId: string): ManagedProcess {
    const process = this.processes.get(processId);
    if (!process) throw new Error(`Unknown managed process: ${processId}`);
    return process;
  }

  private prune(): void {
    const cutoff = Date.now() - COMPLETED_RETENTION_MS;
    for (const [id, process] of this.processes) {
      if (!process.running && process.endedAt && Date.parse(process.endedAt) < cutoff) {
        this.processes.delete(id);
      }
    }
  }
}
