# 贡献指南 / Contributing

使用 Node.js 24 和项目固定的 pnpm 11.19：

```powershell
pnpm install --frozen-lockfile
pnpm run check
```

保持 DSH 桥接层与 SSH 服务层职责分离。SSH 工具的名称、schema、安全边界或持久化格式发生变化时，必须同步测试和中英文文档。不要提交密钥、令牌、真实 SSH 配置、进程日志或机器专属状态。

新功能使用 `feature/<name>` 分支，缺陷修复使用 `fix/<name>` 分支，并通过 Pull Request 合入 `main`。PR 应说明问题、结果和验证命令；Windows 与 Ubuntu CI 均通过后，优先使用正常 merge commit 合并。发布准备使用并保留 `release/X.Y.Z` 分支；不得重写 `main`、移动已发布标签或覆盖同名 Release 资产。

Keep the DSH bridge separate from the SSH server. Changes to tool names, schemas, safety boundaries, or durable formats require tests and bilingual documentation updates. Never commit credentials, real SSH configuration, process logs, or machine-specific state.

Use `feature/<name>` branches for features and `fix/<name>` branches for fixes, then merge through a Pull Request. Describe the problem, result, and verification commands in the PR; wait for both Windows and Ubuntu CI, and prefer a normal merge commit. Prepare and retain releases on `release/X.Y.Z` branches. Never rewrite `main`, move a published tag, or replace an existing Release asset.
