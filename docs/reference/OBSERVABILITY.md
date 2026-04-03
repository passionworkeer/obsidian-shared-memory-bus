# Observability

## Log Format

All runtime components emit structured logs to stderr (for PowerShell/Node.js) or stdout (for Python). Log format:

```
{timestamp} [{level}] [{component}] {message} {context_json}
```

**Components**:
| Component | Source | Description |
|-----------|--------|-------------|
| `watchdog` | `memory-watchdog.ps1` | Watchdog scan, sync triggers, source change detection |
| `memory-bus` | `memory-bus.ps1` | Structured sync, artifact refresh operations |
| `mcp-server` | `omni-memory-server.js` | MCP tool calls, HTTP requests, retrieval dispatch |
| `semantic-search` | `semantic-search.py` | BM25, dense, hybrid search, cache hits/misses |
| `embeddings` | `generate-embeddings.js` | Embedding generation, provider calls, index writes |
| `blackboard-daemon` | `obsidian-blackboard-daemon.js` | Chokidar vault watch events |
| `openclaw-sync` | `sync-openclaw-to-obsidian.js` | OpenClaw structured ingestion |
| `memory-layers` | `build-memory-layers.js` | Layer building, promotion metadata stamping |

**Levels**:
| Level | When used |
|-------|-----------|
| `ERROR` | Operation failed (non-recoverable) |
| `WARN` | Operation succeeded but degraded (fallback used, timeout approaching) |
| `INFO` | Normal lifecycle events (server start/stop, sync complete, rebuild done) |
| `DEBUG` | Detailed execution trace (cache lookups, component decisions) |

---

## Key Metrics

### Retrieval Metrics

| Metric | Source | Good | Warn | Alert |
|--------|--------|------|------|-------|
| `memory.retrieval.latency_ms.p50` | `memory_status` | < 200ms | 200–1000ms | > 1000ms |
| `memory.retrieval.latency_ms.p95` | `memory_status` | < 500ms | 500–2000ms | > 2000ms |
| `memory.retrieval.latency_ms.p99` | `memory_status` | < 2000ms | 2000–5000ms | > 5000ms |
| `memory.retrieval.query_count` | `memory_status` | stable growth | — | — |
| `memory.retrieval.cache_hit_rate` | `memory_status` | > 60% | 30–60% | < 30% |
| `memory.retrieval.effective_mode` | per query | `hybrid` | `bm25` fallback | — |

### Embeddings Metrics

| Metric | Source | Good | Warn |
|--------|--------|------|------|
| `memory.embeddings.count` | `memory_status` | growing | 0 (not built) |
| `memory.embeddings.cache_hit_rate` | `memory_status` | > 80% | < 50% |
| `memory.embeddings.index_state` | `memory_status` | `aligned` | `stale`, `mixed`, `missing` |
| `memory.embeddings.last_build_age_sec` | computed | < 3600s | > 86400s (24h) |

### Structured Memory Metrics

| Metric | Source | Good | Warn |
|--------|--------|------|------|
| `memory.structured.record_count.total` | `memory_status` | growing | 0 |
| `memory.structured.record_count.{layer}` | `memory_status` | stable per layer | sudden drop |
| `memory.structured.signature_stale` | `memory_status` | `false` | `true` (artifacts out of sync) |

### Watchdog Metrics

| Metric | Source | Good | Warn | Alert |
|--------|--------|------|------|-------|
| `memory.watchdog.running` | `memory_status` | `true` | — | `false` |
| `memory.watchdog.pid` | `memory_status` | non-zero, stable | — | 0 |
| `memory.watchdog.last_sync_age_sec` | computed | < 60s | 60–300s | > 300s |
| `memory.watchdog.last_reason` | `memory_status` | `watchdog-idle` | `watchdog-change:*` spike | — |

---

## Health Check

### Via `memory_status` (MCP tool)

```bash
claude -p '{"tools":[{"name":"memory_status"}]}'
```

Look for:
```json
{
  "watchdog": { "running": true, "pid": 1234 },
  "embeddings": { "count": 4002, "indexState": "aligned" },
  "claudeMem": { "initialized": true },
  "memoryIntegrity": { "status": "ok" }
}
```

### Via File System

```powershell
# Watchdog state
Get-Content ~/.ai-memory/watchdog-state.json | ConvertFrom-Json

# Check if embeddings exist
Test-Path ~/.ai-memory/embeddings/index.jsonl
```

---

## Alert Thresholds

| Condition | Severity | Action |
|-----------|----------|--------|
| `watchdog.running` → `false` | **ALERT** | Restart: `start-default-shared-mcp.ps1` |
| `last_sync_age_sec` > 300 | **WARN** | Run `memory-watchdog.ps1 -Once` |
| `embeddings.count` = 0 | **WARN** | Run `node generate-embeddings.js` |
| `embeddings.indexState` = `stale` | **WARN** | Run `node generate-embeddings.js` |
| `embeddings.indexState` = `mixed` | **ALERT** | Force rebuild: `node generate-embeddings.js --force` |
| `retrieval.latency_ms.p99` > 5000 | **WARN** | Check embedding provider; consider BM25-only fallback |
| `memoryIntegrity.status` ≠ `ok` | **ALERT** | Run `ops/check-memory-integrity.js --strict` |
| Shared MCP port not listening | **ALERT** | Restart: `stop-shared-mcp.ps1 && start-default-shared-mcp.ps1` |

---

## Structured Error Taxonomy

| Error Key | Component | Meaning | Resolution |
|-----------|-----------|---------|-----------|
| `watchdog-scan:claude-mem` repeated | watchdog | claude-mem source file changed | Normal behavior — no action needed |
| `bus-sync:timeout` | watchdog | `memory-bus.ps1` exceeded 300s | Check vault path; reduce watched sources |
| `generated-artifacts-timeout:*` | watchdog | artifact build exceeded 180s | Normal if vault is large; verify structured JSONL size |
| `embeddings-refresh-failed:*` | watchdog | embedding generation failed | Check `AI_MEMORY_EMBED_*` env vars; run `generate-embeddings.js` manually |
| `openclaw-sync:exitcode-*` | watchdog | OpenClaw sync failed | Verify `OPENCLAW_HOME` path; check `.openclaw/workspace/memory/` |
| `bm25:provider-unavailable` | semantic-search | rank-bm25/jieba not installed | Run: `pip install rank-bm25 jieba` in Python env |
| `dense:api-error` | semantic-search | Remote embedding provider returned error | Check API key, endpoint, rate limits |

---

## Grafana / Prometheus Integration (Roadmap)

Planned endpoint: `GET /metrics` on the shared MCP HTTP port (9338) exposing Prometheus-format metrics.

Pending items on the Roadmap:
- Prometheus metrics endpoint (Backlog)
- Slack or webhook alerting for watchdog failures (Backlog)

Until those are implemented, use `memory_status` MCP calls via a cron job to poll and alert externally.
