# Changelog

## 0.1.0 - 2026-10-06

- Package the 23-tool `ssh-operator-mcp v0.15.0` runtime as a DSH 0.2 bundle.
- Include explicit non-interactive sudo capability probing, command execution, and script execution while keeping ordinary tools unprivileged.
- Register tools through the first-party DSH MCP client under the stable `ssh_operator` namespace.
- Add standard build, typecheck, unit-test, documentation, and release workflows.
- Register the packaged `ssh-operator` Skill through the DSH Skill registry with plugin-scoped lifecycle.
- Mark the runtime Skill with the required `bundled` source so DSH can validate and load its body.
