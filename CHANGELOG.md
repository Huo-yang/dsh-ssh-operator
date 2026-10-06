# 更新记录 / Changelog

## [Unreleased]

### 变更 / Changed

- 按统一仓库契约整理 Release 优先安装说明、双语文档、测试目录和 GitHub 协作模板。
- Align release-first installation guidance, bilingual documentation, the test layout, and GitHub collaboration templates with the shared repository contract.
- Release workflow 不再覆盖已经发布的同名 Release 或资产。
- The Release workflow no longer overwrites an existing Release or its assets.

## [0.1.0] - 2026-10-06

### 新增 / Added

- 将包含 23 个工具的 `ssh-operator-mcp v0.15.0` 打包为 DSH 0.2 Bundle。
- Package the 23-tool `ssh-operator-mcp v0.15.0` runtime as a DSH 0.2 Bundle.
- 提供显式非交互 sudo 能力探测、命令执行和脚本执行，同时保持普通工具非特权。
- Add explicit non-interactive sudo probing, command execution, and script execution while ordinary tools remain unprivileged.
- 通过 DSH 官方 MCP 客户端注册稳定的 `mcp__ssh_operator__*` 工具命名空间。
- Register the stable `mcp__ssh_operator__*` namespace through DSH's first-party MCP client.
- 注册随插件生命周期启停的 `ssh-operator` Skill。
- Register an embedded `ssh-operator` Skill with plugin-scoped lifecycle.
