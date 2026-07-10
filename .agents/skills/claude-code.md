# Claude Code Integration

中文：Claude Code 可把这个文件作为项目级 skill/规则入口。

English: Claude Code can use this file as the project-level skill/rule entry.

## Startup

1. Read root `SKILL.md`.
2. Read `.agents/skills/AGENT_BOOT.md`.
3. Call `memory_wake_up(project="obsidian-shared-memory-bus")` when the memory MCP is configured.

## Writeback

Fallback file:

```text
<store>/inbox/claude-code.md
```

## Notes

- Keep local tool memory separate from shared memory.
- Promote only durable project facts to the shared store.
- Never write secrets or raw credentials.
