import assert from "node:assert/strict";
import test from "node:test";
import {
  compareEnvironmentSnapshots,
  contextualizeCommand,
  ENV_PROBE_END,
  ENV_PROBE_START,
  parseEnvironmentProbe,
  validateEnvironmentOverrides,
} from "../../src/server/execution-context.js";

test("default context leaves a command unchanged when no environment override is supplied", () => {
  assert.equal(contextualizeCommand("printf ok", "default", {}), "printf ok");
});

test("environment overrides quote values and support explicit unsets", () => {
  assert.equal(
    contextualizeCommand("env", "default", { FOO: "a b'c", HTTPS_PROXY: null }),
    `export FOO='a b'"'"'c'; unset HTTPS_PROXY; env`,
  );
});

test("environment validation rejects unsafe names, NUL, and excessive entries", () => {
  assert.throws(() => validateEnvironmentOverrides({ "BAD-NAME": "x" }));
  assert.throws(() => validateEnvironmentOverrides({ OK: "x\0y" }));
  assert.throws(() => validateEnvironmentOverrides(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`V${index}`, "x"]))));
});

test("login and interactive modes invoke the configured remote shell without a PTY", () => {
  assert.match(contextualizeCommand("printf ok", "login", {}), /"\$ssh_operator_shell" -lc 'printf ok'/u);
  assert.match(contextualizeCommand("printf ok", "interactive", {}), /"\$ssh_operator_shell" -ic 'printf ok'/u);
  assert.match(contextualizeCommand("printf ok", "login", {}), /\$\{SHELL:-\/bin\/sh\}/u);
});

test("probe parsing exposes proxy metadata but not proxy values", () => {
  const encode = (value: string) => Buffer.from(value).toString("base64");
  const secretProxy = "http://user:secret@example.invalid:8080";
  const stdout = [
    "startup line\n",
    `\x1e${ENV_PROBE_START}\x1f\n`,
    `identity.user|${encode("huoyang")}\n`,
    `identity.shell|${encode("/usr/bin/zsh")}\n`,
    `identity.cwd|${encode("/home/huoyang")}\n`,
    `environment.path|${encode("/usr/bin:/bin")}\n`,
    `environment.HTTPS_PROXY|set:${encode(secretProxy)}\n`,
    "init..zshrc|present:true\n",
    `\x1e${ENV_PROBE_END}\x1f\n`,
  ].join("");
  const snapshot = parseEnvironmentProbe("interactive", stdout, "warning\n");
  assert.equal(snapshot.proxy.HTTPS_PROXY.present, true);
  assert.equal(snapshot.proxy.HTTPS_PROXY.length, secretProxy.length);
  assert.equal(snapshot.initFiles[".zshrc"].readable, true);
  assert.equal(snapshot.startupNoise.stdoutBytes, Buffer.byteLength("startup line\n"));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/u);
});

test("snapshot comparison detects PATH and proxy differences", () => {
  const marker = (path: string, proxy: string) => {
    const encode = (value: string) => Buffer.from(value).toString("base64");
    return `\x1e${ENV_PROBE_START}\x1f\nidentity.user|${encode("u")}\nidentity.shell|${encode("/bin/sh")}\nidentity.cwd|${encode("/tmp")}\nenvironment.path|${encode(path)}\nenvironment.HTTP_PROXY|${proxy ? `set:${encode(proxy)}` : "unset:"}\n\x1e${ENV_PROBE_END}\x1f\n`;
  };
  const comparisons = compareEnvironmentSnapshots([
    parseEnvironmentProbe("default", marker("/bin", ""), ""),
    parseEnvironmentProbe("login", marker("/usr/bin:/bin", "proxy"), ""),
  ]);
  assert.equal(comparisons[0].pathChanged, true);
  assert.equal(comparisons[0].proxyChanged.HTTP_PROXY, true);
});
