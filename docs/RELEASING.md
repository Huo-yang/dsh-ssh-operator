# 发布流程 / Releasing

GitHub Releases 是正式安装包的唯一分发渠道。`package.json` 版本、`vX.Y.Z` 标签和 GitHub Release 必须一致；公开后不得移动标签、重建版本或覆盖同名资产。每个版本保留 `release/X.Y.Z` 分支。

## 发布前

1. 从 `main` 创建 `release/X.Y.Z`，更新版本、`CHANGELOG.md` 和中英文 README。
2. 执行完整检查：

   ```powershell
   pnpm install --frozen-lockfile
   pnpm peers check
   pnpm run check
   pnpm run release:prepare -- vX.Y.Z
   git diff --check
   npm pack --dry-run --json --ignore-scripts
   ```

3. 核对 `dist/` 中的版本化 tgz、`SHA256SUMS.txt` 和 `release-manifest.json`，确认包内没有本地状态、凭据或无关文件。
4. 使用全新的隔离 `DSH_HOME` 和 profile 从 tgz 安装，验证 Bundle、Skill、MCP 工具加载和卸载。远程执行只使用合成配置，不连接或修改真实主机。
5. 提交并推送，通过 Pull Request 合入 `main`，等待 Windows 与 Ubuntu CI 全部通过。

## 发布

确认 `release/X.Y.Z`、合并后的目标提交和版本内容正确，再在目标提交创建并推送 `vX.Y.Z` 标签。标签触发的 Release workflow 是 GitHub Release 的唯一创建者；不要同时手工创建 Release。

workflow 会重新安装锁定依赖、运行检查、校验标签与包版本、生成三个资产并创建 Release。Release 说明必须包含 DSH 实测版本、Bundle/Skill/MCP 验证范围、安装命令、权威 SHA-256 和已知要求。

## 发布后验证

从 GitHub Release 重新下载三个公开资产，而不是复用本地构建结果：

1. 核对文件名和数量。
2. 重新计算 tgz SHA-256，并与 `SHA256SUMS.txt`、`release-manifest.json` 对照。
3. 在新的隔离 `DSH_HOME` 和 profile 中安装下载的 tgz，再次验证 Bundle、Skill、全部 MCP 工具和卸载。
4. 确认 Release 非 Draft，Prerelease 状态符合版本性质，`release/X.Y.Z` 分支仍存在。

本地与 CI 生成的 tgz 可能因归档元数据而具有不同哈希；公开权威值始终以 GitHub Release 最终资产为准。发布后若发现问题，发布新的 patch 版本。
