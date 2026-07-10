# GitHub Copilot Integration

中文：Copilot/VS Code 场景优先使用 MCP 配置和文件回退。

English: Copilot and VS Code should prefer MCP configuration and file fallback.

## Startup

1. Read root `SKILL.md`.
2. Read `.agents/skills/AGENT_BOOT.md`.
3. If MCP is unavailable, read `<store>/generated/GLOBAL-CONTEXT.md`.

## Writeback

Fallback file:

```text
<store>/inbox/copilot.md
```

## Best Use

- Use shared memory for project facts, decisions, and handoff notes.
- Use editor-local context for the current file and diagnostics.
