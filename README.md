# dsh-ssh-operator

面向 DSH 0.2 的 SSH 操作插件。它内置 `ssh-operator-mcp v0.15.0`，通过 DSH 官方 `@deepseek-ai/dsh-mcp-client` 注册 23 个 `mcp__ssh_operator__*` 工具，并在 DSH Skill 注册表中提供 `ssh-operator` 操作指引。

[English](README.en.md)

## 能力

- 枚举与诊断 Windows OpenSSH 配置中的具体主机别名。
- 执行远端命令或通过标准输入发送 Bash/POSIX shell 脚本。
- 查询、哈希、上传、原子上传和下载单个文件；覆盖默认关闭。
- 启动、读取、停止和关闭受管远端进程。
- 可选持久化进程日志，以及异常退出后的身份校验恢复。
- 使用 `ssh_sudo_probe` 被动检查免密 sudo；仅通过显式的 `ssh_sudo_exec` / `ssh_sudo_run_script` 执行非交互提权，普通工具始终保持非特权。
- 内嵌 `ssh-operator` Skill，指导模型区分 Windows 本机工作与远端 Linux 工作，并安全组合 MCP 工具。

插件直接启动系统 OpenSSH，`shell: false`；远端脚本不经过 PowerShell 引号层。它不保存密码、私钥或完整 SSH 配置。

## 要求

- DSH `0.2.0-rc.2`，Node.js 24，pnpm 11.19。
- Windows 系统 `ssh.exe` / `scp.exe` 可用。
- `%USERPROFILE%\.ssh\config` 中已有可用的具体别名，并已完成密钥与主机指纹配置。
- 连接必须能在 `BatchMode=yes` 下非交互工作。

## 安装

```powershell
pnpm install
pnpm run check
dsh plugin --profile web add D:/CodeSpace/personal/DSH_Plugin/dsh-ssh-operator
```

安装后重启 DSH。模型工具列表应出现 `mcp__ssh_operator__ssh_list_hosts` 等工具，Skill 目录应出现 `ssh-operator`。Skill 与 MCP 随插件同时启用和卸载，不会复制文件到 `~/.dsh/skills`。

如需调整调用超时，可编辑 profile 中生成的插件配置；bundle 默认值为 120 秒。MCP 首次连接失败默认不会阻止 DSH 启动，工具会按 DSH MCP 客户端策略重连。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run release:prepare
```

工程结构：

```text
src/index.js          DSH Host 入口与 MCP 桥接装配
src/server/           内置 ssh-operator MCP TypeScript 源码
tests/unit/           SSH 核心单元测试
test/                 DSH bundle 约定测试
skill/ssh-operator/   可复用的操作指引
docs/                 架构、测试与发布说明
```

## 安全边界

- 主机参数只能是 SSH 配置中的具体别名，不能作为任意本地 shell 片段。
- 本地程序直接启动，不调用 PowerShell、`cmd.exe` 或其他本地命令 shell。
- 上传和下载默认拒绝覆盖；原子上传先校验 SHA-256，再在同目录发布。
- 超时、取消、传输失败和远端退出分别报告。
- 持久日志是明文，可能包含敏感输出；仅在确有需要时启用并显式删除。
- 恢复清理会校验远端进程身份 token，不按 PID 强制误杀。
- sudo 工具固定使用 `sudo -n`，不接受或传输密码，也不会修改远端 sudoers。

内置运行时同步自 `ssh-operator-mcp v0.15.0`（提交 `c9c11324cd6f7134059cb2db8912673dca35f3df`）。

## 许可证

MIT
