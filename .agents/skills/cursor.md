# Cursor Integration

中文：Cursor 接入时把共享记忆当作长期上下文，把当前编辑器状态当作短期上下文。

English: Cursor should treat shared memory as durable context and editor state as live context.

## Startup

1. Read root `SKILL.md`.
2. Read `.agents/skills/AGENT_BOOT.md`.
3. Use MCP `memory_wake_up` or file fallback.

## Writeback

Fallback file:

```text
<store>/inbox/cursor.md
```

## Best Use

- Search memory before broad refactors.
- Keep code edits grounded in repository files.
- Do not store private snippets unless they are already intended as project facts.
