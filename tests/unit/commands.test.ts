import assert from "node:assert/strict";
import test from "node:test";
import {
  baseSshArgs,
  buildManagedRemoteCommand,
  buildManagedSudoRemoteCommand,
  buildManagedScriptCommand,
  buildManagedSudoScriptCommand,
  buildRemoteCommand,
  buildScriptCommand,
  remoteSpec,
  shellQuote,
  validateHostAlias,
} from "../../src/server/commands.js";

test("shellQuote preserves spaces and embedded apostrophes", () => {
  assert.equal(shellQuote("a b'c"), `'a b'"'"'c'`);
});

test("buildRemoteCommand quotes only the working directory", () => {
  assert.equal(
    buildRemoteCommand('printf "%s\\n" "$HOME"', "/home/user/My Project"),
    `cd -- '/home/user/My Project' && printf "%s\\n" "$HOME"`,
  );
});

test("buildManagedRemoteCommand emits PID and exit markers", () => {
  const command = buildManagedRemoteCommand("sleep 10", "/tmp/work");
  assert.match(command, /SSH_OPERATOR_PID=/u);
  assert.match(command, /SSH_OPERATOR_EXIT=/u);
  assert.match(command, /\(\nsleep 10\n\)/u);
});

test("buildScriptCommand passes arguments as remote shell literals", () => {
  assert.equal(
    buildScriptCommand("bash", ["plain", "has space", "it's"], "/tmp/work"),
    `cd -- '/tmp/work' && exec bash -s -- 'plain' 'has space' 'it'"'"'s'`,
  );
});

test("buildManagedScriptCommand emits PID and exit markers around the interpreter", () => {
  const command = buildManagedScriptCommand("bash", ["has space"], "/tmp/work");
  assert.match(command, /SSH_OPERATOR_PID=/u);
  assert.match(command, /bash -s -- 'has space'/u);
  assert.match(command, /SSH_OPERATOR_EXIT=/u);
});

test("sudo command uses non-interactive sudo and preserves the command as one shell argument", () => {
  const command = buildManagedSudoRemoteCommand("printf '%s\\n' \"$HOME\"", "/tmp/work");
  assert.match(command, /sudo -n -- sh -c/u);
  assert.match(command, /printf '"'"'%s\\n'"'"' "\$HOME"/u);
  assert.match(command, /SSH_OPERATOR_EXIT=/u);
});

test("sudo script uses non-interactive sudo without putting script content in the command", () => {
  const command = buildManagedSudoScriptCommand("bash", ["has space"], "/tmp/work");
  assert.match(command, /sudo -n -- bash -s -- 'has space'/u);
  assert.doesNotMatch(command, /script contents/u);
  assert.match(command, /SSH_OPERATOR_EXIT=/u);
});

test("host aliases exclude shell metacharacters", () => {
  assert.equal(validateHostAlias("wsl-ubuntu"), "wsl-ubuntu");
  assert.throws(() => validateHostAlias("user@host"));
  assert.throws(() => validateHostAlias("host;whoami"));
});

test("baseSshArgs always supplies an explicit SSH config", () => {
  const args = baseSshArgs("wsl-ubuntu");
  assert.equal(args[0], "-F");
  assert.match(args[1], /[\\/]\.ssh[\\/]config$/u);
  assert.equal(args.at(-1), "wsl-ubuntu");
});

test("remoteSpec requires a concrete host and absolute remote path", () => {
  assert.equal(remoteSpec("wsl-ubuntu", "/tmp/a file.txt"), "wsl-ubuntu:/tmp/a file.txt");
  assert.throws(() => remoteSpec("wsl-ubuntu", "relative.txt"));
  assert.throws(() => remoteSpec("bad;host", "/tmp/file"));
});

