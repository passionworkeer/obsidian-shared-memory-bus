# Obsidian Shared Memory Bus — Usage Guide

Shared memory layer for AI coding tools, backed by an Obsidian vault. Multiple agents (Codex, Claude, OpenCode, Cursor, Copilot, Trae, OpenClaw) share one retrieval endpoint instead of each launching their own stateless MCPs.

## Install and Start

```powershell
# Windows (one-time install)
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

# Start the default shared stack
powershell -NoProfile -ExecutionPolicy Bypass -File shared-mcp/start-default-shared-mcp.ps1
```

```bash
# macOS/Linux
pwsh install.ps1
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

## Verify It Is Working

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File shared-mcp/status-shared-mcp.ps1 -Json
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json
```

Hard gate — must pass:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File verify-client-integrations.ps1 -WorkspaceRoot . -RunCliChecks -RunRuntimeChecks
```

## Stop

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File shared-mcp/start-default-shared-mcp.ps1 -Stop
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -Stop
```

## Key Concepts

### Memory Layers

| File | Purpose |
|------|---------|
| `session-memory.jsonl` | Live per-session continuity |
| `task-memory.jsonl` | Explicit task-state memory |
| `shared-inbox.jsonl` | Durable cross-agent inbox |
| `shared-events.jsonl` | Cross-agent event log |
| `claude-code.jsonl` | Imported Claude Code session layer |
| `openclaw.jsonl` | Imported OpenClaw sessions |

### Watchdog

`memory-watchdog.ps1` keeps the shared layer fresh by watching native sources. Without it, cross-agent shared context goes stale. Disable with `AI_MEMORY_WATCHDOG_ENABLED=0`.

### MCP Servers (ports 9331-9338)

| Port | Server | Purpose |
|------|--------|---------|
| 9331 | context7 | Stateless docs/code search |
| 9332 | fetch | HTTP fetch |
| 9333 | time | Timezone conversion |
| 9334 | sequential-thinking | Reasoning |
| 9335 | obsidian | Vault access |
| 9336 | MiniMax | Coding plan (optional) |
| 9337 | playwright | Browser automation (optional) |
| 9338 | memory | Unified retrieval |

### Memory Contract

`ops/memory-contract.js` validates the versioned schema for all structured JSONL layers. Current: **contract v2, record schema v2**. Validate:
```bash
node ops/check-memory-integrity.js --strict
```

### Retrieval

Default: `hybrid` (BM25 + dense). Offline `hashing-v1` is the default dense backend. Optional OpenAI-compatible remote embeddings. After switching provider, rebuild:
```bash
node generate-embeddings.js
```

## Where to Find More

| Guide | Covers |
|-------|--------|
| `docs/ARCHITECTURE.md` | System design |
| `docs/FAQ.md` | Common issues, watchdog, sync |
| `docs/OPERATIONS.md` | Start/stop, rebuild, recovery |
| `docs/DEPLOYMENT-MATRIX.md` | Deployment shapes |
