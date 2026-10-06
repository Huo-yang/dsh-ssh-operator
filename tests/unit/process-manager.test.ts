import assert from "node:assert/strict";
import test from "node:test";
import { ProcessManager } from "../../src/server/process-manager.js";

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

test("ProcessManager retains cursor-based stdout and stderr", async () => {
  const manager = new ProcessManager();
  const started = manager.start({
    executable: process.execPath,
    args: ["-e", "console.log('one'); console.error('two')"],
    host: "test-host",
    command: "test-command",
  });
  await wait(150);
  const first = manager.read(started.processId, 0, 1);
  assert.equal(first.chunks.length, 1);
  assert.equal(first.hasMore, true);
  const second = manager.read(started.processId, first.nextCursor, 10);
  assert.equal(second.running, false);
  assert.equal([...first.chunks, ...second.chunks].map((chunk) => chunk.text).join(""), "one\ntwo\n");
  manager.close(started.processId);
  assert.deepEqual(manager.list(), []);
});

test("ProcessManager stops a running process before closing", async () => {
  const manager = new ProcessManager();
  const started = manager.start({
    executable: process.execPath,
    args: ["-e", "setInterval(() => console.log('tick'), 50)"],
    host: "test-host",
    command: "long-command",
  });
  assert.throws(() => manager.close(started.processId));
  const stopping = await manager.stop(started.processId);
  assert.equal(stopping.stopRequested, true);
  await wait(150);
  assert.equal(manager.read(started.processId).running, false);
  manager.close(started.processId);
});

test("ProcessManager captures and hides the managed remote PID marker", async () => {
  const manager = new ProcessManager();
  const started = manager.start({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('startup warning\\n\\x1eSSH_OPERATOR_PID=4321\\x1fvisible\\n\\x1eSSH_OPERATOR_EXIT=255\\x1f'); process.exitCode=255"],
    host: "test-host",
    command: "test-command",
    expectRemotePid: true,
  });
  await wait(150);
  const result = manager.read(started.processId);
  assert.equal(result.remotePid, 4321);
  assert.equal(result.remoteExitCode, 255);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), "startup warning\nvisible\n");
  manager.close(started.processId);
});

test("ProcessManager preserves UTF-8 characters split across output chunks", async () => {
  const manager = new ProcessManager();
  const started = manager.start({
    executable: process.execPath,
    args: [
      "-e",
      "const b=Buffer.from('你好'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),25)",
    ],
    host: "test-host",
    command: "utf8-command",
  });
  await wait(150);
  const result = manager.read(started.processId);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), "你好");
  manager.close(started.processId);
});

test("ProcessManager reports remote cleanup failure and still closes the local child", async () => {
  const manager = new ProcessManager();
  const started = manager.start({
    executable: process.execPath,
    args: [
      "-e",
      "process.stderr.write('\\x1eSSH_OPERATOR_PID=4321\\x1f'); setInterval(() => {}, 1000)",
    ],
    host: "test-host",
    command: "cleanup-failure",
    expectRemotePid: true,
    stopRemote: async () => {
      throw new Error("control connection failed");
    },
  });
  await wait(100);
  const stopped = await manager.stop(started.processId);
  assert.equal(stopped.terminationError, "control connection failed");
  await wait(100);
  assert.equal(manager.read(started.processId).running, false);
  manager.close(started.processId);
});

