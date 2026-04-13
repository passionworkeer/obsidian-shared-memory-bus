---
name: codex-shared-memory-v2
description: Codex optimized integration for the v2 shared memory bus
agent: codex
version: 2.0.0
generated-from: SKILL.md v2
---

# Codex — Shared Memory Bus Integration (v2)

This file extends `SKILL.md` (repo root) with Codex-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## MCP Configuration

```json
{
  "mcpServers": {
    "memory": {
      "transport": "http",
      "url": "http://127.0.0.1:9338/mcp"
    },
    "context7": {
      "transport": "http",
      "url": "http://127.0.0.1:9331/mcp"
    },
    "fetch": {
      "transport": "http",
      "url": "http://127.0.0.1:9332/mcp"
    },
    "time": {
      "transport": "http",
      "url": "http://127.0.0.1:9333/mcp"
    },
    "sequential-thinking": {
      "transport": "http",
      "url": "http://127.0.0.1:9334/mcp"
    },
    "obsidian": {
      "transport": "http",
      "url": "http://127.0.0.1:9335/mcp"
    }
  }
}
```

---

## Session Start (Required)

At session start, call `memory_boot` for context injection:

```
Tool: memory_boot
project: obsidian-shared-memory-bus
```

Returns: `global.md` content + top-20 recent project facts. No full file reads needed.

**If MCP is unavailable** (fallback): read `E:\.ai-memory\CONTEXT.md` directly.

---

## Memory Store

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux)

| Path | Purpose |
|------|---------|
| `global.md` | Permanent user facts (~100 tokens) |
| `projects/{project}.jsonl` | LLM-extracted structured facts |
| `CONTEXT.md` | Auto-generated summary (passive agents read this) |
| `inbox/codex.md` | Cross-session writeback (fallback) |

---

## Token Budget

- **Default session**: `memory_boot` (~2000 tokens max)
- **Deep investigation**: `memory_search` over project facts + `memory_boot`
- Codex sessions are typically short — no full `CONTEXT.md` needed on quick queries

**Rule: Do not let memory retrieval exceed 10% of available context budget.**
