# Architecture

`dsh-ssh-operator` has two runtime layers:

1. `lib/index.js` is the minimal Cordis/DSH host entry. It only registers the packaged `ssh-operator` Skill.
2. `cordis.patch.yml` mounts the official `@deepseek-ai/dsh-mcp-client` supplied by the active DSH installation and starts the exported `@huo-yang/dsh-ssh-operator/server` entry over stdio.
3. `lib/server.js` is a self-contained stdio MCP server bundled from `src/server`. It owns OpenSSH commands, explicit non-interactive sudo, transfers, managed processes, durable recovery state, and optional logs.

This carrier layout keeps MCP protocol adaptation in DSH and SSH behavior in the bundled server. The host does not import DSH internal packages and declares no runtime peer on them, so a DSH cache refresh cannot leave the plugin pointing at stale package junctions. DSH owns tool discovery, scoped registration, cancellation, timeouts, and reconnection.

The public namespace is `ssh_operator`, producing `mcp__ssh_operator__<raw-tool-name>`. The underscore avoids ambiguity in DSH's server-name validation and remains stable across upgrades.

The Skill is registered directly on `ctx.skills`, so its lifecycle matches the bundle. It is not copied into a user directory and cannot remain behind after uninstalling the plugin.

Generated `lib/` files are not maintained source. Run `pnpm run build` after source changes.

The v0.3.0 release vendors the canonical `ssh-operator-mcp v0.18.2` source at commit `fb5eecc6df4728e83a96f37bd38f865a5350ec4f`. Future runtime updates must synchronize `src/server`, `tests/unit`, the packaged Skill, the exact smoke-test inventory, and this provenance marker together.
