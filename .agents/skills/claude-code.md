---
name: claude-code-shared-memory
description: Claude Code optimized integration for the Obsidian shared memory bus
agent: claude-code
version: 1.0.0
generated-from: SKILL.md
---

# Claude Code — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with Claude Code-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## Claude Code Skill Metadata

```yaml
name: claude-code-shared-memory
agent: claude-code
mcp_server: memory (port 9338)
mcp_server: obsidian (port 9335)
mcp_server: context7 (port 9331)
mcp_server: fetch (port 9332)
mcp_server: time (port 9333)
mcp_server: sequential-thinking (port 9334)
```

---

## Vault Path Resolution

Claude Code has access to environment variables and the Claude settings system.

**Resolution order:**
1. `AI_MEMORY_OBSIDIAN_VAULT` environment variable
2. `OBSIDIAN_VAULT_ROOT` environment variable
3. Obsidian app config detection
4. Default fallback

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/claude-code.md` and exit with error.

---

## Session Startup Hook

Claude Code's `sessionMemoryCompact` hook fires at session end. Map it to write a session summary:

```
Output path: <obsidian-vault>/sessions/YYYY-MM-DD/claude-code.md
Format: - [HH:mm:ss] session summary content
```

This feeds into `ops/sync-claudemem-to-obsidian.ps1` → `structured/claude-code.jsonl`.

---

## MCP Configuration

Add to `~/.claude/settings.json` (or equivalent):

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
<obsidian-vault>/00-System/ai-memory/inbox/claude-code.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: claude-code` block. Never touch other agent blocks.

---

## Token Budget

- **Default session**: Read full canonical order (~8000 chars `GLOBAL-CONTEXT.md`)
- **Quick session** (< 30 min): Use `memory_wake_up max_items=5` instead of full read
- **Heavy session** (multi-hour): Full chain — `GLOBAL-CONTEXT.md` + `AUTO-DREAM.md` + `HANDOFF.md`

---

## Portable Skill Loading

Claude Code reads skill files from `~/.claude/skills/` and `.claude/rules/`.
Place this reference in your session start:

```
Skill: shared-memory-portable  (from templates/agents/portable-skill/SKILL.md)
Rule: .claude/rules/shared-memory.md
```

---

## Vault Path Resolution Check

Claude Code can resolve `<obsidian-vault>` via environment variables.

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

If both are empty and Obsidian config is not found, this agent cannot auto-resolve.
In that case: write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/claude-code.md`.
