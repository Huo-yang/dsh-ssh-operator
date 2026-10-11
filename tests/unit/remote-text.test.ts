import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeText,
  applyUnifiedPatch,
  paginateText,
  parseRemoteText,
  remoteAtomicWriteCommand,
  remoteReadTextCommand,
  sha256Text,
} from "../../src/server/remote-text.js";

test("analyzeText detects encoding, line endings, and logical line count", () => {
  assert.deepEqual(analyzeText("a\nb\n"), { encoding: "utf-8", lineEnding: "lf", totalLines: 2 });
  assert.deepEqual(analyzeText("\ufeffa\r\nb"), { encoding: "utf-8-bom", lineEnding: "crlf", totalLines: 2 });
  assert.equal(analyzeText("a\r\nb\n").lineEnding, "mixed");
  assert.equal(analyzeText("").totalLines, 0);
});

test("paginateText returns whole lines and a continuation cursor", () => {
  assert.deepEqual(paginateText("one\ntwo\nthree\n", 2, 1, 1024), {
    content: "two\n", startLine: 2, endLine: 2, returnedLines: 1, returnedBytes: 4, hasMore: true, nextLine: 3,
  });
  assert.throws(() => paginateText("a very long line\n", 1, 1, 4), /single text line exceeds/u);
});

test("parseRemoteText validates transfer hashes and UTF-8", () => {
  const content = "hello 世界\n";
  const encoded = Buffer.from(content).toString("base64");
  const digest = sha256Text(content);
  const output = `META|${digest}|${Buffer.byteLength(content)}|640|1000|1000|123\nDATA|${encoded}\nEND|${digest}\n`;
  const parsed = parseRemoteText(output);
  assert.equal(parsed.content, content);
  assert.equal(parsed.sha256, digest);
  assert.equal(parsed.lineEnding, "lf");
  assert.throws(() => parseRemoteText(output.replace(`END|${digest}`, `END|${"0".repeat(64)}`)), /changed while/u);
});

test("applyUnifiedPatch replaces, inserts, and deletes with exact context", () => {
  const source = "alpha\nbeta\ngamma\n";
  const patch = [
    "@@ -1,3 +1,4 @@",
    " alpha",
    "-beta",
    "+bravo",
    "+between",
    " gamma",
  ].join("\n");
  assert.deepEqual(applyUnifiedPatch(source, patch), {
    content: "alpha\nbravo\nbetween\ngamma\n",
    hunksApplied: 1,
    linesAdded: 2,
    linesDeleted: 1,
  });
  assert.throws(() => applyUnifiedPatch("changed\nbeta\ngamma\n", patch), /context mismatch/u);
});

test("applyUnifiedPatch preserves CRLF and BOM", () => {
  const result = applyUnifiedPatch("\ufeffa\r\nb\r\n", "@@ -1,2 +1,2 @@\n a\n-b\n+c");
  assert.equal(result.content, "\ufeffa\r\nc\r\n");
});

test("remote text commands quote paths and enforce non-interactive atomic workflow", () => {
  const read = remoteReadTextCommand("/tmp/a file.txt", 1024);
  assert.match(read, /base64 -w 0/u);
  assert.match(read, /'\/tmp\/a file\.txt'/u);
  const write = remoteAtomicWriteCommand({ path: "/tmp/a file.txt", mode: "replace", expectedSha256: "a".repeat(64), afterSha256: "b".repeat(64), operationId: "00000000-0000-4000-8000-000000000001", preserveMetadata: true });
  assert.match(write, /flock -n 9/u);
  assert.match(write, /cp -p/u);
  assert.match(write, /mv -f/u);
  assert.match(write, /RESULT\|committed/u);
});
