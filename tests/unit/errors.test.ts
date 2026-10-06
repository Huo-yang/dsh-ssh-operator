import test from "node:test";
import assert from "node:assert/strict";
import { classifyProcessFailure, classifyThrownError } from "../../src/server/errors.js";
import type { ProcessResult } from "../../src/server/process-runner.js";

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, truncated: false, timedOut: false, aborted: false, ...overrides };
}

test("successful process has no classified failure", () => assert.equal(classifyProcessFailure(result(), "execute"), undefined));
test("timeout and cancellation are stable", () => {
  assert.deepEqual(classifyProcessFailure(result({ timedOut: true }), "execute"), { errorCode: "SSH_TIMEOUT", phase: "execute", retryable: true });
  assert.deepEqual(classifyProcessFailure(result({ aborted: true }), "execute"), { errorCode: "SSH_CANCELLED", phase: "execute", retryable: false });
});

for (const [stderr, errorCode, retryable] of [
  ["Permission denied (publickey).", "SSH_AUTH_FAILED", false],
  ["Host key verification failed.", "SSH_HOST_KEY_FAILED", false],
  ["Could not resolve hostname nowhere", "SSH_HOST_NOT_FOUND", true],
  ["connect: Connection refused", "SSH_CONNECTION_REFUSED", true],
  ["connect: No route to host", "SSH_UNREACHABLE", true],
] as const) {
  test(`classifies ${errorCode}`, () => assert.deepEqual(classifyProcessFailure(result({ exitCode: 255, stderr }), "execute"), { errorCode, phase: "connect", retryable }));
}

test("classifies ordinary command and transfer failures", () => {
  assert.equal(classifyProcessFailure(result({ exitCode: 2 }), "execute")?.errorCode, "REMOTE_COMMAND_FAILED");
  assert.equal(classifyProcessFailure(result({ exitCode: 1 }), "transfer")?.errorCode, "TRANSFER_FAILED");
});

test("remote exit 255 is a command failure, not a transport failure", () => {
  assert.deepEqual(classifyProcessFailure(result({ exitCode: 255, remoteExitCode: 255 }), "execute"), { errorCode: "REMOTE_COMMAND_FAILED", phase: "execute", retryable: false });
});

test("a started remote command without an exit marker is a transport failure", () => {
  assert.deepEqual(classifyProcessFailure(result({ exitCode: -1, remotePid: 4321 }), "execute"), { errorCode: "SSH_TRANSPORT_FAILED", phase: "connect", retryable: true });
});

test("classifies validation exceptions", () => assert.deepEqual(classifyThrownError(new Error("Local path must be absolute.")), { errorCode: "VALIDATION_FAILED", phase: "validation", retryable: false }));

