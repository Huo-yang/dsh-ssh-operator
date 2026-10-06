import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessLogStore } from "../../src/server/process-log-store.js";

test("ProcessLogStore persists cursor-readable chunks across instances", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-logs-"));
  try {
    const store = new ProcessLogStore(directory);
    store.start({
      processId: "process-1",
      host: "wsl-ubuntu",
      command: "build",
      startedAt: "2026-10-04T00:00:00.000Z",
      maxBytes: 1024 * 1024,
    });
    store.append("process-1", { seq: 1, stream: "stdout", text: "one\n", timestamp: "2026-10-04T00:00:01.000Z" });
    store.append("process-1", { seq: 2, stream: "stderr", text: "two\n", timestamp: "2026-10-04T00:00:02.000Z" });
    store.finish("process-1");

    const reopened = new ProcessLogStore(directory);
    const first = await reopened.read("process-1", 0, 1);
    assert.equal(first.chunks[0]?.text, "one\n");
    assert.equal(first.hasMore, true);
    const second = await reopened.read("process-1", first.nextCursor, 10);
    assert.equal(second.chunks[0]?.text, "two\n");
    assert.equal(second.metadata.running, false);

    reopened.delete("process-1");
    assert.deepEqual(reopened.list(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProcessLogStore reports truncation at its disk limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-logs-"));
  try {
    const store = new ProcessLogStore(directory);
    store.start({
      processId: "process-2",
      host: "wsl-ubuntu",
      command: "noisy",
      startedAt: "2026-10-04T00:00:00.000Z",
      maxBytes: 10,
    });
    store.append("process-2", { seq: 1, stream: "stdout", text: "too large", timestamp: "now" });
    assert.equal(store.get("process-2")?.truncated, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProcessLogStore migrates v1 metadata to v2", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-logs-"));
  try {
    const path = join(directory, "legacy.json");
    writeFileSync(path, JSON.stringify({ version: 1, processId: "legacy", host: "wsl-ubuntu", command: "build", startedAt: "2026-10-04T00:00:00.000Z", running: false, bytesWritten: 0, chunkCount: 0, maxBytes: 1024, truncated: false }));
    writeFileSync(join(directory, "legacy.ndjson"), "");
    const store = new ProcessLogStore(directory);
    assert.equal(store.list()[0]?.version, 2);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
    assert.equal(store.diagnostics()[0]?.action, "migrated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProcessLogStore quarantines corrupt metadata without hiding healthy logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-logs-"));
  try {
    writeFileSync(join(directory, "broken.json"), "not-json");
    const store = new ProcessLogStore(directory);
    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(join(directory, "broken.json")), false);
    assert.equal(readdirSync(directory).some((name) => name.startsWith("broken.json.corrupt.")), true);
    assert.equal(store.diagnostics()[0]?.action, "quarantined");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProcessLogStore quarantines corrupt chunk data and its metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-logs-"));
  try {
    const store = new ProcessLogStore(directory);
    store.start({ processId: "broken-data", host: "wsl-ubuntu", command: "build", startedAt: "2026-10-04T00:00:00.000Z", maxBytes: 1024 });
    writeFileSync(join(directory, "broken-data.ndjson"), "{bad-json\n");
    await assert.rejects(store.read("broken-data"), /quarantined/u);
    assert.equal(existsSync(join(directory, "broken-data.json")), false);
    assert.equal(existsSync(join(directory, "broken-data.ndjson")), false);
    assert.equal(store.diagnostics().filter((item) => item.action === "quarantined").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

