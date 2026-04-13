---
name: openclaw-shared-memory-v2
description: OpenClaw optimized integration for the v2 shared memory bus
agent: openclaw
version: 2.0.0
generated-from: SKILL.md v2
---

# OpenClaw — Shared Memory Bus Integration (v2)

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).
No Obsidian dependency.

## Session Start

**If MCP available** (port 9338):
```
Tool: memory_boot
project: obsidian-shared-memory-bus
```

**Fallback** (no MCP):
```
Read: E:\.ai-memory\CONTEXT.md
```

OpenClaw's native task layer (`blackboard`) remains the primary task memory source.

## Memory Write

Stop Hook auto-writes extracted facts — no manual write needed.

Manual fallback:
```
E:\.ai-memory\inbox\openclaw.md
```

## Token Budget

| Session Type | Memory Action | Est. Tokens |
|---|---|---|
| Quick session | CONTEXT.md only | ~500 |
| Standard session | memory_boot | ~2000 |
| Cron job handoff | memory_boot + memory_search | ~3000 |

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
