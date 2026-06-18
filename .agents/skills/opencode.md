# OpenCode Integration

中文：OpenCode 使用共享 memory MCP 时，应把它当作跨工具上下文层，而不是替代项目文件。

English: OpenCode should use memory MCP as cross-tool context, not as a replacement for repository files.

## Startup

1. Read root `SKILL.md`.
2. Read `.agents/skills/AGENT_BOOT.md`.
3. Call `memory_wake_up(project="obsidian-shared-memory-bus")` when possible.

## Writeback

Fallback file:

```text
<store>/inbox/opencode.md
```

## Best Use

- Record durable decisions and task handoffs.
- Keep operational logs short and searchable.
- Avoid large generated dumps.
