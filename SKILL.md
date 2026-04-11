---
name: obsidian-shared-memory-bus
description: Unified shared memory bus for all AI agents, backed by Obsidian
version: 1.0.0
---

# Obsidian Shared Memory Bus — Universal Skill

> Any AI agent that reads this file can onboard to the shared memory bus.
> Clone the repo, read this file, follow the 5 steps. That's it.

## Vault Path Resolution

`<obsidian-vault>` resolves in this order:

| Priority | Source | Windows Default | macOS/Linux Default |
|----------|--------|-----------------|---------------------|
| 1 | `AI_MEMORY_OBSIDIAN_VAULT` env var | Any path | Any path |
| 2 | `OBSIDIAN_VAULT_ROOT` env var | Any path | Any path |
| 3 | Obsidian app config | `%APPDATA%\obsidian\obsidian.json` | `~/Library/Application Support/obsidian/obsidian.json` |
| 4 | Default fallback | `E:\desktop\Obsidian Vault` | `~/Obsidian Vault` |

**If you cannot resolve `<obsidian-vault>`:**
- Write `"VAULT_RESOLUTION_FAILED"` to the first line of `inbox/<agent>.md`
- Exit with a clear error message explaining which resolution methods failed
- Agents without environment variable injection: use the MCP `obsidian` tool to dynamically discover the vault root path

**Expected vault structure:**
```
<obsidian-vault>/
  00-System/ai-memory/
    inbox/          ← agent writeback
    structured/     ← JSONL records
    generated/      ← derived artifacts
    embeddings/     ← BM25 + dense index
    kg/             ← knowledge graph SQLite
  02-KB/
    OBSIDIAN.md
    MEMORY.md
    WORKING.md
```

## 5-Step Quick Start

1. **Read canonical vault order** (see Vault Path Resolution below):
   `<obsidian-vault>/02-KB/OBSIDIAN.md` → `MEMORY.md` → `WORKING.md` → `GLOBAL-CONTEXT.md`
2. **(Optional) Warm up fast**: Call `memory_wake_up` MCP on port 9338
3. **Write durable memory**: `<obsidian-vault>/00-System/ai-memory/inbox/<agent>.md`
4. **Track active tasks**: `<obsidian-vault>/02-KB/WORKING.md` (use `## Agent:<name>` blocks for safe concurrent writes)
5. **Use shared MCP services**: `memory`(9338), `obsidian`(9335), `context7`(9331), `fetch`(9332), `time`(9333), `playwright`(9337, opt-in)

---

## Unified Memory Read Protocol

### Canonical Read Order
Resolve `<obsidian-vault>` first (see Vault Path Resolution below), then read in order:

```
<obsidian-vault>/02-KB/OBSIDIAN.md
  → <obsidian-vault>/02-KB/MEMORY.md
    → <obsidian-vault>/02-KB/WORKING.md
      → <obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md
```

### Fast Path: `memory_wake_up` MCP
If the shared `memory` MCP is running on port 9338, call `memory_wake_up` instead of reading files:
```
max_items: 3 (light), 5 (medium), 8 (heavy)
include_recent_activity: true
```

### Generated Artifact Chain
```
GLOBAL-CONTEXT.md  (token-budgeted ~8000 chars, refreshed on session start)
  └── AUTO-DREAM.md  (typed durable promotion queue, refreshed daily)
        └── HANDOFF.md  (bounded resume packet, goal/done/next/blocked)
```

---

## Unified Memory Write Protocol

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/<agent>.md
```
Each agent writes to its own file. Write format:
```
## Agent: <agent-name>

- [YYYY-MM-DD HH:mm:ss] content here
```

### Active Task State (WORKING.md)
```
<obsidian-vault>/02-KB/WORKING.md
```
Format uses `## Agent:<name>` section blocks for safe concurrent writes:
```
## Agent: claude-code
... task state for claude-code ...

## Agent: codex
... task state for codex ...
```
When updating, replace only your own agent block. Never overwrite other agent blocks.

### Project-Specific Memory
For project-level facts: write to a note at `<obsidian-vault>/<project>/MEMORY.md`.

### Rules
- **Never write secrets, tokens, or credentials** to any memory file
- **Always use `content_hash`** to prevent duplicate writes
- **Prefer typed writeback**: include `scope`, `durable_type`, and `confidence` in frontmatter
- **Deduplicate**: check `content_hash` before appending; skip if identical record written within 30s

---

## Vault Path Resolution Check

**Must resolve `<obsidian-vault>` before reading. If resolution fails, exit immediately with an error.**

See the **Vault Path Resolution** reference box at the top of this file for the full resolution order, expected vault structure, and failure behavior.

---

## Agent-Specific Integration

Each agent has an optimized integration guide. Read the one that matches your agent:

| Agent | Integration Guide |
|-------|-----------------|
| Claude Code | `.agents/skills/claude-code.md` |
| Codex | `.agents/skills/codex.md` |
| OpenClaw | `.agents/skills/openclaw.md` |
| Trae | `.agents/skills/trae.md` |
| Cursor | `.agents/skills/cursor.md` |
| Copilot | `.agents/skills/copilot.md` |

---

## Token Budget Guidelines

Choose based on your session length and context window:

| Agent Type | Session Length | Token Budget | Recommendation |
|-----------|---------------|--------------|----------------|
| **Light** (CLI, single-shot) | < 5 min | Skip `GLOBAL-CONTEXT.md` | Use `memory_wake_up max_items=3` only |
| **Medium** (session-based) | 5–60 min | ~8,000 chars (`GLOBAL-CONTEXT.md`) | Read full canonical order + `memory_wake_up` |
| **Heavy** (multi-hour) | 1+ hours | Full chain | `GLOBAL-CONTEXT.md` + `AUTO-DREAM.md` + `HANDOFF.md` |

**Rule: Never let memory reading consume more than 15% of your available token budget.**

---

## Git Hook Integration

Git hooks can automate agent registration and memory refresh. See:
→ `docs/GIT-HOOKS-INTEGRATION.md`

Hooks are non-blocking (always exit 0) and work on Windows/macOS/Linux.

---

## Memory Tiering Quick Reference

Five tiers — all files preserved, organized by durability:

| Tier | Name | TTL | Embedding Indexed | Recommendation Eligible |
|------|------|-----|-------------------|------------------------|
| 1 | Event/Working | 1 day | No | No |
| 2 | Session Durable | Session end + 7d | No | No |
| 3 | Project Durable | Project end + 30d | **Yes** | **Yes** |
| 4 | Shared Durable | user=never / feedback=90d / reference=180d | **Yes** | **Yes** |
| 5 | Archive | Manual review | No | No |

**Only Tier 3 and Tier 4 records are embedded.** This keeps the vector space focused on durable, high-value memories and avoids token waste.

**Archive does not write tombstones to the embedding index.** Instead, archived records are tracked in `archive-manifest.jsonl` and the embedding index is cleaned up incrementally by `bus/generate-embeddings.js`.

For full tier transition rules and policies:
→ `docs/MEMORY-TIERING.md`

---

## Recommendation and Recall Quality

The retrieval system adapts its behavior based on recall quality:

| Mode | When | Behavior |
|------|------|----------|
| Exploration | Short queries (<5 tokens) or fuzzy patterns | Expand candidates, prioritize diversity |
| Exploitation | Default / cold start | Standard retrieval parameters |
| Confidence | Hit@3 ≥ 0.75 | Trust top results, reduce candidate pool |

**Cold start**: For the first 100 retrievals, the system defaults to Exploitation mode (no unnecessary candidate expansion) to avoid token waste before enough recall data is accumulated.

For full recommendation tier documentation:
→ `docs/RECOMMENDATION-TIER.md`

---

## Shared MCP Services

All agents share these MCP services via HTTP on ports 9331–9338:

| Port | Service | Mode | Description |
|------|---------|------|-------------|
| 9331 | `context7` | Shared | Code search and documentation |
| 9332 | `fetch` | Shared | Web fetch utility |
| 9333 | `time` | Shared | Time/date utilities |
| 9334 | `sequential-thinking` | Shared | Reasoning helper |
| 9335 | `obsidian` | Shared | Vault read/write via MCP |
| 9337 | `playwright` | Shared (isolated sessions) | Browser automation |
| 9338 | `memory` | Shared | Unified memory: search, wake_up, retrieval, KG |

Default endpoint: `http://127.0.0.1:PORT/mcp`

---

## Architecture Links

| Document | Purpose |
|----------|---------|
| `docs/ARCHITECTURE.md` | Full 5-plane architecture overview |
| `docs/adr/ADR-002-unified-memory-architecture-v2.md` | Canonical memory schema v2, KG, consolidation |
| `docs/MEMORY-TIERING.md` | Formal 5-tier specification with transition rules |
| `docs/RECOMMENDATION-TIER.md` | Recall quality metrics and adaptive modes |
| `docs/GIT-HOOKS-INTEGRATION.md` | Git hooks for agent registration and sync |
| `docs/NEW-AGENT-INTEGRATION.md` | How to add a new agent type |
| `scripts/validate-layout.ps1` | Validate install/runtime layout |
| `ops/check-memory-integrity.js --strict` | Validate memory contract integrity |
