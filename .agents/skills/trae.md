# Trae Integration

中文：Trae 可通过 AGENTS.md 或项目规则读取本文件，并继承统一启动协议。

English: Trae can read this file through AGENTS.md or project rules and inherit the shared boot protocol.

## Startup

1. Read root `SKILL.md`.
2. Read `.agents/skills/AGENT_BOOT.md`.
3. Use memory MCP when configured, otherwise use generated file fallback.

## Writeback

Fallback file:

```text
<store>/inbox/trae.md
```

## Best Use

- Use shared memory for cross-session continuity.
- Keep UI/editor state separate from durable project facts.
