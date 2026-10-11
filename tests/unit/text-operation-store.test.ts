import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextOperationStore } from "../../src/server/text-operation-store.js";

test("TextOperationStore persists bounded mutation receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ssh-operator-text-operations-"));
  const path = join(directory, "operations.json");
  try {
    const store = new TextOperationStore(path, 2);
    for (let index = 1; index <= 3; index += 1) {
      store.upsert({ operationId: `op-${index}`, host: "wsl-ubuntu", remotePath: `/tmp/${index}`, requestDigest: `${index}`.repeat(64), afterSha256: `${index}`.repeat(64), completedAt: new Date().toISOString(), result: { ok: true, index } });
    }
    const reopened = new TextOperationStore(path, 2);
    assert.equal(reopened.count(), 2);
    assert.equal(reopened.get("wsl-ubuntu", "op-1"), undefined);
    assert.equal(reopened.get("wsl-ubuntu", "op-3")?.result.index, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TextOperationStore quarantines corrupt receipts and refuses a newer schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ssh-operator-text-operations-corrupt-"));
  const path = join(directory, "operations.json");
  try {
    await writeFile(path, "not json");
    const recovered = new TextOperationStore(path);
    assert.equal(recovered.count(), 0);
    assert.equal(recovered.diagnostics()[0]?.action, "quarantined");
    await writeFile(path, JSON.stringify({ version: 999, records: [] }));
    assert.throws(() => new TextOperationStore(path).count(), /unsupported text-operation state version/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
