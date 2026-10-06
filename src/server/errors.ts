import type { ProcessResult } from "./process-runner.js";

export type ErrorPhase = "validation" | "local" | "connect" | "authorize" | "execute" | "transfer" | "cleanup" | "state" | "log" | "internal";

export type ErrorCode =
  | "SSH_TIMEOUT" | "SSH_CANCELLED" | "SSH_AUTH_FAILED" | "SSH_HOST_KEY_FAILED"
  | "SSH_HOST_NOT_FOUND" | "SSH_CONNECTION_REFUSED" | "SSH_UNREACHABLE"
  | "SSH_TRANSPORT_FAILED" | "REMOTE_COMMAND_FAILED" | "TRANSFER_FAILED"
  | "REMOTE_CLEANUP_FAILED" | "STATE_LOCK_FAILED" | "STATE_CORRUPT"
  | "LOG_IO_FAILED" | "SUDO_AUTH_REQUIRED" | "SUDO_POLICY_DENIED"
  | "VALIDATION_FAILED" | "INTERNAL_ERROR";

export interface ErrorDetails {
  errorCode: ErrorCode;
  phase: ErrorPhase;
  retryable: boolean;
}

export class OperatorError extends Error {
  constructor(message: string, readonly details: ErrorDetails) {
    super(message);
    this.name = "OperatorError";
  }
}

export function classifyProcessFailure(result: ProcessResult, phase: ErrorPhase): ErrorDetails | undefined {
  if (result.exitCode === 0 && !result.timedOut && !result.aborted && !result.terminationError) return undefined;
  if (result.timedOut) return { errorCode: "SSH_TIMEOUT", phase, retryable: true };
  if (result.aborted) return { errorCode: "SSH_CANCELLED", phase, retryable: false };
  if (result.terminationError) return { errorCode: "REMOTE_CLEANUP_FAILED", phase: "cleanup", retryable: true };
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if ((result.exitCode === 255 || result.remotePid !== undefined) && result.remoteExitCode === undefined) {
    if (/permission denied|authentication failed/iu.test(diagnostic)) return { errorCode: "SSH_AUTH_FAILED", phase: "connect", retryable: false };
    if (/host key verification failed|remote host identification has changed/iu.test(diagnostic)) return { errorCode: "SSH_HOST_KEY_FAILED", phase: "connect", retryable: false };
    if (/could not resolve hostname|name or service not known|no such host/iu.test(diagnostic)) return { errorCode: "SSH_HOST_NOT_FOUND", phase: "connect", retryable: true };
    if (/connection refused/iu.test(diagnostic)) return { errorCode: "SSH_CONNECTION_REFUSED", phase: "connect", retryable: true };
    if (/no route to host|connection timed out|operation timed out|network is unreachable/iu.test(diagnostic)) return { errorCode: "SSH_UNREACHABLE", phase: "connect", retryable: true };
    return { errorCode: "SSH_TRANSPORT_FAILED", phase: "connect", retryable: true };
  }
  return { errorCode: phase === "transfer" ? "TRANSFER_FAILED" : "REMOTE_COMMAND_FAILED", phase, retryable: false };
}

export function classifyThrownError(error: unknown, fallbackPhase: ErrorPhase = "internal"): ErrorDetails {
  if (error instanceof OperatorError) return error.details;
  const message = error instanceof Error ? error.message : String(error);
  if (/must |invalid |refuses|already exists|unknown persisted|unknown process|cannot delete/iu.test(message)) {
    return { errorCode: "VALIDATION_FAILED", phase: "validation", retryable: false };
  }
  if (/state lock|waiting for active-process/iu.test(message)) return { errorCode: "STATE_LOCK_FAILED", phase: "state", retryable: true };
  if (/active-process state|state format|process record/iu.test(message)) return { errorCode: "STATE_CORRUPT", phase: "state", retryable: false };
  if (/process log|log metadata/iu.test(message)) return { errorCode: "LOG_IO_FAILED", phase: "log", retryable: false };
  return { errorCode: "INTERNAL_ERROR", phase: fallbackPhase, retryable: false };
}
