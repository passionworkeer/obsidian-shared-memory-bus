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

不要再给每个 AI 工具重复解释项目上下文；让它们通过 canonical `.ai-memory` store 和共享 MCP 端点读写同一份记忆。

## 启动顺序 / Startup Order

1. Resolve the canonical memory store.
2. Read generated context when it exists.
3. Use `memory_wake_up` or `memory_boot` through MCP.
4. Read `.agents/skills/AGENT_BOOT.md`.
5. Read the matching per-tool file under `.agents/skills/`.

## Store Resolution

Resolve the shared store in this order:

1. `AI_MEMORY_STORE`
2. `AI_MEMORY_STORE_ROOT`
3. An existing `<Obsidian vault>/00-System/ai-memory` bridge
4. `AI_MEMORY_ROOT` as a legacy fallback
5. `~/.ai-memory`

Verify from this repository:

```bash
node scripts/store-detect.js
```

Obsidian is optional. When an Obsidian vault already contains `00-System/ai-memory`, that directory becomes the canonical store automatically.

## Read Protocol

Prefer the read-only retrieval MCP service on port `9338`:

```text
memory_wake_up(workspace_root="<absolute-workspace-path>")
memory_boot(project="<project-name>")
search_shared_memory(query="<what you need>", route="auto")
```

`memory_wake_up` accepts `workspace_root`, not `project`.

File fallback when MCP is unavailable:

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
<store>/generated/HANDOFF.json
```

If none of those files exist, continue without shared memory and report the missing store or generated artifacts.

## Write Protocol

Use `memory_write` from the management MCP service on port `9341`.

A successful write creates a schema-valid V2 record in:

```text
<store>/structured/shared-inbox.jsonl
```

For compatibility with older passive tools, it also writes a same-ID projection to:

```text
<store>/projects/<project>.jsonl
```

Manual fallback:

```text
<store>/inbox/<agent>.md
```

Use short, durable notes. Do not write secrets, API keys, passwords, tokens, cookies, private keys, raw sensitive transcripts, or large generated output.

## MCP Endpoints

| Service | Port | Use |
| --- | ---: | --- |
| context7 | 9331 | docs/code context |
| fetch | 9332 | web fetch utility |
| time | 9333 | time/date utility |
| sequential-thinking | 9334 | reasoning helper |
| obsidian | 9335 | optional Obsidian bridge |
| playwright | 9337 | optional browser automation |
| memory-retrieval | 9338 | read-only memory retrieval and status |
| memory-bridge | 9339 | Claude Mem and OpenClaw bridge |
| memory-dream | 9340 | rebuild, embeddings, and consolidation |
| memory-mgmt | 9341 | canonical writes, runtime management, and KG queries |

## Human Quick Start

Windows:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
pwsh -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

macOS/Linux:

```bash
./scripts/install.sh -WorkspaceRoot "$(pwd)"
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## Agent Rule

When a task has two or more independent slices, prefer multi-agent or subagent decomposition if the host supports it. Keep desktop/UI-bound tools isolated and share only safe local services.
