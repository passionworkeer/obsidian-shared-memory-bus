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

## Step 1: Resolve the Obsidian Vault

The vault is the **source of truth** for identity, context, and memory writeback.

```bash
# Method A: Environment variable (highest priority)
node -e "console.log(process.env.OBSIDIAN_VAULT_ROOT || process.env.AI_MEMORY_OBSIDIAN_VAULT || '')"

# Method B: Run vault-detect script (cross-platform, no deps)
node scripts/vault-detect.js
# Exits 0 with vault path on stdout, or 1 with error message
```

**Vault resolution priority:**
1. `AI_MEMORY_OBSIDIAN_VAULT` env var
2. `OBSIDIAN_VAULT_ROOT` env var
3. Obsidian app config (platform-specific config file)
4. Default candidates (platform-specific)

**If vault not found:**
- Create a minimal vault structure at `<home>/Obsidian Vault/` or `E:\Obsidian Vault\`
- OR write `inbox/<agent-name>.md` with `VAULT_RESOLUTION_FAILED: true`

**Required vault subdirectories** (create if missing):
```
<vault>/
  00-System/ai-memory/
    inbox/        ← agent writeback (one .md per agent)
    structured/  ← JSONL records (sessions, tasks, entities)
    generated/    ← derived artifacts (GLOBAL-CONTEXT.md, AUTO-DREAM.md)
    embeddings/  ← search index (BM25 + dense)
    kg/          ← knowledge graph SQLite
  02-KB/
    OBSIDIAN.md  ← project overview
    MEMORY.md    ← cross-agent memory index
    WORKING.md   ← active task tracker
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

Once vault is resolved and MCP is up:

```
Read order (lightweight first):
  1. <vault>/02-KB/OBSIDIAN.md
  2. <vault>/02-KB/MEMORY.md
  3. <vault>/02-KB/WORKING.md

Fast path (if memory MCP is up):
  → memory_wake_up(max_items=5)

Full context (heavy session):
  → <vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md
```

---

## Memory Writeback Contract

After each significant session milestone, **write to inbox**:

```
<vault>/00-System/ai-memory/inbox/<agent-name>.md
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

**Active task tracking** (append to, safe for concurrent writes):
```
<vault>/02-KB/WORKING.md
```
Add under `## Agent:<name>` section.

---

## Platform-Specific Notes

### Windows
- Store root: `E:\.ai-memory` (auto-detects best drive if E: full)
- Watchdog: VBS (`scripts/watchdog.ps1`) or PowerShell
- Obsidian vault: `%APPDATA%\obsidian\obsidian.json`
- Node.js: `node.exe` must be in PATH

### macOS
- Store root: `~/Library/Application Support/.ai-memory`
- Watchdog: bash (`scripts/watchdog.sh`)
- Obsidian vault: `~/Library/Application Support/obsidian/obsidian.json`
- Python: `python3` (no py launcher needed)

### Linux
- Store root: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`
- Watchdog: bash (`scripts/watchdog.sh`)
- Obsidian vault: `~/.config/obsidian/obsidian.json`
- Python: `python3`
- Optional: PowerShell (`pwsh`) for Windows-compatible scripts

---

## Troubleshooting

| Problem | Diagnosis | Fix |
|---------|-----------|-----|
| Vault not found | Run `node scripts/vault-detect.js` | Set env var or create vault |
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
