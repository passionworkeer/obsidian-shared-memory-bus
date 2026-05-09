---
title: MCP Tool API Reference
description: Complete reference for all MCP tools exposed by the shared memory bus (omni-memory-server.js).
platform: cross-platform
---

# MCP Tool API Reference / MCP 工具 API 参考

> English: Complete parameter and output reference for every tool exposed by the shared `memory` MCP server at port 9338.
> 中文：共享 `memory` MCP 服务器（端口 9338）暴露的所有工具的完整参数和输出参考。

**Server**: `omni-memory-mesh` v3.1.0
**Transport**: HTTP via shared MCP proxy (port 9338)
**Python dependency**: Required for retrieval and blackboard tools
**PowerShell dependency**: Required for memory build tools

For a visual tool-by-tool dependency matrix, see [`docs/reference/MCP-TOOLS.md`](../reference/MCP-TOOLS.md).

---

## Tool Summary / 工具概览

| Tool | Category | Python | PowerShell | Node.js Only | Timeout |
|------|----------|--------|------------|--------------|---------|
| `memory_status` | Health | No | No | **Yes** | none |
| `memory_wake_up` | Bootstrap | No | No | **Yes** | 30 s |
| `search_shared_memory` | Retrieval | **Yes** | No | No | 120 s |
| `clear_shared_memory_search_cache` | Retrieval | No | No | **Yes** | 30 s |
| `list_embedding_runtimes` | Embeddings | No | No | **Yes** | none |
| `set_embedding_runtime` | Embeddings | No | No | **Yes** | 5 s |
| `rebuild_memory_embeddings` | Embeddings | No | No | **Yes** | subprocess |
| `rebuild_shared_embeddings` | Embeddings | No | No | **Yes** | subprocess |
| `rebuild_memory_layers` | Memory Build | No | **Yes** | No | subprocess |
| `build_handoff_pack` | Memory Build | No | **Yes** | No | subprocess |
| `run_memory_dream` | Memory Build | No | **Yes** | No | subprocess |
| `memory_boot` | Knowledge Graph | No | No | **Yes** | subprocess |
| `memory_query` | Knowledge Graph | No | No | **Yes** | subprocess |
| `memory_inbox` | Inbox | No | No | **Yes** | 10 s |
| `query_claude_mem` | Compatibility | No | No | **Yes** (HTTP) | none |
| `insert_claude_mem` | Compatibility | No | No | **Yes** (HTTP) | none |
| `get_blackboard_tasks` | Blackboard | **Yes** | No | No (SQLite) | none |
| `write_blackboard_task` | Blackboard | **Yes** | No | No (SQLite) | none |

---

## 1. Health / 健康状态

### `memory_status`

Returns a comprehensive health snapshot of the entire shared memory stack in a single call.

**Input**: none

**Output** (key fields):

```json
{
  "ok": true,
  "generatedAt": "2026-04-04T10:00:00.000Z",
  "pythonRuntime": {
    "command": "python3",
    "available": true,
    "version": "3.11.0"
  },
  "searchWorker": {
    "enabled": true,
    "running": true,
    "pid": 12345,
    "health": { "ok": true, "status": "ready" }
  },
  "searchWorkerCircuitBreaker": {
    "circuitOpen": false,
    "restartCount": 0,
    "maxRestarts": 5,
    "circuitWindowMs": 300000,
    "backpressureRejected": 0
  },
  "embeddingPool": {
    "healthyCount": 3,
    "totalCount": 3,
    "pendingRequests": 0,
    "backpressureLimit": 50,
    "poolSize": 3,
    "workers": [...]
  },
  "watchdog": {
    "running": true,
    "stale": false,
    "status": "running"
  },
  "memoryIntegrity": { "ok": true },
  "embeddingIndexState": {
    "status": "aligned",
    "rebuildRequired": false
  },
  "embeddings": { "exists": true, "count": 137 },
  "claudeMem": { "ok": true, "status": "ok" }
}
```

**Notes**:
- Pure Node.js — no subprocess calls. No timeout.
- This is the best first call when diagnosing any shared memory issue.
- `embeddingIndexState.status` values: `aligned`, `stale`, `missing`, `mixed`.
- `watchdog.stale: true` means the watchdog process has not reported in > 60 s.

---

## 2. Bootstrap / 引导

### `memory_wake_up`

Returns a compact layered wake-up context for session bootstrap. Combines identity anchors, current essentials, recent activity, and route suggestions.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `max_items` | `number` | `6` | No | Max items per section (identity, essential, recent, retrieve) |
| `include_recent_activity` | `boolean` | `false` | No | Include recent activity section |
| `include_essential` | `boolean` | `true` | No | Include essential/handoff facts |
| `include_identity` | `boolean` | `true` | No | Include durable identity anchors |
| `include_retrieve` | `boolean` | `true` | No | Include retrieve route suggestions |

**Output** (key sections):

```json
{
  "ok": true,
  "generated_at": "2026-04-04T...",
  "identity": [
    { "content": "User prefers Chinese responses", "source": "..." }
  ],
  "essential": [
    { "content": "Current project: local-ai-memory-bus", "source": "..." }
  ],
  "recent": [
    { "content": "Added cross-platform docs", "source": "..." }
  ],
  "retrieve_routes": [
    { "route": "durable", "reason": "user preference query" }
  ]
}
```

**Notes**:
- Uses `search_shared_memory` internally with `route=auto`.
- Route metadata (`queryIntent`, `queryRoute`, `layerCounts`) is returned alongside results.
- `includeVerbatim` on internal search is `false` by default for compactness.

---

## 3. Retrieval / 检索

### `search_shared_memory`

Primary search tool. Hybrid BM25 + dense retrieval with route-aware reranking, MMR, and temporal decay.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `query` | `string` | — | **Yes** | Natural-language search query |
| `mode` | `string` | `"hybrid"` | No | `bm25` / `dense` / `hybrid` / `auto` |
| `route` | `string` | `"auto"` | No | Query routing: `auto` / `mixed` / `durable` / `task` / `recent` / `reference` |
| `limit` | `number` | `8` | No | Max results |
| `tool` | `string` | `""` | No | Tool name substring filter |
| `project` | `string` | `""` | No | Project/workspace filter |
| `scope` | `string` | `""` | No | Scope: `user` / `feedback` / `project` / `task` / `run` / `summary` |
| `sourceKind` | `string` | `""` | No | Source kind: `session` / `writeback` / `cron` / `run` / `blackboard` |
| `workspace` | `string` | `""` | No | Workspace filter |
| `taskState` | `string` | `""` | No | Task state filter |
| `preferSummaries` | `boolean` | `false` | No | Boost session/summary records |
| `includeVerbatim` | `boolean` | `false` | No | Return exact snippet windows |
| `snippetWindow` | `number` | `220` | No | Snippet character window size |
| `maxVerbatimPerResult` | `number` | `1` | No | Max verbatim windows per result |
| `mmr` | `object` | `{}` | No | MMR diversity reranking: `{ enabled, lambda }`. `lambda` ∈ [0,1]: higher = more relevance, lower = more diversity. Default lambda=0.7 |
| `temporalDecay` | `object` | `{}` | No | Temporal decay: `{ enabled, halfLifeDays }`. Scores decay by 50% per half-life. Default: disabled, halfLifeDays=30 |

**Output**:

```json
{
  "ok": true,
  "results": [
    {
      "content": "User prefers Chinese responses",
      "source": "structured/shared-inbox.jsonl",
      "tool": "claude-code",
      "score": 0.95,
      "rankMeta": { "bm25Score": 0.4, "vecScore": 0.9 },
      "layer": "durable",
      "freshness": 0.85
    }
  ],
  "queryIntent": "user_preference",
  "queryRoute": "durable",
  "layerCounts": { "durable": 5, "task": 2, "recent": 1 }
}
```

**Fallback chain**: hybrid → BM25 only → frontmatter keyword only.

**Notes**:
- Requires Python runtime. Falls back to one-shot spawn if the persistent worker is unavailable.
- `route` values are case-normalized to lowercase.
- `snippetWindow` is the character count kept around each exact match when `includeVerbatim=true`.

### `clear_shared_memory_search_cache`

Clears the persistent search worker's in-memory caches.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `includeDataCaches` | `boolean` | `false` | No | Also drop loaded entries and embeddings index |

**Output**:

```json
{
  "ok": true,
  "cleared": true,
  "includeDataCaches": false
}
```

---

## 4. Embeddings / Embedding 管理

### `list_embedding_runtimes`

Inspect the configured embedding defaults, providers, profiles, and current index alignment state.

**Input**: none

**Output**:

```json
{
  "ok": true,
  "catalog": {
    "runtime": {
      "profile": "hashing-v1",
      "provider": "local-hash",
      "adapter": "hash",
      "model": "all-MiniLM-L6-v2",
      "configHash": "abc123",
      "indexedCount": 137,
      "indexCompatible": true,
      "rebuildRequired": false
    },
    "providers": [ ... ],
    "profiles": [ ... ]
  },
  "embeddingIndexState": {
    "status": "aligned",
    "rebuildRequired": false
  }
}
```

### `set_embedding_runtime`

Switch the active embedding profile or provider. Automatically restarts the search worker if the runtime signature changed.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `profile` | `string` | `""` | No | Profile name to activate |
| `provider` | `string` | `""` | No | Provider name to activate |
| `clearProfile` | `boolean` | `false` | No | Clear persisted active profile |
| `clearProvider` | `boolean` | `false` | No | Clear persisted active provider |

**Output**:

```json
{
  "ok": true,
  "runtimeChanged": true,
  "embeddingIndexState": { "status": "stale", "rebuildRequired": true },
  "searchWorkerRestart": {
    "ok": true,
    "requested": true,
    "previousPid": 1234,
    "currentPid": 5678,
    "pidChanged": true
  }
}
```

**Notes**:
- After calling this, `rebuild_memory_embeddings` is required if `embeddingIndexState.rebuildRequired` is `true`.
- Search worker is restarted automatically if the runtime signature changed.

### `rebuild_memory_embeddings` / `rebuild_shared_embeddings`

Rebuild the dense embeddings index from all structured memory records.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `force` | `boolean` | `false` | No | Re-embed all records (bypass diff) |

**Output**:

```json
{
  "ok": true,
  "command": "node /path/to/generate-embeddings.js --force",
  "summary": {
    "exists": true,
    "count": 137,
    "bytes": 48120,
    "tools": { "claude-code": 42, "cursor": 95 },
    "backends": { "openai": 42, "hash": 95 }
  }
}
```

---

## 5. Memory Build / 内存构建

### `rebuild_memory_layers`

Rebuilds derived memory layers from structured JSONL records. Invokes `memory-bus.ps1 RefreshDerivedArtifacts`.

**Input**: none

### `build_handoff_pack`

Builds a bounded handoff packet (goal / done / next / blocked / files / open threads / tool invariants).

**Input**: none

### `run_memory_dream`

Runs a memory consolidation pass over durable, session, and task layers to refresh `AUTO-DREAM` summaries.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `force` | `boolean` | `false` | No | Force a pass even when internal gates would skip |

---

## 6. Knowledge Graph / 知识图谱

### `memory_boot`

Initialises or returns the knowledge graph bootstrap context.

**Input**: none

**Output**: KG identity + top entities + recent facts.

### `memory_query`

Queries the knowledge graph for entity relationships and facts.

**Input**:

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `query` | `string` | — | **Yes** | Natural-language query |
| `limit` | `number` | `5` | No | Max results |

---

## 7. Inbox / 收件箱

### `memory_inbox`

Reads the current agent's inbox file from the store.

**Input**: none

**Output**: Array of inbox entries from `{store}/inbox/{tool}.md`.

---

## 8. Compatibility / 兼容性桥接

### `query_claude_mem`

Queries the local `claude-mem` HTTP API at `http://127.0.0.1:37778`.

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `query` | `string` | — | **Yes** | Semantic query |
| `limit` | `number` | `5` | No | Max results |

### `insert_claude_mem`

Inserts an item into the local `claude-mem` store.

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `content` | `string` | — | **Yes** | Memory content |
| `metadata` | `object` | `{}` | No | Optional key-value metadata |

---

## 9. Blackboard / 黑板

### `get_blackboard_tasks`

Reads OpenClaw blackboard tasks from the shared SQLite database.

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `limit` | `number` | `10` | No | Max rows |
| `state` | `string` | `""` | No | Single state filter |
| `states` | `array<string>` | `[]` | No | Multiple state filters |

### `write_blackboard_task`

Inserts a new task record into the OpenClaw blackboard.

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `repo` | `string` | — | **Yes** | Repository name (e.g. `owner/repo`) |
| `issue_number` | `number` | — | **Yes** | GitHub issue number |
| `assigned_agent` | `string` | `"intel"` | No | `intel` or `developer` |
| `issue_title` | `string` | `""` | No | Optional issue title |
