import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRemoteStat, parseSha256, remoteHashCommand, remoteStatCommand, sha256File } from "../../src/server/file-operations.js";

test("sha256File hashes local bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ssh-operator-hash-"));
  const path = join(directory, "file.txt");
  try {
    await writeFile(path, "abc");
    assert.equal(await sha256File(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote file commands quote paths", () => {
  assert.match(remoteHashCommand("/tmp/a file's.txt"), /'\/tmp\/a file'"'"'s\.txt'/u);
  assert.match(remoteStatCommand("/tmp/file", true), /stat -L -c/u);
});

test("parseRemoteStat validates structured fields", () => {
  assert.deepEqual(parseRemoteStat("regular file|12|640|1000|1000|123456\n"), { type: "regular file", size: 12, mode: "640", uid: 1000, gid: 1000, modifiedEpochSeconds: 123456 });
  assert.throws(() => parseRemoteStat("broken"));
});

test("parseSha256 normalizes and validates digest", () => {
  assert.equal(parseSha256(`${"A".repeat(64)}\n`), "a".repeat(64));
  assert.throws(() => parseSha256("not-a-hash"));
});

