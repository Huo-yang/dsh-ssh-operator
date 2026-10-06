<h1 align="center">dsh-ssh-operator</h1>

<p align="center">让 DSH 通过系统 OpenSSH 安全操作 WSL 与远端 Linux 主机</p>
<p align="center">内置 23 个 SSH Operator MCP 工具，并提供配套 Skill 操作指引</p>
<p align="center">Windows 工作留在本机，Linux 工作通过结构化 SSH 执行</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-orange" alt="Version 0.1.0" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-brightgreen" alt="Node.js >= 24" />
</p>

<p align="center"><strong>简体中文</strong> | <a href="README.en.md">English</a></p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#配置">配置</a> · <a href="#开发">开发</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a> · <a href="CHANGELOG.md">更新记录</a>
</p>

## 功能

- 枚举和诊断 Windows OpenSSH 配置中的具体主机别名。
- 执行远端命令，或通过标准输入发送 Bash/POSIX shell 脚本。
- 查询、哈希、上传、原子上传和下载单个文件；覆盖默认关闭。
- 启动、读取、停止和关闭受管远端进程。
- 可选持久化进程日志，并在异常退出后执行带身份校验的恢复。
- 使用 `ssh_sudo_probe` 被动检查免密 sudo；仅通过显式工具执行非交互提权。
- 注册生命周期与插件一致的 `ssh-operator` Skill，指导模型安全组合 MCP 工具。

插件通过 DSH 官方 `@deepseek-ai/dsh-mcp-client` 暴露 23 个 `mcp__ssh_operator__*` 工具。内置服务直接以 `shell: false` 启动系统 OpenSSH，远端脚本不会经过 PowerShell 引号层。

## 兼容性

- 面向 DSH 0.2 系列；实际验证版本和覆盖范围见对应 [GitHub Release](https://github.com/Huo-yang/dsh-ssh-operator/releases)。
- 运行时要求 Node.js 24 或更高版本；本地开发使用 pnpm 11.19。
- 当前控制端面向 Windows，需要系统 `ssh.exe` 和 `scp.exe`。
- `%USERPROFILE%\.ssh\config` 中应已有具体主机别名，并完成密钥与主机指纹配置。
- SSH 连接必须能在 `BatchMode=yes` 下非交互工作。

## 安装

### 从 GitHub Release 安装

从 [`v0.1.0`](https://github.com/Huo-yang/dsh-ssh-operator/releases/tag/v0.1.0) 下载以下文件，无需解压：

```text
dsh-ssh-operator-0.1.0.tgz
SHA256SUMS.txt
```

核对 SHA-256 后安装版本化归档：

```powershell
Get-FileHash -Algorithm SHA256 "C:\Downloads\dsh-ssh-operator-0.1.0.tgz"
dsh plugin --profile web add "C:\Downloads\dsh-ssh-operator-0.1.0.tgz"
```

### 从源码目录安装

```powershell
cd "D:\CodeSpace\personal\DSH_Plugin\dsh-ssh-operator"
pnpm install --frozen-lockfile
pnpm run check
dsh plugin --profile web add "D:\CodeSpace\personal\DSH_Plugin\dsh-ssh-operator"
```

安装后完全退出并重新启动 DSH。工具目录应出现 `mcp__ssh_operator__ssh_list_hosts` 等工具，Skill 目录应出现 `ssh-operator`。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `serverName` | `ssh_operator` | MCP 工具命名空间 |
| `toolCallTimeoutMs` | `120000` | 单次 MCP 工具调用超时 |
| `failOnStartupError` | `false` | 首次 MCP 连接失败时不阻止 DSH 启动 |

配置变化和链接源码更新均需重启 DSH 才能可靠生效。MCP 断开后的重连由 DSH 官方 MCP 客户端管理。

## 安全边界

- 主机参数只能是 SSH 配置中的具体别名，不能作为任意本地 shell 片段。
- 本地程序直接启动，不调用 PowerShell、`cmd.exe` 或其他本地命令 shell。
- 插件不保存 SSH 密码、私钥或完整 SSH 配置。
- 上传和下载默认拒绝覆盖；原子上传先校验 SHA-256，再在同目录发布。
- 超时、取消、传输失败和远端退出分别报告。
- 持久日志是明文，可能包含敏感输出；仅在确有需要时启用并显式删除。
- 恢复清理会校验远端进程身份 token，不按 PID 强制误杀。
- sudo 工具固定使用 `sudo -n`，不接受或传输密码，也不会修改远端 sudoers；普通工具始终保持非特权。

内置运行时同步自 `ssh-operator-mcp v0.15.0`（提交 `c9c11324cd6f7134059cb2db8912673dca35f3df`）。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
pnpm run release:prepare -- v0.1.0
```

维护说明见 [架构](docs/ARCHITECTURE.md)、[测试](docs/TESTING.md)和[发布](docs/RELEASING.md)文档。

## 卸载

```powershell
dsh plugin --profile web remove dsh-ssh-operator
```

卸载会同时移除 Bundle、内嵌 Skill 和 MCP 工具。插件不创建凭据文件；已选择持久化的进程日志和恢复状态会保留，手工清理前应先确认内容是否仍有价值。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。内置 SSH Operator MCP 为本项目维护的独立实现；其设计参考来源见相关源码说明。
