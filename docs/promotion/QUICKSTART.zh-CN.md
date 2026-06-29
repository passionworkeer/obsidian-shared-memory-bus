# yt 快速开始

> 让 Codex、Claude Code、Cursor、Copilot、OpenCode、Trae 共享同一份本地记忆。

## 适合谁

如果你经常在多个 AI 编程工具之间切换，并且反复解释：

- 这个项目在做什么；
- 当前任务做到哪一步；
- 哪些决定已经讨论过；
- 哪些坑不要再踩；

这个项目就是为你准备的。

## 30 秒理解

yt 做三件事：

1. 把长期记忆放在本地 `.ai-memory` store。
2. 通过共享 MCP 端点给多个 AI 工具读取和检索。
3. 用 agent skill/rules 告诉每个工具怎么加入同一套记忆协议。

## 安装

Windows:

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

macOS / Linux:

```bash
npm install
./scripts/install.sh -WorkspaceRoot "$(pwd)"
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## 让 AI 工具加入

让你的 AI 工具读取：

```text
SKILL.md
.agents/skills/AGENT_BOOT.md
.agents/skills/<tool>.md
```

示例：

```text
.agents/skills/codex.md
.agents/skills/claude-code.md
.agents/skills/copilot.md
```

## 验证成功

检查 store：

```bash
node scripts/store-detect.js
```

检查 MCP：

```text
memory_status()
```

如果 MCP 暂时不可用，AI 工具仍然可以读取：

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
```

## 对外介绍一句话

中文：

> yt 是一个本地优先的 AI 记忆总线，让多个 AI 编程工具共享上下文、检索历史决策，并在工具之间顺滑交接任务。

英文：

> yt is a local-first shared memory layer that lets multiple AI coding tools share context, retrieve past decisions, and hand off work across tools.

## 下一步

- 读根入口：`SKILL.md`
- 读架构：`docs/ARCHITECTURE.md`
- 读推广长文：`docs/promotion/POST.zh-CN.md`
- 看视频分镜：`docs/promotion/VIDEO-STORYBOARD.zh-CN.md`
