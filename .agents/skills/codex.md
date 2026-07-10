# Codex Integration

中文：Codex 启动时先读根 `SKILL.md`，再读 `.agents/skills/AGENT_BOOT.md`。

English: Codex should read root `SKILL.md`, then `.agents/skills/AGENT_BOOT.md`.

## Startup

1. Resolve the store with `node scripts/store-detect.js`.
2. Use `memory_wake_up(project="obsidian-shared-memory-bus")` if MCP port `9338` is available.
3. Use file fallback under `<store>/generated/` if MCP is unavailable.

## Writeback

Prefer MCP `memory_write`. Fallback:

```text
<store>/inbox/codex.md
```

## Working Style

- For two or more independent slices, use subagents when available.
- Before editing core symbols, follow repository GitNexus impact-analysis rules.
- Keep final user-facing notes Chinese-first when the user writes Chinese.
