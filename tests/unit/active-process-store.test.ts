import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActiveProcessStore } from "../../src/server/active-process-store.js";

test("ActiveProcessStore persists and removes validated records", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    const store = new ActiveProcessStore(path);
    store.upsert({
      processId: "process-1",
      host: "wsl-ubuntu",
      remotePid: 4321,
      token: "token-1",
      startedAt: "2026-10-04T00:00:00.000Z",
      ownerPid: 1234,
      detached: false,
    });
    assert.deepEqual(new ActiveProcessStore(path).list(), store.list());
    store.markDetached("process-1");
    assert.equal(new ActiveProcessStore(path).list()[0]?.detached, true);
    store.remove("process-1");
    assert.deepEqual(new ActiveProcessStore(path).list(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore refuses malformed state", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    const store = new ActiveProcessStore(path);
    assert.throws(() => store.upsert({
      processId: "process-1",
      host: "wsl-ubuntu",
      remotePid: 0,
      token: "token-1",
      startedAt: "invalid",
      ownerPid: 1234,
      detached: false,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore merges writes from instances with stale in-memory views", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    const first = new ActiveProcessStore(path);
    const second = new ActiveProcessStore(path);
    first.upsert({
      processId: "process-a",
      host: "wsl-ubuntu",
      remotePid: 1001,
      token: "token-a",
      startedAt: "2026-10-04T00:00:00.000Z",
      ownerPid: 1234,
      detached: false,
    });
    second.upsert({
      processId: "process-b",
      host: "wsl-ubuntu",
      remotePid: 1002,
      token: "token-b",
      startedAt: "2026-10-04T00:00:01.000Z",
      ownerPid: 1235,
      detached: false,
    });
    assert.deepEqual(first.list().map((record) => record.processId).sort(), ["process-a", "process-b"]);
    first.remove("process-a");
    assert.deepEqual(second.list().map((record) => record.processId), ["process-b"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore removes an old lock owned by a dead process", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  const lockPath = `${path}.lock`;
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const store = new ActiveProcessStore(path);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore migrates v1 state to v2", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 1, records: [{ processId: "legacy", host: "wsl-ubuntu", remotePid: 4321, token: "token", startedAt: "2026-10-04T00:00:00.000Z", ownerPid: 1234, detached: false }] }));
    const store = new ActiveProcessStore(path);
    assert.equal(store.list()[0]?.processId, "legacy");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
    assert.equal(store.diagnostics().some((item) => item.action === "migrated" && item.fromVersion === 1 && item.toVersion === 2), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore quarantines corrupt state and remains usable", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    writeFileSync(path, "{not-json");
    const store = new ActiveProcessStore(path);
    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(directory).some((name) => name.startsWith("active-processes.json.corrupt.")), true);
    assert.equal(store.diagnostics()[0]?.action, "quarantined");
    store.upsert({ processId: "new", host: "wsl-ubuntu", remotePid: 4321, token: "token", startedAt: "2026-10-04T00:00:00.000Z", ownerPid: 1234, detached: false });
    assert.equal(store.list()[0]?.processId, "new");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore preserves valid records when one record is corrupt", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    const valid = { processId: "valid", host: "wsl-ubuntu", remotePid: 4321, token: "token", startedAt: "2026-10-04T00:00:00.000Z", ownerPid: 1234, detached: false };
    writeFileSync(path, JSON.stringify({ version: 2, updatedAt: "2026-10-04T00:00:00.000Z", records: [valid, { processId: "broken" }] }));
    const store = new ActiveProcessStore(path);
    assert.deepEqual(store.list(), [valid]);
    assert.equal(readdirSync(directory).some((name) => name.startsWith("active-processes.json.corrupt.")), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).records, [valid]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ActiveProcessStore refuses an unknown newer schema without moving it", () => {
  const directory = mkdtempSync(join(tmpdir(), "ssh-operator-store-"));
  const path = join(directory, "active-processes.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 999, records: [] }));
    assert.throws(() => new ActiveProcessStore(path), /unsupported state version/u);
    assert.equal(existsSync(path), true);
    assert.equal(readdirSync(directory).some((name) => name.includes(".corrupt.")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

