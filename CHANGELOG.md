# 更新记录 / Changelog

## [Unreleased]

## [0.2.2] - 2026-10-16

### 修复 / Fixed

- 将所有声明 `host` 的工具 schema 标记为必须显式传入主机别名，并在内嵌 Skill 中增加硬规则与正反示例，减少模型偶发漏传目标主机导致的重试。
- Mark every tool schema that declares `host` as requiring an explicit alias, and add a hard rule plus positive/negative examples to the bundled Skill to reduce retries caused by occasional omitted targets.
- 精确说明例外：本地 `ssh_doctor` 可不传 `host`；只接受 `processId` 或无需参数的进程、日志和恢复工具不得虚构 `host`。
- Document the exact exceptions: local `ssh_doctor` may omit `host`, while process-ID, log, and recovery tools must not receive an invented one.

## [0.2.1] - 2026-10-11

### 新增 / Added

- 为 DSH 插件列表提供中文和英文名称及简介，并随 DSH 当前语言切换。
- Add Chinese and English plugin titles and descriptions that follow the active DSH locale.

### 文档 / Documentation

- 明确 `serverName` 应保持稳定，另外两个运行参数只适合作为高级设置。
- Clarify that `serverName` should stay stable while the other two runtime controls belong in advanced settings.

## [0.2.0] - 2026-10-11

### 新增 / Added

- 同步 `ssh-operator-mcp v0.18.1`，将 MCP 工具集从 23 个扩展到 30 个。
- Synchronize `ssh-operator-mcp v0.18.1`, expanding the MCP tool set from 23 to 30 tools.
- 新增带哈希并发保护和幂等操作凭据的远端文本读取、补丁及原子写入。
- Add remote text reading, patching, and atomic writes with hash-based concurrency checks and durable idempotency receipts.
- 新增默认、登录和交互 shell 上下文、远端环境探测、目录树浏览与文本搜索。
- Add default, login, and interactive shell contexts, remote environment probing, tree discovery, and text search.

### 变更 / Changed

- 将 MCP 工具注册拆分为执行与工作区模块，同时保持公开工具名称不变。
- Modularize MCP tool registration into execution and workspace layers without changing public tool names.

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
