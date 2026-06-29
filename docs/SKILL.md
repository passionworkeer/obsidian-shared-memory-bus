---
name: yt-memory-bus
description: Unified shared memory bus for all AI agents
version: 2.0.0
---

# Shared Memory Bus — Universal Skill (v2)

> Any AI agent that reads this file can onboard to the shared memory bus.
> Clone the repo, read this file, follow the steps. That's it.

## Agent Startup Protocol (Read First)

**Autonomous bootstrap — no human needed beyond `git clone`:**

```
1. Read .agents/skills/AGENT_BOOT.md
   → This is the machine-executable bootstrap for any AI agent.

2. Apply platform-specific overrides:
   - Windows → .agents/skills/AGENT_BOOT.md (default)
   - macOS   → .agents/skills/macos.md
   - Linux   → .agents/skills/linux.md

3. Read agent-specific integration:
   → .agents/skills/<agent-name>.md
```

**Full bootstrap sequence (copy-paste for any platform):**
```bash
cd /path/to/obsidian-shared-memory-bus && \
  node -e "console.log('Platform:', require('./bus/platform/index.js').platform.name)" && \
  node -e "console.log('Store:', require('./bus/store-root.js').resolveStoreRoot())" && \
  node ops/generate-context.js
```

**If any step fails: report the exact failure, do not proceed silently.**

---

## Store Path Resolution

Memory store resolves in this order:

| Priority | Source | Windows Default | macOS/Linux Default |
|----------|--------|-----------------|---------------------|
| 1 | `AI_MEMORY_STORE_ROOT` env var | Any path | Any path |
| 2 | Default fallback | `E:\.ai-memory` | `~/.ai-memory` |

**Expected store structure:**
```
<store-root>\
  global.md             ← Permanent user facts
  CONTEXT.md            ← Auto-generated summary (read this)
  projects\
    {project}.jsonl     ← LLM-extracted facts (Stop Hook)
  sessions\             ← Raw transcript archives
  inbox\
    {agent}.md          ← Manual writeback fallback
```

## 5-Step Quick Start

1. **Read memory context**: `E:\.ai-memory\CONTEXT.md` (passive) or call `memory_boot` via MCP (port 9338)
2. **Write durable memory**: Stop Hook auto-writes to `projects/{project}.jsonl`. Manual fallback: `inbox/<agent>.md`
3. **Track active tasks**: `WORKING.md` in store root (use `## Agent:<name>` blocks for safe concurrent writes)
4. **Search past facts**: `memory_search(query)` via MCP (port 9338)
5. **Use shared MCP services**: `memory`(9338), `context7`(9331), `fetch`(9332), `time`(9333), `playwright`(9337, opt-in)

---

## Unified Memory Read Protocol

### Canonical Read Order (v2)

**No Obsidian required.** Memory store: `E:\.ai-memory\` (Windows) or `~/.ai-memory/` (macOS/Linux).

**Option A — MCP available (port 9338):**
```
memory_boot(project="<your-project-name>")
```
Returns global user facts + top-20 recent project facts. Best for MCP-capable agents.

**Option B — File fallback (any agent that can read files):**
```
Read: E:\.ai-memory\CONTEXT.md
```
Auto-generated summary of all project facts + global user info. Updated after each session.

**Universal Rule**: Any agent that reads `CONTEXT.md` can answer "do you remember who I am?"

### Memory Store Layout
```
E:\.ai-memory\              (Windows default; see store-root.js for other platforms)
  global.md               ← Permanent user facts (hand-maintained, < 100 tokens)
  CONTEXT.md              ← Auto-generated summary for passive agents
  projects\
    {project}.jsonl       ← LLM-extracted structured facts (populated by Stop Hook)
  sessions\               ← Raw transcript archives (not indexed)
```

### MCP Tools (v2, port 9338)
```
memory_boot(project)      → startup context: global.md + top-20 project facts
memory_search(query)      → BM25 search over project.jsonl
memory_write(project, facts[]) → manual fact writing
memory_status()           → health check
memory_extract(...)       → manual LLM extraction (debug)
```

---

## Unified Memory Write Protocol

### Auto-Write (Stop Hook, Preferred)
Stop Hook auto-extracts facts and writes to `projects/{project}.jsonl`. No manual write needed.

### Manual Writeback (Fallback)
```
E:\.ai-memory\inbox\<agent>.md
```
Each agent writes to its own file. Write format:
```
## Agent: <agent-name>

- [YYYY-MM-DD HH:mm:ss] content here
```

**Size Limits (enforced by every agent):**
- Single entry: < 500 characters
- File size: < 5000 tokens
- **If limit exceeded**: archive to `inbox/archive/<agent>-YYYY-MM.md`, then rewrite a compact summary

### Rules
- **Never write secrets, tokens, or credentials** to any memory file
- **Deduplicate**: skip if identical record written within 30s
- **Read ALL inbox files**: Every agent must read ALL files in `inbox/` — not just its own
- **Size enforcement**: Archive when inbox file exceeds 5000 tokens

---

## Store Path Check

Memory store root: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux).

Verify with:
```bash
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

---

## Agent-Specific Integration

Each agent has an optimized integration guide. Read the one that matches your agent:

| Agent | Integration Guide |
|-------|-----------------|
| **Any Agent** | `.agents/skills/AGENT_BOOT.md` (start here) |
| Claude Code | `.agents/skills/claude-code.md` |
| Codex | `.agents/skills/codex.md` |
| OpenClaw | `.agents/skills/openclaw.md` |
| Trae | `.agents/skills/trae.md` |
| Cursor | `.agents/skills/cursor.md` |
| Copilot | `.agents/skills/copilot.md` |
| macOS (any) | `.agents/skills/macos.md` |
| Linux (any) | `.agents/skills/linux.md` |

---

## Token Budget Guidelines

Choose based on your session length and context window:

| Agent Type | Session Length | Token Budget | Recommendation |
|-----------|---------------|--------------|----------------|
| **Light** (CLI, single-shot) | < 5 min | ~500 tokens | Read `E:\.ai-memory\CONTEXT.md` only |
| **Medium** (session-based) | 5–60 min | ~2,000 tokens | `memory_boot` via MCP, or `CONTEXT.md` |
| **Heavy** (multi-hour) | 1+ hours | ~3,000 tokens | `memory_boot` + `memory_search` |

**Rule: Never let memory reading consume more than 15% of your available token budget.**

---

## Git Hook Integration

Git hooks can automate agent registration and memory refresh. See:
→ `hooks/` directory and `docs/guides/DEVELOPMENT.md`

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

For full retrieval configuration, see:
→ `docs/guides/ENVIRONMENT.md`

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
| `.agents/skills/AGENT_BOOT.md` | **Agent bootstrap protocol** (start here) |
| `.agents/skills/macos.md` | macOS-specific agent setup |
| `.agents/skills/linux.md` | Linux-specific agent setup |
| `docs/architecture/PLATFORM_ABSTRACTION.md` | Platform abstraction layer design |
| `docs/architecture/OVERVIEW.md` | System architecture overview |
| `docs/platform/SETUP_OVERVIEW.md` | Cross-platform setup quick reference |
| `docs/platform/MACOS_SETUP.md` | macOS detailed setup guide (bilingual) |
| `docs/platform/LINUX_SETUP.md` | Linux detailed setup guide (bilingual) |
| `docs/adr/ADR-002-unified-memory-architecture-v2.md` | Canonical memory schema v2, KG, consolidation |
| `docs/MEMORY-TIERING.md` | Formal 5-tier specification with transition rules |
| `docs/INDEX.md` | Full docs index and navigation |
| `scripts/validate-layout.ps1` | Validate install/runtime layout |
| `ops/check-memory-integrity.js --strict` | Validate memory contract integrity |
| `.github/workflows/test.yml` | CI: 3×3 matrix (ubuntu/macos/windows × node 18/20/22) |
