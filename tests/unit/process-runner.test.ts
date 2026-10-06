import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../../src/server/process-runner.js";

test("runProcess reports cancellation distinctly", async () => {
  const controller = new AbortController();
  const promise = runProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000)"],
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test("runProcess reports output truncation", async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096))"],
    maxOutputBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 1024);
});

test("runProcess hides the remote PID marker and stops the remote group on cancellation", async () => {
  const controller = new AbortController();
  let stoppedPid: number | undefined;
  const promise = runProcess({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('startup warning\\n\\x1eSSH_OPERATOR_PID=4321\\x1f'); setInterval(() => {}, 1000)"],
    timeoutMs: 10_000,
    signal: controller.signal,
    expectRemotePid: true,
    stopRemote: async (remotePid) => {
      stoppedPid = remotePid;
      return {
        remotePid,
        state: "terminated",
        termSent: true,
        killSent: false,
        durationMs: 1,
      };
    },
  });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert.equal(stoppedPid, 4321);
  assert.equal(result.remotePid, 4321);
  assert.equal(result.stderr, "startup warning\n");
  assert.equal(result.aborted, true);
  assert.equal(result.termination?.state, "terminated");
});

test("runProcess captures and hides a remote exit marker", async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('before\\x1eSSH_OPERATOR_PID=4321\\x1fmiddle\\x1eSSH_OPERATOR_EXIT=255\\x1fafter'); process.exitCode=255"],
    expectRemotePid: true,
  });
  assert.equal(result.remotePid, 4321);
  assert.equal(result.remoteExitCode, 255);
  assert.equal(result.stderr, "beforemiddleafter");
});

test("runProcess does not retain an unclosed control-like stderr prefix", async () => {
  const text = `before${String.fromCharCode(0x1e)}${"x".repeat(256)}after`;
  const result = await runProcess({ executable: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(text)})`], expectRemotePid: true });
  assert.equal(result.stderr, text);
});

