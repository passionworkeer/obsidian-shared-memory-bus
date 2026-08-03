# Shared Memory Bus Agent Boot

中文：这是所有 AI 工具接入 yt 的最小启动协议。

English: This is the minimum startup protocol for any AI tool joining yt.

## 1. Identify The Project

Use the repository name or working directory as the project name. For this repository:

```text
obsidian-shared-memory-bus
```

## 2. Resolve The Store

Run when terminal access is available:

```bash
node scripts/store-detect.js
```

Manual resolution order:

1. `AI_MEMORY_STORE`
2. `AI_MEMORY_STORE_ROOT`
3. Existing `<Obsidian vault>/00-System/ai-memory`
4. `AI_MEMORY_ROOT` as a legacy fallback
5. `~/.ai-memory`

## 3. Read Shared Context

Use the read-only retrieval service on port `9338`:

```text
memory_wake_up(workspace_root="<absolute-workspace-path>")
```

Then search when needed:

```text
search_shared_memory(query="<specific question>", route="auto")
```

`memory_wake_up` accepts `workspace_root`; do not pass a `project` argument to it.

File fallback:

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
<store>/generated/HANDOFF.json
```

If no generated files exist, continue and report that shared memory is not initialized yet.

## 4. Write Durable Notes

Use `memory_write` from the management service on port `9341`.

A successful call writes the canonical V2 record to:

```text
<store>/structured/shared-inbox.jsonl
```

A same-ID compatibility projection is also written to:

```text
<store>/projects/<project>.jsonl
```

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

If the relevant MCP service is unavailable:

1. Use the file fallback.
2. Continue the task.
3. Report the missing endpoint in the final status.

Do not block ordinary coding work only because shared memory is offline.
