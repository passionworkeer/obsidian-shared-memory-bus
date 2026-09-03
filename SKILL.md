---
name: yt-memory-bus
description: Chinese-first universal skill for joining yt from any AI coding tool.
version: 3.1.0
---

# yt Universal Skill

> 中文优先：让 Codex、Claude Code、Cursor、Copilot、OpenCode、Trae 等 AI 工具共享同一个本地记忆层。
>
> English: A local-first shared memory layer for AI coding tools.

## 一句话 / One Sentence

中文：不要再给每个 AI 工具重复解释项目上下文；让它们通过本地 `.ai-memory` store 和共享 MCP 端点读写同一份记忆。

English: Stop repeating context to every AI tool; let them read and write one local memory store through shared MCP endpoints.

## 启动顺序 / Startup Order

1. Resolve the memory store.
2. Read generated context when it exists.
3. Use `memory_wake_up` or `memory_boot` through MCP when port `9338` is available.
4. Read `.agents/skills/AGENT_BOOT.md`.
5. Read the matching per-tool file under `.agents/skills/`.

## Store Resolution

Resolve the shared store in this order:

1. `AI_MEMORY_STORE`
2. `AI_MEMORY_STORE_ROOT`
3. platform default:
   - Windows: best detected local store, commonly `E:\.ai-memory` or `%USERPROFILE%\.ai-memory`
   - macOS/Linux: `~/.ai-memory`

Verify from this repository:

```bash
node scripts/store-detect.js
```

Important: the current canonical store is `.ai-memory`. Obsidian can be a companion knowledge app, but Obsidian is not required for the memory bus.

## Read Protocol

Prefer MCP when available:

```text
memory_wake_up(project="<project-name>")
memory_boot(project="<project-name>")
search_shared_memory(query="<what you need>")
```

File fallback when MCP is unavailable:

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
<store>/generated/HANDOFF.json
```

If none of those files exist, continue without shared memory and report the missing store or missing generated artifacts.

## Write Protocol

Preferred write path:

```text
memory_write(...)
```

Manual fallback:

```text
<store>/inbox/<agent>.md
```

Use short, durable notes:

```markdown
## Agent: codex

- 2026-06-12 18:30 Project decision: Local AI Memory Bus promotion is Chinese-first bilingual, with English mirrored.
```

Do not write:

- secrets, API keys, passwords, tokens, cookies, private keys;
- raw chat logs that include sensitive data;
- large generated output that belongs in a project file instead.

## MCP Endpoints

Default shared endpoints:

| Service | Port | Use |
| --- | ---: | --- |
| memory | 9338 | shared memory, retrieval, status |
| context7 | 9331 | docs/code context |
| fetch | 9332 | web fetch utility |
| time | 9333 | time/date utility |
| sequential-thinking | 9334 | reasoning helper |
| obsidian | 9335 | optional Obsidian bridge |
| playwright | 9337 | browser automation with session isolation |

## Human Quick Start

Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

macOS/Linux:

```bash
./scripts/install.sh -WorkspaceRoot "$(pwd)"
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## Agent Rule

When a task has two or more independent slices, prefer multi-agent or subagent decomposition if the host supports it. Keep desktop/UI-bound tools isolated and share only safe local services.

## Companion Skill: user-portrait

`skills/user-portrait/` builds the user's personal profile from local agent logs and imported WeChat/QQ chats, writing `<store>/portrait/PROFILE.md` (P2 privacy) plus a pointer into `<store>/inbox/user-portrait.md`. When the user asks to 生成/更新个人画像 or wants assistants to 更了解我, follow `skills/user-portrait/SKILL.md`.
