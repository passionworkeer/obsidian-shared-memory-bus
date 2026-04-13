---
name: trae-shared-memory-v2
description: Trae optimized integration for the v2 shared memory bus
agent: trae
version: 2.0.0
generated-from: SKILL.md v2
---

# Trae — Shared Memory Bus Integration (v2)

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).
No Obsidian dependency.

## Session Start (Required)

**Read before substantive work:**
```
E:\.ai-memory\CONTEXT.md
```
This single file answers "who am I" — no Obsidian files needed.

**If MCP is available** (port 9338):
```
Tool: memory_boot
project: obsidian-shared-memory-bus
```
For richer context on longer sessions.

## Memory Write

Stop Hook auto-writes extracted facts — no manual write needed.

Manual fallback:
```
E:\.ai-memory\inbox\trae.md
```

## Token Budget

Trae sessions are typically short and IDE-bound.
- Quick query: CONTEXT.md only (~500 tokens)
- Long investigation: memory_boot (~2000 tokens)

**Rule: Keep memory retrieval under 10% of available context budget.**

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
    }
  }
}
```
