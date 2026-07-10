---
name: AGENTS_DISPATCHER
description: 项目级 agent 调度器 - 任何 agent 进入项目时先读这个, 然后按任务路由到 skill/workflow/role
version: 1
---

# Agents Dispatcher · 调度器

> 项目根的 `AGENTS.md` 是 gitnexus 等工具**运行时注入**的代码情报层,
> **不要**改它。改 `docs/AGENTS.md` (项目规范) 或 `.agents/README.md` (本目录结构)。

## 当你 (agent) 收到一个任务时

按下面优先级路由:

### Step 1 · 是不是工具接入问题?

| 用户说 | 路由到 |
|--------|--------|
| "Claude Code 怎么接入?" | `.agents/skills/claude-code.md` |
| "Codex 启动步骤" | `.agents/skills/codex.md` |
| "怎么让 Cursor 用这个?" | `.agents/skills/cursor.md` |
| "通用启动" | `.agents/skills/AGENT_BOOT.md` |

### Step 2 · 是不是跨工具工作流?

| 用户说 | 路由到 |
|--------|--------|
| "处理这条 memory" / "promote 它" | `.agents/workflows/shared-memory-triage.md` |
| "跑测试" / "测试挂了" | `.agents/workflows/test-runner.md` |
| "审计技术债" / "找要重构的" | `.agents/workflows/debt-audit.md` |
| "写发版说明" / "release notes" | `.agents/workflows/release-notes.md` |

### Step 3 · 是不是需要派 subagent?

复杂任务 (≥ 2 个独立 slice) 时:

| 任务类型 | 派给 |
|---------|------|
| 记忆分层 / 去重 / 归档 | subagent with `.agents/roles/memory-curator.md` |
| 检索调优 / benchmark | subagent with `.agents/roles/retrieval-tuner.md` |
| 写文档 / 翻译 | subagent with `.agents/roles/docs-writer.md` |
| 补测试 / 修 flaky | subagent with `.agents/roles/test-engineer.md` |

### Step 4 · 都不匹配?

读 `docs/AGENTS.md` (项目规范) 自己判断, 或问用户。

---

## 硬规则 (任何 agent 都必须遵守)

1. **绝不**改 `~/.ai-memory/structured/` 的历史行 — append-only
2. **绝不**在 `bus/` 写同步 fs API — 必须 async / stream
3. **绝不**改 schema-registry.json 而不跑 generate-schemas.js
4. **绝不** push 到 main — 必须 PR 到 develop
5. **绝不**给用户报告 "测试通过" 但其实没跑 — 跑完把命令贴出来
6. **绝不**给已废弃代码加新功能 — 先 review `git log --oneline -- docs/PROJECT_AUDIT_*.md` 找最近审计报告

---

## 项目一句话 (TL;DR)

**yt** · 让多个 AI 工具共享同一个本地记忆。
技术栈: Node.js + Python + PowerShell · 主入口 MCP 服务器 · 跨语言 hash 等价。

## 必读

- `CLAUDE.md` · 分支 + 提交 + 代码规范
- `docs/ARCHITECTURE.md` · 系统架构
- 最近一次审计: 查 `docs/PROJECT_AUDIT_*.md` (e.g. `docs/PROJECT_AUDIT_2026-07-09.md`)