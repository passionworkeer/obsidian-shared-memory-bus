---
name: cursor-shared-memory
description: Cursor optimized integration for the v2 shared memory bus
agent: cursor
version: 2.0.0
generated-from: SKILL.md v2
---

# Cursor — Shared Memory Bus Integration (v2)

Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).
No Obsidian dependency.

This file extends `SKILL.md` (repo root) with Cursor-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## Cursor Skill Metadata

```yaml
name: cursor-shared-memory
agent: cursor
mcp_server: memory (port 9338)
mcp_server: context7 (port 9331)
mcp_server: fetch (port 9332)
mcp_server: time (port 9333)
mcp_server: sequential-thinking (port 9334)
```

---

## Store Path Resolution

**Resolution order:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` environment variable
2. `AI_MEMORY_ROOT/.ai-memory` (if AI_MEMORY_ROOT is set)
3. Auto-detect best available drive (Windows: D-Z scan, min 2GB free)
4. Platform default:
   - Windows: `E:\.ai-memory`
   - macOS: `~/Library/Application Support/.ai-memory`
   - Linux: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`

Cursor uses `.cursor/rules/` for project-specific rules.

**If resolution fails:** Write `"STORE_RESOLUTION_FAILED"` to first line of `inbox/cursor.md` and exit with error.

---

## Session Start

Cursor does not have a native session compaction system.
At workspace open, read `CONTEXT.md` or call `memory_boot`:

```
Tool: memory_boot
project: <current-project-name>
route: project   (prioritize project-relevant memories)
```

Use `route=project` to surface memories relevant to the current workspace.

---

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

---

## Rule File Setup

For project-level rules, add to `.cursor/rules/`:

```
shared-memory.md  →  reference to <repo-root>/SKILL.md
```

---

## Memory Write

No native Stop Hook — write manually to the inbox fallback:

```
<store-root>/inbox/cursor.md
```

**Preferred:** Configure a Stop Hook for auto-extraction if available.

---

## Token Budget

- **File-focused session**: `memory_boot` with `max_items=3` (project context only)
- **Deep session**: `memory_boot` with `max_items=5`

Cursor sessions are often file-focused. Use `route=project` to limit recall to relevant memories and avoid token waste.

---

## Store Path Resolution Check

**Verification command:**
```bash
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
echo $AI_MEMORY_STORE
```

If resolution fails, write `"STORE_RESOLUTION_FAILED"` to first line of `inbox/cursor.md`.
