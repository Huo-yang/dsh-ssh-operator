import assert from "node:assert/strict";
import test from "node:test";
import { commonFields } from "../../src/server/tool-schemas.js";

test("shared host schema marks the alias as explicitly required", () => {
  const description = commonFields.host.description ?? "";
  assert.match(description, /^REQUIRED\./);
  assert.match(description, /never omit/i);
  assert.equal(commonFields.host.safeParse(undefined).success, false);
});
