# 我做了一个本地 AI 记忆总线：让多个 AI 编程工具共享上下文

## 标题备选

1. 我不想再给每个 AI 工具重复解释项目了，所以做了 Local AI Memory Bus
2. Codex、Claude Code、Cursor、Copilot 能不能共享同一份记忆？
3. 给 AI 编程工具做一个本地优先的共享记忆层

## 开场

如果你同时使用多个 AI 编程工具，大概率遇到过这个问题：

今天用 Codex 梳理了架构，明天切到 Claude Code 写实现，又要重新解释一遍项目背景；在 Cursor 里修 bug，Copilot 不知道前面已经排除过哪些方案；过几天回来，所有工具都像第一次见到这个项目。

我想要的不是再做一个聊天记录归档，而是一个“本地的 AI 记忆总线”：所有工具都能读同一个上下文、检索同一批历史决策、把任务交接给下一个工具。

## 它解决什么

Local AI Memory Bus 解决三个核心问题：

- 重复解释：多个工具共享项目背景和关键决策。
- 任务断点：一个工具做完的 handoff，另一个工具能接着做。
- 本地优先：记忆数据放在本地 `.ai-memory`，不是绑定某个 SaaS。

## 它怎么工作

架构分成几层：

1. AI 客户端层：Codex、Claude Code、Cursor、Copilot、OpenCode、Trae。
2. 共享 MCP 层：memory、fetch、time、context7、playwright 等本地端点。
3. 检索层：BM25 + 向量检索 + hybrid rerank。
4. 本地数据层：`.ai-memory` store，保存 structured JSONL、generated context、knowledge graph 和 embeddings。
5. Agent Pack：每个工具读取同一套 `SKILL.md` / `.agents/skills` 协议。

## 为什么不是只用一个工具自带的 memory

单工具 memory 很有用，但它天然困在一个工具里。

这个项目的目标是跨工具：

- Codex 读得到 Claude Code 留下的项目事实。
- Cursor 能搜索之前 OpenCode 写入的决策。
- Copilot 可以通过 MCP 或文件回退读取同一个上下文。

也就是说，记忆不属于某个工具，而属于你的本地开发环境。

## 快速体验

Windows:

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
```

macOS / Linux:

```bash
npm install
./scripts/install.sh -WorkspaceRoot "$(pwd)"
```

然后让 AI 工具读取：

```text
SKILL.md
.agents/skills/AGENT_BOOT.md
.agents/skills/codex.md
```

## 适合什么人

它目前更适合 power user：

- 同时使用多个 AI 编程工具；
- 愿意配置 MCP；
- 关心本地优先和可迁移性；
- 需要长期项目上下文，而不是一次性问答。

## 项目特色

- 本地 `.ai-memory` store 是事实源。
- MCP 是传输层，不是数据库。
- 默认本地 hash embedding，可离线运行。
- 支持 BM25、dense、hybrid 检索。
- 有 watchdog、handoff、memory layers、knowledge graph。
- 有可复制的 agent pack，不强依赖某个工具生态。

## 结尾

我把它理解成 AI 编程工具之间的“共享记忆底座”。

当工具越来越多，真正重要的不是每个工具都记一点，而是你的开发环境拥有一份可迁移、可检索、可审计的上下文。

项目入口：`README.md`

快速开始：`docs/promotion/QUICKSTART.zh-CN.md`
