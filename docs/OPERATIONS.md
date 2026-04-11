# Operations

This runbook covers normal day-to-day operation of the shared memory bus.

## Check Shared MCP Status
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

For automation, dashboards, or scripts, prefer the JSON form:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1 -Json
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json
```

## Start The Default Shared Stack
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

## Restart Everything
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

Use `-ForceRestart` deliberately. Normal validation should first inspect health and only force a full restart when the shared stack is actually degraded.

## Restart One Shared Service
Example: restart only Playwright.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-shared-mcp.ps1 -Only playwright -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-shared-mcp.sh -Only playwright -ForceRestart
```

## Regenerate Shared Derived Context
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\bus\memory-bus.ps1 -Action Generate
```

```bash
~/.ai-memory/bus/memory-bus.sh -Action Generate
```

## Rebuild Layered Memory Summaries
```powershell
node $env:AI_MEMORY_ROOT\ops\build-handoff-pack.js
node $env:AI_MEMORY_ROOT\ops\build-memory-layers.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\run-memory-dream.ps1 -Force
```

```bash
node ~/.ai-memory/ops/build-handoff-pack.js
node ~/.ai-memory/ops/build-memory-layers.js
~/.ai-memory/ops/run-memory-dream.sh -Force
```

## Rebuild Memory Embeddings
Use this only when you intentionally want to refresh dense retrieval artifacts.

```powershell
node $env:AI_MEMORY_ROOT\generate-embeddings.js
```

```bash
node ~/.ai-memory/generate-embeddings.js
```

## Run Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks -RunRuntimeChecks
```

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <your-project-root> -RunCliChecks -RunRuntimeChecks
```

Treat this as a hard gate. The script now exits non-zero when `summary.overallPass=false`.

Interpretation notes:
- `runtimeChecksPass=true` means the clients that could run a real task probe returned the expected live shared-memory state.
- `skipped:provider-auth-unavailable` means a client's selected model provider is not authenticated. That is a client-provider issue, not proof that the shared MCP stack is unhealthy.

## Run Pressure Tests
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks -IncludeOptionalServers
```

```bash
~/.ai-memory/ops/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks -IncludeOptionalServers
```

Treat this as a hard gate too. The script now exits non-zero when `summary.overallPass=false`.

The pressure runner now uses the same hidden wrapper execution path as the validation script on Windows, so long prompts and JSON-mode task probes stay stable under `Start-Process`.

## Logs And Runtime State
Look here first:
- `shared-mcp/logs/`
- `shared-mcp/state.json`

These are operational files, not canonical memory.

## Backup Guidance
- back up the Obsidian vault separately from the runtime bundle
- treat the vault as canonical and the runtime as reproducible
- do not assume logs or caches are durable memory
- treat `MEMORY-LAYERS` and `AUTO-DREAM` as generated outputs, not hand-edited source of truth

## Common Recovery Pattern
1. inspect `status-shared-mcp.ps1` or `status-shared-mcp.sh`
2. restart the affected shared service
3. rerun validation
4. only rebuild embeddings if the problem is actually retrieval-index related

## Watchdog Recovery
If `memory_status.watchdog.status` reports `stale` or `watchdog-exit`, recover in this order:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\bus\memory-watchdog.ps1 -Daemon -PollSeconds 15
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks -RunRuntimeChecks
```

Notes:
- the shared MCP control plane now trusts the active listener PID on each port, not the cached PID in `shared-mcp/state.json`
- a clean stop/start cycle should not create new `state.json.corrupt.*` files; if it does, treat that as a control-plane regression

## Maintenance Tools

### Memory Hygiene Report

Detects duplicates, invalid records, and malformed entries across structured JSONL layers. Run periodically to catch data quality issues before they affect retrieval.

```powershell
node $env:AI_MEMORY_ROOT\ops\generate-memory-hygiene-report.js
```

### Watchdog Supervisor (auto-recovery)
The watchdog supervisor monitors the watchdog process and auto-restarts it if it crashes.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\bus\memory-watchdog-supervisor.ps1 -Daemon
```

### Cleanup Inbox
Removes stale inbox entries that are older than 7 days.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\cleanup-inbox.ps1
```

### PII Redaction

Scans and redacts sensitive content (emails, API keys, credit cards, phones, URLs with auth) from structured memory before embedding. Not yet wired into the automated pipeline — run manually or integrate into the embedding build step as needed.

```bash
python $AI_MEMORY_ROOT/ops/redaction.py --input <file> --output <redacted-file>
```

### Archived One-Off Scripts

Specialized or migration scripts no longer needed in the active pipeline live in `ops/archived/`:
- `repair-codex-runtime.ps1` — Codex crash recovery (no longer maintained)
- `migrate-memory-v2.js` — ADR-001 → ADR-002 schema migration (completed)
---

## Observability

### Log Format
```
{timestamp} [{level}] [{component}] {message} {context_json}
```

| Component | Source | Description |
|-----------|--------|-------------|
| `watchdog` | `memory-watchdog.ps1` | Watchdog scan, sync triggers, source change detection |
| `memory-bus` | `memory-bus.ps1` | Structured sync, artifact refresh |
| `mcp-server` | `omni-memory-server.js` | MCP tool calls, HTTP requests, retrieval dispatch |
| `semantic-search` | `semantic-search.py` | BM25, dense, hybrid search, cache hits/misses |
| `embeddings` | `generate-embeddings.js` | Embedding generation, provider calls, index writes |
| `blackboard-daemon` | `obsidian-blackboard-daemon.js` | Chokidar vault watch events |

### Key Metrics

| Metric | Source | Good | Warn | Alert |
|--------|--------|------|------|-------|
| `memory.retrieval.latency_ms.p50` | `memory_status` | < 200ms | 200–1000ms | > 1000ms |
| `memory.retrieval.cache_hit_rate` | `memory_status` | > 60% | 30–60% | < 30% |
| `memory.embeddings.count` | `memory_status` | growing | 0 (not built) | — |
| `memory.embeddings.index_state` | `memory_status` | `aligned` | `stale` | `mixed` |
| `memory.watchdog.running` | `memory_status` | `true` | — | `false` |
| `memory.structured.signature_stale` | `memory_status` | `false` | — | `true` |

### Alert Thresholds

| Condition | Severity | Action |
|-----------|----------|--------|
| `watchdog.running` → `false` | **ALERT** | Restart: `start-default-shared-mcp.ps1` |
| `embeddings.count` = 0 | **WARN** | Run `node generate-embeddings.js` |
| `embeddings.indexState` = `stale` | **WARN** | Run `node generate-embeddings.js` |
| `memoryIntegrity.status` ≠ `ok` | **ALERT** | Run `check-memory-integrity.js --strict` |
| Shared MCP port not listening | **ALERT** | Restart: `stop && start-default-shared-mcp.ps1` |

### Health Check
```bash
claude -p '{"tools":[{"name":"memory_status"}]}'
```
Look for: `watchdog.running: true`, `embeddings.indexState: aligned`, `memoryIntegrity.status: ok`

### Structured Error Taxonomy

| Error Key | Meaning | Resolution |
|-----------|---------|-----------|
| `bm25:provider-unavailable` | rank-bm25/jieba not installed | `pip install rank-bm25 jieba` |
| `bus-sync:timeout` | `memory-bus.ps1` exceeded 300s | Check vault path; reduce watched sources |
| `embeddings-refresh-failed:*` | Embedding generation failed | Check `AI_MEMORY_EMBED_*` env vars |
