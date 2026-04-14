---
name: agent-bootstrap
description: Agent bootstrap — how any AI agent clones the repo and autonomously sets up the full memory architecture
version: 1.0.0
agent: universal
---

# Agent Bootstrap Protocol

> **Purpose**: Any AI agent (Claude Code, Copilot, Cursor, Codex, etc.) that clones this repo
> can read this file and autonomously set up the entire memory architecture on the host machine.
> No human intervention required beyond `git clone`.

---

## Step 0: Detect Your Platform

Run once at session start:

```bash
# REQUIRED — determine host OS
node -e "console.log(require('./bus/platform/index.js').platform.name)"
# Returns: 'windows' | 'darwin' | 'linux'

# Also record Node.js version
node --version  # must be >=18
```

If Node.js < 18 or not installed → **stop and report** to user.

---

## Step 1: Resolve the Memory Store

The `.ai-memory` store is the **source of truth** for identity, context, and memory writeback. No Obsidian dependency.

```bash
# Method A: Environment variable (highest priority)
node -e "console.log(process.env.AI_MEMORY_STORE || process.env.AI_MEMORY_STORE_ROOT || '')"

# Method B: Run store-root resolution (cross-platform, auto-detects best drive)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

**Store resolution priority:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` env var
2. `AI_MEMORY_ROOT/.ai-memory` (if AI_MEMORY_ROOT is set)
3. Auto-detect best available drive (Windows: D-Z scan for most free space, min 2GB)
4. Platform default:
   - Windows: `E:\.ai-memory`
   - macOS: `~/Library/Application Support/.ai-memory`
   - Linux: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`

**If store not found:**
- The store structure will be created automatically on first write
- OR write `inbox/<agent-name>.md` with `STORE_RESOLUTION_FAILED: true`

**Required store subdirectories** (auto-created if missing):
```
<store-root>/
  inbox/        ← agent writeback (one .md per agent)
  structured/  ← JSONL records (sessions, tasks, entities)
  generated/    ← derived artifacts (GLOBAL-CONTEXT.md, AUTO-DREAM.md)
  embeddings/  ← search index (BM25 + dense)
  kg/          ← knowledge graph SQLite
  projects/    ← project-specific structured facts
  sessions/    ← raw session transcripts
  global.md    ← permanent user facts
  CONTEXT.md   ← auto-generated summary
```

---

## Step 2: Resolve the Memory Store Root

The store root is where the `.ai-memory/` data directory lives. **Defaults are platform-aware**:

```bash
# Resolve store root (cross-platform)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

**Priority:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` env var
2. Auto-detect best drive (Windows: D–Z scan for most free space, min 2GB)
3. Platform default:
   - Windows: `E:\.ai-memory` (or best drive if E: unavailable)
   - macOS: `~/Library/Application Support/.ai-memory`
   - Linux: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`

---

## Step 3: Environment Health Check

```bash
# Run the cross-platform health check (ESM — Node.js >=18)
node scripts/env-check.js

# Expected output: PASS/FAIL per check with clear remediation steps
```

**What it checks:**
- Node.js >= 18 and npm
- Python >= 3.9 and pip
- Required env vars (`OPENAI_API_KEY`, etc.)
- Obsidian vault accessibility
- Store root writability
- Optional: VBS availability (Windows), PowerShell (Windows), bash (macOS/Linux)

---

## Step 4: Initialize the Knowledge Graph

```bash
# Create the SQLite KG if not exists (auto-creates on first write)
node -e "const kg = require('./ops/knowledge-graph.js'); console.log('KG ready')"

# Or via the memory layers pipeline:
node ops/build-memory-layers.js --dry-run
```

---

## Step 5: Start MCP Servers (if not already running)

```bash
# Check if MCP servers are already running
curl -s http://127.0.0.1:9338/health 2>/dev/null && echo "memory bus: UP" || echo "memory bus: DOWN"
curl -s http://127.0.0.1:9335/health 2>/dev/null && echo "obsidian: UP" || echo "obsidian: DOWN"
```

**If MCP servers are DOWN — start them:**

```bash
# Windows: PowerShell MCP launcher
pwsh -NoProfile -ExecutionPolicy Bypass -File ops/start-memory-mcp.ps1

# macOS/Linux: bash launcher
bash scripts/start-memory-mcp.sh
```

**If launchers don't exist** (early repo state), start manually:
```bash
# Memory Bus MCP (Node.js, port 9338)
node shared-mcp/omni-memory-server.js --port 9338 &

# Obsidian MCP (port 9335) — requires obsidian plugin
# See docs/platform/SETUP_OVERVIEW.md for platform-specific instructions
```

---

## Step 6: Verify End-to-End Connectivity

```bash
# Quick smoke test
node scripts/cross-platform-test.js

# Should output: 8/8 PASS (or fewer if some deps unavailable)
```

**Full integration test:**
```bash
node --test tests/integration/js/inbox-atomic-flow.test.js
node --test tests/integration/js/memory-layers-flow.test.js
python tests/integration/py/search-flow.test.py
```

---

## Step 7: Read Canonical Context

Once store is resolved and MCP is up:

```
Read order (lightweight first):
  1. <store-root>/CONTEXT.md (auto-generated summary)

Fast path (if memory MCP is up):
  → memory_boot(project="<project-name>")

Full context (heavy session):
  → memory_boot(project="<project-name>") + memory_search()
```

---

## Memory Writeback Contract

After each significant session milestone, **write to inbox**:

```
<store-root>/inbox/<agent-name>.md
```

Format:
```markdown
# Agent: <name> — <ISO timestamp>

## Session: <session identifier>

### What was done
- <bullet>

### Key decisions
- <bullet>

### Next steps
- <bullet>

### Blockers
- <bullet>
```

**Stop Hook**: Auto-extraction is preferred — the Stop Hook auto-writes extracted facts to `<store-root>/projects/<project>.jsonl`.

**Manual fallback**: Write directly to `<store-root>/inbox/<agent>.md`.

---

## Platform-Specific Notes

### Windows
- Store root: `E:\.ai-memory` (auto-detects best drive if E: full or unavailable)
- Watchdog: VBS (`scripts/watchdog.ps1`) or PowerShell
- Node.js: `node.exe` must be in PATH

### macOS
- Store root: `~/Library/Application Support/.ai-memory`
- Watchdog: bash (`scripts/watchdog.sh`)
- Python: `python3` (no py launcher needed)

### Linux
- Store root: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`
- Watchdog: bash (`scripts/watchdog.sh`)
- Python: `python3`
- Optional: PowerShell (`pwsh`) for Windows-compatible scripts

---

## Troubleshooting

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| Store not found | Run `node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"` | Set `AI_MEMORY_STORE` env var |
| MCP server down | `curl http://127.0.0.1:9338/health` | Restart via launcher script |
| Store root not writable | Check directory permissions | Set `AI_MEMORY_STORE` to writable path |
| Python not found | `python3 --version` fails | Install Python >= 3.9 |
| embedding generation fails | Check `OPENAI_API_KEY` env var | Set API key or use offline mode |
| KG concurrent lock | `SQLITE_BUSY` errors | Normal under concurrent writes, retries are automatic |

---

## Complete One-Line Bootstrap (Copy-Paste)

For agents that want the fastest path:

```bash
cd /path/to/obsidian-shared-memory-bus && \
  node -e "const p=require('./bus/platform/index.js').platform.name;console.log('Platform:',p)" && \
  node scripts/vault-detect.js && \
  node -e "console.log('Store root:',require('./bus/store-root.js').resolveStoreRoot())" && \
  node scripts/env-check.js && \
  echo "Bootstrap complete — memory bus ready"
```

On failure: **report exactly which step failed and why**.
