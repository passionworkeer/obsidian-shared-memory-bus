# Shared Memory Bus Agent Boot

中文：这是所有 AI 工具接入 yt 的最小启动协议。

English: This is the minimum startup protocol for any AI tool joining yt.

## 1. Identify The Project

Use the repository name or working directory as the project name. For this repository, use:

```text
obsidian-shared-memory-bus
```

## 2. Resolve The Store

Run when terminal access is available:

```bash
node scripts/store-detect.js
```

If the command is unavailable, resolve manually:

1. `AI_MEMORY_STORE`
2. `AI_MEMORY_STORE_ROOT`
3. `%USERPROFILE%\.ai-memory` on Windows
4. `~/.ai-memory` on macOS/Linux

## 3. Read Shared Context

Prefer MCP:

```text
memory_wake_up(project="obsidian-shared-memory-bus")
```

Then search when needed:

```text
search_shared_memory(query="<specific question>", route="auto")
```

File fallback:

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
<store>/generated/HANDOFF.json
```

If no generated files exist, continue and say that shared memory is not initialized yet.

## 4. Write Durable Notes

Use MCP `memory_write` when available.

Fallback file:

```text
<store>/inbox/<agent>.md
```

Append concise facts only. Keep each note under 500 characters.

## 5. Safety Rules

- Never store secrets, keys, tokens, cookies, passwords, or private identifiers.
- Do not copy whole transcripts into memory.
- Do not treat generated summaries as more authoritative than project files.
- If memory conflicts with repository files, trust the repository and mention the conflict.

## 6. Missing MCP Behavior

If `memory` MCP is unavailable:

1. Use file fallback.
2. Continue the task.
3. Report the missing MCP endpoint in the final status.

Do not block ordinary coding work only because memory MCP is offline.
