---
name: copilot-shared-memory-v2
description: GitHub Copilot optimized integration for the v2 shared memory bus
agent: copilot
version: 2.0.0
generated-from: SKILL.md v2
---

# GitHub Copilot — Shared Memory Bus Integration (v2)

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).
No Obsidian dependency.

## Important Limitation

Copilot has no native session memory system and no environment variable injection.
Memory integration relies entirely on MCP calls. If MCP is unavailable, memory reads are not possible.

## Session Start

**If MCP available** (port 9338):
```
Tool: memory_boot
project: obsidian-shared-memory-bus
```

## Memory Write

No native writeback — rely on Claude Code / Trae Stop Hook for auto-extraction.
Copilot can write manually to `E:\.ai-memory\inbox\copilot.md` as a fallback.

## Token Budget (Strict)

Copilot has the most constrained budget. Follow strictly:
- Call `memory_boot` only at session start or when switching to a new significant task
- Never call on every keystroke
- Budget cap: memory calls must not exceed 5% of available context

**Rule: If in doubt, skip memory retrieval rather than risk context overflow.**

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
    }
  }
}
```
