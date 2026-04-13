---
name: claude-code-shared-memory-v2
description: Claude Code optimized integration for the v2 shared memory bus
agent: claude-code
version: 2.0.0
generated-from: SKILL.md v2
---

# Claude Code — Shared Memory Bus Integration (v2)

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).
No Obsidian dependency.

## Session Start (Pick One)

**Option A — MCP available** (port 9338):
```
Tool: memory_boot
project: obsidian-shared-memory-bus
```
Returns: global.md content + top-20 project facts. (~2000 tokens)

**Option B — No MCP** (fallback):
```
Read: E:\.ai-memory\CONTEXT.md
```
Auto-generated summary, < 500 tokens.

## Memory Write

Stop Hook auto-writes extracted facts — no manual write needed.

Manual fallback only:
```
E:\.ai-memory\inbox\claude-code.md
```

## Token Budget

| Session Type | Memory Action | Est. Tokens |
|---|---|---|
| Quick (< 30 min) | CONTEXT.md only | ~500 |
| Medium session | memory_boot | ~2000 |
| Deep investigation | memory_boot + memory_search | ~3000 |

**Rule: Memory reads must stay under 15% of available context budget.**

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

## Stop Hook

Registered in `~/.claude/settings.json`:
```json
"hooks": {
  "Stop": {
    "command": ["node", "E:/desktop/obsidian-shared-memory-bus/hooks/stop-hook-llm-extract/stop-extract.mjs"],
    "timeout": 30000
  }
}
```
