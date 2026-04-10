---
name: codex-shared-memory
description: Codex optimized integration for the Obsidian shared memory bus
agent: codex
version: 1.0.0
generated-from: SKILL.md
---

# Codex — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with Codex-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## Codex Skill Metadata

```yaml
name: codex-shared-memory
agent: codex
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

Codex does not have a native session compaction hook. All memory flows through MCP.

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/codex.md` and exit with error.

---

## Startup Behavior

Codex does not have a native session memory compaction system.
At session start, call `memory_wake_up` for fast context bootstrap:

```
Tool: memory_wake_up
max_items: 3
prefer_summaries: true   (keeps token usage under 3000)
```

This avoids Codex reading the full `GLOBAL-CONTEXT.md` (~8000 chars) on every start.

---

## MCP Configuration

Add to `~/.codex/config.json` or the equivalent MCP settings:

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

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/codex.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: codex` block. Never touch other agent blocks.

---

## Token Budget

- **Default session**: `memory_wake_up preferSummaries=true` (~3000 tokens max)
- **Deep investigation**: Full canonical order + `GLOBAL-CONTEXT.md`
- Codex sessions are typically shorter — avoid full `GLOBAL-CONTEXT.md` on quick queries

**Rule: Do not let memory retrieval exceed 10% of your available context budget.**

---

## Skill File Location

Place the portable skill reference in Codex's skill directory:
```
~/.codex/skills/shared-memory.md  →  reference to SKILL.md at repo root
~/.codex/rules/shared-memory.md   →  rule overlay
```

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

If both are empty and Obsidian config is not found, write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/codex.md`.
