import assert from "node:assert/strict";
import test from "node:test";
import { OperatorError } from "../../src/server/errors.js";
import { errorResponse, jsonResponse, processResponse } from "../../src/server/tool-response.js";

test("jsonResponse keeps text and structured payloads identical", () => {
  const response = jsonResponse({ ok: true, value: 2 });
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.equal("isError" in response, false);
});

test("processResponse classifies remote failures", () => {
  const response = processResponse({ exitCode: 2, signal: null, stdout: "", stderr: "failed", durationMs: 1, truncated: false, timedOut: false, aborted: false, remotePid: 10, remoteExitCode: 2 }, "execute");
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.errorCode, "REMOTE_COMMAND_FAILED");
});

test("errorResponse preserves operator context", () => {
  const response = errorResponse(new OperatorError("missing", { errorCode: "REMOTE_CAPABILITY_UNAVAILABLE", phase: "execute", retryable: false }, { capability: "rg" }));
  assert.equal((response.structuredContent as Record<string, unknown>).capability, "rg");
  assert.equal(response.structuredContent.errorCode, "REMOTE_CAPABILITY_UNAVAILABLE");
});
