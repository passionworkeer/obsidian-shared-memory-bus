---
name: cursor-shared-memory
description: Cursor optimized integration for the Obsidian shared memory bus
agent: cursor
version: 1.0.0
generated-from: SKILL.md
---

# Cursor — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with Cursor-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## Cursor Skill Metadata

```yaml
name: cursor-shared-memory
agent: cursor
mcp_server: memory (port 9338)
mcp_server: obsidian (port 9335)
mcp_server: context7 (port 9331)
mcp_server: fetch (port 9332)
mcp_server: time (port 9333)
mcp_server: sequential-thinking (port 9334)
```

---

## Vault Path Resolution

**Resolution order:**
1. `AI_MEMORY_OBSIDIAN_VAULT` environment variable
2. `OBSIDIAN_VAULT_ROOT` environment variable
3. Obsidian app config detection
4. Default fallback

Cursor uses `.cursor/rules/` for project-specific rules.

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/cursor.md` and exit with error.

---

## Startup Behavior

Cursor does not have a native session compaction system.
At workspace open, read `GLOBAL-CONTEXT.md` or call `memory_wake_up`:

```
Tool: memory_wake_up
max_items: 5
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
    "obsidian": {
      "transport": "http",
      "url": "http://127.0.0.1:9335/mcp"
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

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/cursor.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: cursor` block.

---

## Token Budget

- **File-focused session**: `memory_wake_up max_items=3` (project context only)
- **Deep session**: `memory_wake_up max_items=5` + `GLOBAL-CONTEXT.md`

Cursor sessions are often file-focused. Use `route=project` to limit recall to relevant memories and avoid token waste.

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

If both are empty and Obsidian config is not found, write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/cursor.md`.
