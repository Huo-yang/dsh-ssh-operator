# Architecture

`dsh-ssh-operator` has two runtime layers:

1. `lib/index.js` is the Cordis/DSH plugin entry. It registers the packaged `ssh-operator` Skill, resolves the packaged server path, supplies Windows `PROGRAMDATA`, and activates DSH's official MCP client bridge.
2. `lib/server.js` is a self-contained stdio MCP server bundled from `src/server`. It owns OpenSSH commands, explicit non-interactive sudo, transfers, managed processes, durable recovery state, and optional logs.

The split deliberately keeps MCP protocol adaptation in DSH and SSH behavior in the existing implementation. DSH owns tool discovery, scoped registration, cancellation, timeouts, and reconnection. The server keeps its stable 30-tool protocol and does not depend on DSH internals.

The public namespace is `ssh_operator`, producing `mcp__ssh_operator__<raw-tool-name>`. The underscore avoids ambiguity in DSH's server-name validation and remains stable across upgrades.

The Skill is registered directly on `ctx.skills`, so its lifecycle matches the bundle. It is not copied into a user directory and cannot remain behind after uninstalling the plugin.

Generated `lib/` files are not maintained source. Run `pnpm run build` after source changes.

The v0.2.0 release vendors the canonical `ssh-operator-mcp v0.18.1` source at commit `e8c5d9d78bd0162abd11d899ac2d4f9690a210cc`. Future runtime updates must synchronize `src/server`, `tests/unit`, the packaged Skill, the exact smoke-test inventory, and this provenance marker together.
