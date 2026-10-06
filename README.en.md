<h1 align="center">dsh-ssh-operator</h1>

<p align="center">Operate WSL and remote Linux hosts safely from DSH through system OpenSSH</p>
<p align="center">Bundle 23 SSH Operator MCP tools with matching Skill guidance</p>
<p align="center">Keep Windows work local and route Linux work through structured SSH</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-orange" alt="Version 0.1.0" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen" alt="Node.js >= 24" />
</p>

<p align="center"><a href="README.md">简体中文</a> | <strong>English</strong></p>

<p align="center">
  <a href="#installation">Installation</a> · <a href="#configuration">Configuration</a> · <a href="#development">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

## Features

- Discover and diagnose concrete aliases from the Windows OpenSSH config.
- Execute remote commands or stream Bash/POSIX shell scripts over standard input.
- Stat, hash, upload, atomically upload, and download individual files with overwrite disabled by default.
- Start, read, stop, and close managed remote processes.
- Optionally persist process logs and reconcile jobs with identity checks after abnormal shutdowns.
- Probe passwordless sudo passively and keep non-interactive elevation behind explicit tools.
- Register a lifecycle-scoped `ssh-operator` Skill that guides safe composition of the MCP tools.

The plugin exposes 23 `mcp__ssh_operator__*` tools through DSH's first-party `@deepseek-ai/dsh-mcp-client`. The bundled server starts system OpenSSH directly with `shell: false`, so remote scripts do not cross a PowerShell quoting layer.

## Compatibility

- Targets the DSH 0.2 series. See each [GitHub Release](https://github.com/Huo-yang/dsh-ssh-operator/releases) for the exact DSH version and behavior actually verified.
- Requires Node.js 24 or later at runtime; local development uses pnpm 11.19.
- The current control plane targets Windows and requires system `ssh.exe` and `scp.exe`.
- `%USERPROFILE%\.ssh\config` must contain concrete aliases with keys and host fingerprints already configured.
- SSH connections must work non-interactively with `BatchMode=yes`.

## Installation

### Install from a GitHub Release

Download these files from [`v0.1.0`](https://github.com/Huo-yang/dsh-ssh-operator/releases/tag/v0.1.0) without extracting the archive:

```text
dsh-ssh-operator-0.1.0.tgz
SHA256SUMS.txt
```

Verify SHA-256 and install the versioned archive:

```powershell
Get-FileHash -Algorithm SHA256 "C:\Downloads\dsh-ssh-operator-0.1.0.tgz"
dsh plugin --profile web add "C:\Downloads\dsh-ssh-operator-0.1.0.tgz"
```

### Install from the source directory

```powershell
cd "D:\CodeSpace\personal\DSH_Plugin\dsh-ssh-operator"
pnpm install --frozen-lockfile
pnpm run check
dsh plugin --profile web add "D:\CodeSpace\personal\DSH_Plugin\dsh-ssh-operator"
```

Fully exit and restart DSH after installation. The tool catalog should contain names such as `mcp__ssh_operator__ssh_list_hosts`, and the Skill catalog should contain `ssh-operator`.

## Configuration

| Setting | Default | Meaning |
|---|---:|---|
| `serverName` | `ssh_operator` | MCP tool namespace |
| `toolCallTimeoutMs` | `120000` | Timeout for one MCP tool call |
| `failOnStartupError` | `false` | Do not block DSH startup when the first MCP connection fails |

Restart DSH after configuration changes or linked-source updates. DSH's first-party MCP client owns reconnection after a transport loss.

## Safety boundaries

- Hosts are concrete SSH aliases, not arbitrary local shell fragments.
- Local processes are spawned directly; no PowerShell, `cmd.exe`, or other local command shell is invoked.
- The plugin stores no SSH passwords, private keys, or complete SSH configuration.
- Transfers refuse overwrite by default; atomic upload verifies SHA-256 before publication.
- Timeout, cancellation, transport loss, and remote exit are distinct outcomes.
- Persisted logs are plaintext and may contain sensitive output; enable them only when needed and delete them explicitly.
- Recovery validates a unique process token instead of killing by PID alone.
- Sudo tools always use `sudo -n`, never accept or transmit a password, and never edit remote sudoers; ordinary tools remain unprivileged.

The bundled runtime is synchronized from `ssh-operator-mcp v0.15.0` at commit `c9c11324cd6f7134059cb2db8912673dca35f3df`.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
pnpm run release:prepare -- v0.1.0
```

See the [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md), and [release](docs/RELEASING.md) notes for maintenance details.

## Uninstall

```powershell
dsh plugin --profile web remove dsh-ssh-operator
```

Uninstalling removes the Bundle, embedded Skill, and MCP tools together. The plugin creates no credential file. Opt-in persisted process logs and recovery state are deliberately retained; inspect them before any manual cleanup.

## License

This project is licensed under the [MIT License](LICENSE). The bundled SSH Operator MCP is an independently maintained implementation; see its source documentation for design acknowledgements.
