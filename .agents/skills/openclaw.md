---
name: openclaw-shared-memory
description: OpenClaw optimized integration for the Obsidian shared memory bus
agent: openclaw
version: 1.0.0
generated-from: SKILL.md
---

# OpenClaw — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with OpenClaw-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## OpenClaw Skill Metadata

```yaml
name: openclaw-shared-memory
agent: openclaw
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

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/openclaw.md` and exit with error.

---

## OpenClaw-Native Memory Bridge

OpenClaw already has strong native memory:
- **Blackboard**: task state, issue tracking, PR status (`ops/obsidian-blackboard-daemon.js`)
- **Runs/Jobs**: subagent runs, cron jobs, journal entries
- **Sessions**: daily session logs

These are synced into the shared bus via `ops/sync-openclaw-to-obsidian.js`:

```
structured/openclaw-blackboard.jsonl   (task state)
structured/openclaw-runs.jsonl        (subagent runs)
structured/openclaw-jobs.jsonl        (cron jobs)
structured/openclaw-journal.jsonl      (journal entries)
structured/openclaw.jsonl             (sessions)
```

**Key principle**: The shared `memory` MCP **supplements** OpenClaw's native memory — it does not replace it.
OpenClaw's task memory remains the authoritative source for task state.

---

## Startup Behavior

At session start:
1. Read `memory_wake_up max_items=5` for cross-agent context
2. For cron job handoffs: also read `AUTO-DREAM.md` for durable promotion queue
3. OpenClaw's native task layer (`blackboard`) remains the primary task memory source

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
    }
  }
}
```

The OpenClaw blackboard MCP stays isolated (it manages its own state).

---

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/openclaw.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: openclaw` block.

---

## Token Budget

- **Quick session**: `memory_wake_up max_items=5`
- **Cron job handoff**: Full chain — `GLOBAL-CONTEXT.md` + `AUTO-DREAM.md` + `HANDOFF.md`
- OpenClaw sessions can be very long; use full context for cross-agent handoffs

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

If both are empty and Obsidian config is not found, write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/openclaw.md`.
