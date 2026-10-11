import { classifyProcessFailure, classifyThrownError, OperatorError, type ErrorPhase } from "./errors.js";
import type { ProcessResult } from "./process-runner.js";

export function jsonResponse<T extends Record<string, unknown>>(payload: T, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function processResponse(result: ProcessResult, phase: ErrorPhase) {
  const failure = classifyProcessFailure(result, phase);
  const payload = { ok: failure === undefined, ...result, ...(failure ?? {}) };
  return { ...jsonResponse(payload, !payload.ok), isError: !payload.ok };
}

export function errorResponse(error: unknown, phase: ErrorPhase = "internal") {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...classifyThrownError(error, phase),
    ...(error instanceof OperatorError ? error.context : {}),
  };
  return { ...jsonResponse(payload, true), isError: true };
}
