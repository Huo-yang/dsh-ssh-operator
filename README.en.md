# dsh-ssh-operator

An SSH operations plugin for DSH 0.2. It packages `ssh-operator-mcp v0.15.0`, uses DSH's first-party `@deepseek-ai/dsh-mcp-client` bridge to expose 23 `mcp__ssh_operator__*` tools, and registers an embedded `ssh-operator` Skill.

[中文](README.md)

## Features

- Discover and diagnose concrete aliases from the Windows OpenSSH config.
- Execute remote commands or stream Bash/POSIX shell scripts over standard input.
- Stat, hash, upload, atomically upload, and download individual files with overwrite disabled by default.
- Start, read, stop, and close managed remote processes.
- Optionally persist process logs and safely reconcile jobs after abnormal shutdowns.
- Probe passwordless sudo passively and keep elevation explicit through non-interactive `ssh_sudo_exec` and `ssh_sudo_run_script` tools.
- Register lifecycle-scoped guidance for choosing and safely composing the SSH tools.

The bundled server starts system OpenSSH directly with `shell: false`. It stores no passwords, private keys, or complete SSH configuration.

## Requirements and installation

Use DSH `0.2.0-rc.2`, Node.js 24, and pnpm 11.19. Ensure `ssh.exe` and `scp.exe` are available and that configured aliases work non-interactively with `BatchMode=yes`.

```powershell
pnpm install
pnpm run check
dsh plugin --profile web add D:/CodeSpace/personal/DSH_Plugin/dsh-ssh-operator
```

Restart DSH after installation. The model tool inventory should include names such as `mcp__ssh_operator__ssh_list_hosts`, and the Skill catalog should include `ssh-operator`. Both are removed with the plugin; no file is copied into `~/.dsh/skills`.

## Safety boundaries

- Hosts are concrete SSH aliases, not arbitrary local shell fragments.
- Local processes are spawned directly; no PowerShell or `cmd.exe` shell is invoked.
- Transfers refuse overwrite by default; atomic upload verifies SHA-256 before publication.
- Timeout, cancellation, transport loss, and remote exit are distinct outcomes.
- Persisted logs are plaintext and opt-in.
- Recovery validates a unique process token instead of killing by PID alone.
- Sudo tools always use `sudo -n`, never accept a password, and never edit remote sudoers.

The bundled runtime is synchronized from `ssh-operator-mcp v0.15.0` at commit `c9c11324cd6f7134059cb2db8912673dca35f3df`.

See [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md), and [release](docs/RELEASING.md) notes for maintenance details.

## License

MIT
