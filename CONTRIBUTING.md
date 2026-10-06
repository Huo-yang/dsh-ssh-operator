# 贡献指南 / Contributing

使用 Node.js 24 和项目固定的 pnpm 11.19：

```powershell
pnpm install --frozen-lockfile
pnpm run check
```

保持 DSH 桥接层与 SSH 服务层职责分离。SSH 工具的名称、schema、安全边界或持久化格式发生变化时，必须同步测试和中英文文档。不要提交密钥、令牌、真实 SSH 配置、进程日志或机器专属状态。

Keep the DSH bridge separate from the SSH server. Changes to tool names, schemas, safety boundaries, or durable formats require tests and bilingual documentation updates. Never commit credentials, real SSH configuration, process logs, or machine-specific state.
