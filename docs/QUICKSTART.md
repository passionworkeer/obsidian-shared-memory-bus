# Quick Start — Obsidian Shared Memory Bus

Get from zero to a working shared memory bus in 5 steps. Estimated time: 15 minutes.

---

## Before You Begin

Verify you have the prerequisites:

```powershell
node -v    # Node.js 18+ required
npm -v     # npm 9+ required
python --version  # Python 3.8+ optional (for dense retrieval)
pwsh --version   # PowerShell 7+ optional (for portable wrappers)
```

---

## Step 1: Install the Memory Bus

### Windows

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\install.ps1 `
  -WorkspaceRoot E:\desktop\your-project
```

The installer will:
1. Copy the runtime to `~/.ai-memory`
2. Detect your Python runtime (prefers `uv`-managed Python)
3. Install `rank-bm25` and `jieba` for BM25 search
4. Write environment variables `AI_MEMORY_ROOT` and `AI_MEMORY_PYTHON`
5. Start the watchdog and shared MCP stack

### macOS / Linux

```bash
./scripts/install.sh -WorkspaceRoot ~/projects/your-project
source ~/.ai-memory/activate-ai-memory.sh
```

---

## Step 2: Verify Everything Is Running

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

Expected output: all servers show `running: true` on ports 9331-9338.

Alternatively, use the built-in test command:

```powershell
powershell -File bus/memory-bus.ps1 -Action Status
```

Expected output shows `watchdog.running: true` and `embeddings.count > 0`.

---

## Step 3: Write Your First Memory Entry

Create a note file at the path shown below. The exact path depends on your vault location:

```markdown
---
type: memory
tags: [project, session]
---

## 2026-04-11 Session

Today I worked on improving the entity extraction pipeline.
Key decision: switched from spaCy to regex-based two-pass extraction
for better cross-platform compatibility without external dependencies.
```

The vault path is resolved in this order:
1. `AI_MEMORY_OBSIDIAN_VAULT` environment variable
2. `OBSIDIAN_VAULT_ROOT` environment variable
3. Active Obsidian vault from app config
4. Default: `E:\desktop\Obsidian Vault` (Windows)

For this session, the inbox path is:
```
<vault-root>/00-System/ai-memory/inbox/claude-code.md
```

Write to this path using the `obsidian` MCP tool, or directly create the file.

---

## Step 4: Trigger a Memory Sync

```powershell
powershell -File bus/memory-bus.ps1 -Action SyncAll
```

This will:
- Scan your inbox entry and extract entities + concepts
- Update structured JSONL files
- Build the MEMORY-LAYERS artifact
- Refresh GLOBAL-CONTEXT.md

Alternatively, force a watchdog sync:

```powershell
powershell -File bus/memory-watchdog.ps1 -Once
```

---

## Step 5: Query Your Memory from Another Session

After sync, your memory entry is available to all agents via MCP:

```powershell
claude -p "$(cat <<'EOF'
{"tools":[{"name":"search_shared_memory","input":{"query":"entity extraction pipeline decision","limit":3}}]}
EOF
)"
```

Or check the memory status to see your entry was indexed:

```powershell
claude -p "$(cat <<'EOF'
{"tools":[{"name":"memory_status"}]}
EOF
)"
```

Look for `embeddings.count` — this confirms your entry was embedded.

---

## Common Commands

| Task | Command |
|------|---------|
| Check status | `powershell -File bus/memory-bus.ps1 -Action Status` |
| Force full sync | `powershell -File bus/memory-bus.ps1 -Action SyncAll` |
| Force watchdog sync | `powershell -File bus/memory-watchdog.ps1 -Once` |
| Rebuild embeddings | `node $env:AI_MEMORY_ROOT/generate-embeddings.js` |
| Run dream consolidation | `powershell -File ops/run-memory-dream.ps1 -Writeback` |
| Start MCP services | `powershell -File shared-mcp/start-default-shared-mcp.ps1 -ForceRestart` |
| Check shared MCP health | `powershell -File shared-mcp/status-shared-mcp.ps1` |
| Validate installation | `powershell -File scripts/validate-layout.ps1` |
| Check memory integrity | `node ops/check-memory-integrity.js --strict` |

---

## Vault Path Resolution

The vault is resolved automatically. To set it explicitly:

```powershell
# Set permanently via environment variable
[Environment]::SetEnvironmentVariable("AI_MEMORY_OBSIDIAN_VAULT", "E:\desktop\Obsidian Vault", "User")

# Or for the current session only
$env:AI_MEMORY_OBSIDIAN_VAULT = "E:\desktop\Obsidian Vault"
```

```bash
# macOS/Linux
export AI_MEMORY_OBSIDIAN_VAULT="$HOME/path/to/vault"
```

Resolution order:
1. `AI_MEMORY_OBSIDIAN_VAULT` env var
2. `OBSIDIAN_VAULT_ROOT` env var
3. Obsidian app config (active or most recent vault)
4. Default: `~/Obsidian Vault`, `~/Desktop/Obsidian Vault`, or `~/Documents/Obsidian Vault`

---

## What You Just Set Up

After completing these 5 steps, you have:

- Shared MCP stack running on ports 9331-9338
- Watchdog auto-refreshing memory every 15 seconds
- BM25 + dense hybrid retrieval over your Obsidian vault
- Entity extraction and knowledge graph building
- Multi-agent memory sharing across all configured agents
- Auto-generated artifacts (MEMORY-LAYERS, HANDOFF, AUTO-DREAM, GLOBAL-CONTEXT)

---

## Next Steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand the design
- Read [reference/DATA-FLOW.md](reference/DATA-FLOW.md) for the complete data lifecycle
- Read [MEMORY-TIERING.md](MEMORY-TIERING.md) to understand how memories age
- Read [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if something goes wrong
