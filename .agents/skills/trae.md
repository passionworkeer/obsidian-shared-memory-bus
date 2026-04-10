---
name: trae-shared-memory
description: Trae optimized integration for the Obsidian shared memory bus
agent: trae
version: 1.0.0
generated-from: SKILL.md
---

# Trae — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with Trae-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## Trae Skill Metadata

```yaml
name: trae-shared-memory
agent: trae
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

Trae writes user rules to `~/.trae/user_rules.md` and project rules to `<project>/.trae/rules/project_rules.md`.

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/trae.md` and exit with error.

---

## Startup Behavior

Trae does not have a native session memory compaction system.
At workspace open, call `memory_wake_up` for compact bootstrap:

```
Tool: memory_wake_up
max_items: 3   (compact — Trae sessions are typically IDE-bound and short)
```

---

## MCP Configuration

Trae supports MCP servers via its settings UI. Add these as HTTP MCP servers:

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

Add to Trae's user rules or project rules:
```
Reference: <repo-root>/SKILL.md
```

For project-level rules, create `<project>/.trae/rules/project_rules.md` with a pointer to `SKILL.md`.

---

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/trae.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: trae` block.

---

## Token Budget

- **IDE-bound session**: `memory_wake_up max_items=3` (compact bootstrap)
- **Long investigation**: `memory_wake_up max_items=5` + `GLOBAL-CONTEXT.md`

**Rule: Trae sessions are typically short and file-focused. Keep memory retrieval under 5% of context budget.**

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

If both are empty and Obsidian config is not found, write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/trae.md`.
