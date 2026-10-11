import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSearchOutput,
  parseTreeOutput,
  searchScriptArgs,
  treeScriptArgs,
  validateExcludeNames,
  validateGlobs,
} from "../../src/server/workspace-discovery.js";

test("tree arguments validate roots and exclusions while requesting one lookahead record", () => {
  assert.deepEqual(treeScriptArgs("/srv/app", 3, 20, 10, [".git"]), ["/srv/app", "3", "20", "11", ".git"]);
  assert.throws(() => treeScriptArgs("relative", 3, 0, 10, []));
  assert.throws(() => validateExcludeNames(["a/b"]));
});

test("tree records preserve unusual UTF-8 paths and classify file types", () => {
  const encoded = Buffer.from("目录/a|b.txt").toString("base64");
  assert.deepEqual(parseTreeOutput(`TREE|${encoded}|f|12|640|123.75\n`), [{
    path: "目录/a|b.txt", type: "file", size: 12, mode: "640", modifiedEpochSeconds: 123,
  }]);
});

test("search arguments keep patterns and globs out of shell syntax", () => {
  assert.deepEqual(searchScriptArgs({
    root: "/srv/app", query: "a'$(touch nope)", cursor: 0, limit: 20, maxFileSize: "1M", maxColumns: 500,
    fixedStrings: true, includeHidden: false, globs: ["*.ts"],
  }).at(-1), "a'$(touch nope)");
  assert.throws(() => validateGlobs(["bad\nglob"]));
});

test("ripgrep JSON parsing returns structured match locations", () => {
  const record = JSON.stringify({
    type: "match",
    data: {
      path: { text: "/srv/app/a.ts" },
      lines: { text: "const value = 42;\n" },
      line_number: 7,
      absolute_offset: 80,
      submatches: [{ match: { text: "value" }, start: 6, end: 11 }],
    },
  });
  assert.deepEqual(parseSearchOutput(`${record}\n`), [{
    path: "/srv/app/a.ts", line: 7, column: 7, columnByte: 7, text: "const value = 42;",
    submatches: [{ text: "value", startByte: 6, endByte: 11 }],
  }]);
});

test("search columns distinguish Unicode character and UTF-8 byte positions", () => {
  const record = JSON.stringify({
    type: "match",
    data: {
      path: { text: "/srv/app/a.txt" }, lines: { text: "中value\n" }, line_number: 1,
      submatches: [{ match: { text: "value" }, start: 3, end: 8 }],
    },
  });
  const [match] = parseSearchOutput(record);
  assert.equal(match.column, 2);
  assert.equal(match.columnByte, 4);
});
