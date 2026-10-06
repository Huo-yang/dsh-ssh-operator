---
name: ssh-operator
description: Operate WSL and remote Linux hosts through the ssh-operator MCP tools while keeping Windows-native tasks on the local host.
---

# SSH Operator

Use the `ssh-operator` MCP server for work that belongs on a configured Linux SSH host. Keep Windows services, applications, registry, and Windows-only filesystem work on the local Windows host.

- Discover aliases with `ssh_list_hosts` and verify a target with `ssh_probe` when its current identity or environment matters.
- Use `ssh_doctor` when diagnosing local OpenSSH/config/state readiness or determining which optional capabilities a host actually provides. It is passive and does not change SSH configuration.
- Use `ssh_exec` for a concise command that should be interpreted by the remote login shell.
- Use `ssh_run_script` for variables, loops, pipelines, redirection, multi-step work, or substantial quoting. Script contents travel over SSH stdin and do not enter the Windows command line.
- Keep ordinary work unprivileged. When root access is actually required, use `ssh_sudo_probe` first, then `ssh_sudo_exec` or `ssh_sudo_run_script`. These tools require remote passwordless sudo, always use `sudo -n`, and never accept or transmit a password.
- Treat `SUDO_AUTH_REQUIRED` as a missing non-interactive sudo grant and `SUDO_POLICY_DENIED` as a sudoers policy refusal. Do not work around either by putting a password in commands, scripts, environment variables, or logs.
- Use `ssh_upload` and `ssh_download` for a single file. They refuse to overwrite by default; set `overwrite=true` only when replacement is intended.
- Use `ssh_stat` and `ssh_hash` to inspect or verify remote files. Prefer `ssh_upload_atomic` for deployment artifacts so bytes are verified before same-directory atomic publication; overwrite remains opt-in.
- For long-running commands or incremental logs, use `ssh_start_process`, then poll `ssh_read_process_output` with its returned cursor. Stop an unneeded running process before closing its record.
- Set `persistOutput=true` only when logs must outlive the memory buffer or MCP restart; treat persisted output as plaintext sensitive data, page it with `ssh_read_process_log`, and delete it when no longer needed.
- Use `ssh_list_recovery_records` when diagnosing jobs left by an abnormal MCP or Codex shutdown; identity-mismatch failures require manual inspection and must not be force-cleaned by PID alone.
- When a recovery record is marked detached after an unconfirmed remote exit, verify connectivity and use `ssh_reconcile_processes` to retry identity-checked cleanup.
- Use an explicit remote `cwd` when commands depend on a project directory.
- Do not install missing remote components or change SSH connectivity unless the user requested it.
- Treat each host as independent: verify paths, tools, credentials, and runtime state instead of transferring assumptions between WSL and other servers.
- Use `errorCode`, `phase`, and `retryable` on failed tool results to distinguish validation, authentication, reachability, remote-command, transfer, cleanup, state, and log failures.
- Review `storageDiagnostics` from doctor, recovery-record, or process-log tools when a schema migration or corruption quarantine occurs. Quarantined files are preserved for manual inspection and may contain sensitive state or output; do not delete them without explicit user direction.
- When tools appear missing after an upgrade, distinguish user-level configuration from the current conversation's captured inventory. Use the project's `npm run verify` for a fresh handshake; existing conversations may require a Codex restart and a new local conversation.
