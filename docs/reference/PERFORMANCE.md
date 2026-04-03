# Performance

## Retrieval Latency

### Observed Ranges (live system)

| Mode | Condition | p50 | p95 | p99 |
|------|-----------|-----|-----|-----|
| `hybrid` | warm cache (query embedding cached) | 50–200ms | 200–500ms | 500–1500ms |
| `hybrid` | cold (Python spawn + embed query) | 500–2000ms | 2000–5000ms | 5000–12000ms |
| `bm25` | warm cache | 20–100ms | 100–300ms | 300–800ms |
| `dense` | warm cache (index aligned) | 80–300ms | 300–1000ms | 1000–3000ms |

> **Cold vs warm**: The Python search worker is kept warm by the shared `memory` MCP. First query after a long idle period triggers a cold Python spawn (~500ms overhead).

### Retrieval Latency by Stage

```
Cold query latency breakdown (hybrid mode):
  MCP HTTP round-trip        ~5–20ms
  Node.js → Python spawn     ~100–300ms
  Python: query embedding    ~50–2000ms (provider dependent)
  Python: BM25 search        ~10–50ms
  Python: dense search        ~20–100ms
  Python: hybrid merge        ~5–20ms
  Python → JSON round-trip   ~5–20ms
  ─────────────────────────────────
  Total cold:                 ~200–2500ms

Warm query (query embedding cached, worker alive):
  Skip Python spawn + query embed:  ~50–300ms total
```

---

## Retrieval Quality: BM25 vs Dense vs Hybrid

### Architecture Benchmark (benchmark-architecture.py)

The benchmark runs 5 canonical queries against all three modes and checks that expected keyword anchors appear in top results:

| Query | BM25 keyword anchors | Dense keyword anchors | Hybrid anchors |
|-------|--------------------|--------------------|----------------|
| `openclaw blackboard task state` | blackboard, task, openclaw | blackboard, task, openclaw | all 3 ✓ |
| `openclaw subagent run model status` | run, model, status | run, model, status | all 3 ✓ |
| `claude session memory snapshot` | session, claude | session, claude | all 3 ✓ |
| `durable shared inbox preference workflow` | preference, workflow, shared | preference, workflow, shared | all 3 ✓ |
| `memory layers watchdog auto dream` | memory, dream, layer | memory, dream, layer | all 3 ✓ |

**Benchmark command**:
```bash
python retrieval/benchmark-architecture.py --json
```

### When to Use Each Mode

| Mode | Best for | Weakness |
|------|---------|---------|
| `bm25` | keyword-heavy queries, offline mode, API key unavailable | misses semantic similarity |
| `dense` | conversational questions, intent queries | misses exact terminology |
| `hybrid` (default) | most queries | slightly higher latency than single-mode |

---

## Embedding Backend Comparison

### Offline (hashing-v1) vs Remote (OpenAI-compatible)

| Property | hashing-v1 (default) | Remote (OpenAI-compatible) |
|----------|---------------------|--------------------------|
| API cost | $0 | depends on provider |
| Network | offline | requires endpoint reachable |
| Latency (cold query) | 10–50ms | 50–2000ms + network RTT |
| Latency (cache hit) | 10–50ms | 10–50ms |
| Dimensionality | configurable (runtime.json) | fixed by model (usually 256–4096) |
| Semantic quality | lower | higher |
| China mainland reachability | always works | varies by provider |

> The canary benchmark (benchmark-backends.py) on a 12-row topical sample showed that `hashing-v1` and `Qwen/Qwen3-Embedding-0.6B` returned the same top-3 anchors for the three key queries. Remote models mainly change secondary/tertiary neighbors rather than primary results on small vaults.

---

## Scale Limits

### Structured JSONL

| Limit | Value | Rationale |
|-------|-------|-----------|
| Recommended max per file | **10 MB** | PowerShell JSON parsing degrades above this |
| Recommended max per layer | **50k records** | Retrieval quality degrades above this |
| Coalesced structured total | **~2500 records** (current observed) | With ~2500 records, hybrid search completes in < 500ms warm |

### Embeddings Index

| Limit | Value | Rationale |
|-------|-------|-----------|
| Recommended max chunks | **100k** | sqlite-vec memory constraint; very large vaults |
| Current observed count | **~2500–4000** (varies by vault) | Typical single-user vault |
| Rebuild time per 1000 records | **~10s** (hashing-v1), **~30–120s** (remote API) | Plus network latency for remote |

### Concurrent Retrieval Workers

| Setting | Default | Max | Notes |
|---------|---------|-----|-------|
| Search worker count | **1** | 4 | Worker is persistent inside the MCP process |
| Concurrent queries per worker | **unlimited** | — | Node.js async handles concurrency |

> Increasing workers beyond 1 does not help unless you have multiple CPU cores and are CPU-bound on retrieval. Most vaults are I/O-bound (network for remote embeddings, disk for JSONL reads).

### Concurrent Embeddings Rebuilds

| Setting | Value | Notes |
|---------|-------|-------|
| Embeddings rebuild workers | **1** | Only one rebuild runs at a time (watchdog cooldown: 180s) |
| Embeddings API batch size | configurable (default 32) | Larger batches reduce API round-trips |

---

## Embedding Cache Hit Rate

The system maintains two caches:

| Cache | TTL | What it caches |
|-------|-----|--------------|
| Query embedding cache | 30s | Per-query dense vector in `semantic-search.py` |
| Result cache | 30s | Per-query BM25 + dense + hybrid merged results |
| Embedding index cache | process lifetime | `embeddings/index.jsonl` loaded once per worker |

**Target hit rates**:
| Scenario | BM25 cache hit | Dense cache hit | Result cache hit |
|----------|--------------|----------------|-----------------|
| Repeated same query | N/A (BM25 always runs) | ~100% | ~100% |
| Repeated similar query | ~80% (same terms) | ~60% (query embedding cached) | ~60% |
| Fresh queries | 0% | 0% | 0% |

> The `memory_status` tool reports `embeddingCacheHitRate` for the embedding cache and `searchResultCacheHitRate` for the result cache.

---

## ADR-001 vs ADR-002 Performance Comparison

ADR-002 closes key performance gaps identified in ADR-001:

| Gap | ADR-001 behavior | ADR-002 behavior |
|-----|-----------------|-----------------|
| Phase 1 search | frontmatter keyword only | BM25 over full chunk content |
| Session consolidation | O(n) — full file re-read | O(changed_chunks) — chunk manifests |
| Embedding cost | re-embed on every query | embedding cache prevents re-embed |
| Concurrent consolidation | race condition possible | Phase 3 lock serializes writes |
| Retrieval quality | keyword fallback | hybrid BM25 + dense + MMR |

See [`ADR-002-unified-memory-architecture-v2.md`](ADR-002-unified-memory-architecture-v2.md) for the full ADR benchmarking evidence.
