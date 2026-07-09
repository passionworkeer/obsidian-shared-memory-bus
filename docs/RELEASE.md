# 发布流程 (Release Process)

> 状态:**手动发布**。`v3.1.0` 之前由 `.github/workflows/release.yml` + `changelogen` 自动完成;自仓库由 `obsidian-shared-memory-bus` 重命名为 `yt` 后,changelogen 与 CHANGELOG.md 标题格式不兼容,该 workflow 已停用。本文档说明现行手动流程。

## 前提

- 所有待发布的 commit 已在 `main` 分支(经 PR 合并、CI 全绿)
- 已与 `develop` 同步(若使用 Git Flow 分层)
- `package.json` 中的 `version` 已 bump 到目标版本号(`MAJOR.MINOR.PATCH`,遵循 semver.org)

## 发布步骤

```bash
# 1. 切到 main,确保与 origin 同步
git checkout main
git pull --rebase origin main

# 2. 跑测试和 lint
npm test
npm run lint

# 3. 在 CHANGELOG.md 顶部添加新版本段(Keep-a-Changelog 风格)
#    标题格式: ## [3.1.0] - 2026-07-08
#    子段: ### Added / ### Changed / ### Fixed / ### Removed

# 4. 提交 CHANGELOG
git add CHANGELOG.md
git commit -m "docs(changelog): 3.1.0 发布说明"

# 5. 打 tag(annotated tag,带说明)
git tag -a v3.1.0 -m "Release v3.1.0"

# 6. 推送 main 和 tag
git push origin main
git push origin v3.1.0

# 7. 在 GitHub UI 创建 Release
#    https://github.com/passionworkeer/obsidian-shared-memory-bus/releases/new
#    - 选择刚 push 的 tag
#    - Title: v3.1.0
#    - Body: 复制 CHANGELOG.md 中对应版本的段落
#    - 勾选 "Set as the latest release"
```

## 预发布版本 (alpha / beta / rc)

带 `-alpha.N` / `-beta.N` / `-rc.N` 后缀的版本会自动被 npm publish 标记为 pre-release。在 tag 名后追加后缀即可,例如:

```bash
git tag -a v3.2.0-beta.1 -m "Release v3.2.0-beta.1"
git push origin v3.2.0-beta.1
```

## 为什么不自动化

| 阻碍 | 说明 |
|---|---|
| `changelogen` 与当前 CHANGELOG.md 标题格式不兼容 | `changelogen` 要求 `## [VERSION] - DATE` 段标题,当前 CHANGELOG 用 `## YYYY-MM-DD` 日期段 |
| `v3.1.0` tag 从未打 | 历史 tag 在重命名仓库前未同步,自动化工具无法重建 |
| 仓库重命名后的发布权限 | `actions/checkout` + `softprops/action-gh-release` 依赖默认 `GITHUB_TOKEN`,重命名后需重新配置 publish 凭据 |

权衡:手动流程更直观、易审查、零外部依赖;每月 1-2 次发布的工作量可控。如需恢复自动化,优先修复 CHANGELOG.md Keep-a-Changelog 化(见 `docs/PROJECT_AUDIT_2026-07-09.md` §4.1 D-CRIT-4)。

## 参考

- 语义化版本: https://semver.org/
- Keep-a-Changelog: https://keepachangelog.com/zh-CN/1.1.0/
- 当前审计报告: `docs/PROJECT_AUDIT_2026-07-09.md`