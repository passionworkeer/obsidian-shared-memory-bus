# Agents · 团队目录

> 给多 agent 协作用的项目级脚手架。本目录**只放 markdown + YAML frontmatter**，零代码依赖。

## 结构

```
.agents/
├── skills/                       # 工具特定的接入 skill (已有)
│   ├── AGENT_BOOT.md             # 通用启动协议
│   ├── claude-code.md            # Claude Code 接入
│   ├── codex.md                  # Codex 接入
│   ├── copilot.md                # GitHub Copilot 接入
│   ├── cursor.md                 # Cursor 接入
│   ├── opencode.md               # OpenCode 接入
│   └── trae.md                   # Trae 接入
├── workflows/                    # 跨工具可复用工作流定义 (新)
│   ├── shared-memory-triage.md   # 记忆分层决策
│   ├── test-runner.md            # 测试执行 + 失败定位
│   ├── debt-audit.md             # 技术债审计
│   └── release-notes.md          # 发版说明生成
├── roles/                        # 角色定义 (新, 给 subagent 派活)
│   ├── memory-curator.md
│   ├── retrieval-tuner.md
│   ├── docs-writer.md
│   └── test-engineer.md
└── README.md                     # 本文件
```

## 用法

### Skill (工具特定)
每个支持的 AI 工具在启动时读 `.agents/skills/<tool>.md` 拿到接入步骤。

### Workflow (跨工具)
任何 agent 收到 "处理 X" 类请求时, **先查 `.agents/workflows/`** 看有没有现成工作流:
- 收到 "处理这条 memory" → 读 `shared-memory-triage.md`
- 收到 "跑测试" → 读 `test-runner.md`
- 收到 "审计技术债" → 读 `debt-audit.md`
- 收到 "写发版说明" → 读 `release-notes.md`

### Role (派 subagent)
复杂任务拆 subagent 时, 给每个 subagent 一个 `.agents/roles/<role>.md` 作为 prompt 上下文。

## 扩展约定

- 新加 skill: `.agents/skills/<tool>.md`, frontmatter 含 `tool_name` + `version`
- 新加 workflow: `.agents/workflows/<action>.md`, frontmatter 含 `name` + `inputs/outputs` schema
- 新加 role: `.agents/roles/<persona>.md`, frontmatter 含 `name` + `responsibilities[]` + `tools[]`

## 设计原则

- **零依赖**：纯 markdown, 任何 agent 都能解析, 无需 build / install
- **可粘贴**：每个文件自包含, 可以复制给其他项目
- **可版本化**：所有文件进 git, 变更走 PR 流程
- **可观测**：执行结果写回 `~/.ai-memory/structured/`, 跨会话可审计

## 维护

- 不在 `.agents/` 放代码 (`*.js` / `*.ps1` / `*.py`)
- 不在 `.agents/` 放密钥 / 内部 URL
- 修改后跑一次 `test-runner` 工作流验证 schema 仍然合法

---

<p align="right"><sub>📖 配合 <a href="../../docs/AGENTS.md">docs/AGENTS.md</a> 读效果最佳</sub></p>