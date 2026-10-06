import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listConcreteHosts } from "../../src/server/ssh-config.js";

test("listConcreteHosts ignores patterns and negations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ssh-operator-test-"));
  const path = join(directory, "config");
  await writeFile(
    path,
    [
      "Host wsl-ubuntu yulong",
      "  User huoyang",
      "Host *.internal !blocked.internal",
      "Host ecs-prod",
      "Host wsl-ubuntu",
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(await listConcreteHosts(path), ["ecs-prod", "wsl-ubuntu", "yulong"]);
});

test("listConcreteHosts returns an empty list for a missing config", async () => {
  assert.deepEqual(await listConcreteHosts(join(tmpdir(), "missing-ssh-config")), []);
});

