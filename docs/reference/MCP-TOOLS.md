# Omni-Memory-Mesh MCP Tools Reference

> **Server**: `omni-memory-mesh` v3.1.0  
> **Source**: `shared-mcp/omni-memory-server.js`  
> **Protocol**: MCP over stdio  
> **Python dependency**: Required (semantic search, blackboard SQLite)  
> **Node.js dependency**: Required (embeddings generation, PowerShell bus scripts)

---

## Table of Contents

1. [Retrieval](#1-retrieval)
2. [Embeddings](#2-embeddings)
3. [Memory Build](#3-memory-build)
4. [Compatibility](#4-compatibility)
5. [Blackboard](#5-blackboard)

---

## 1. Retrieval

### `search_shared_memory`

**Primary** search tool. Queries the canonical shared Obsidian memory bus across Codex, Claude Code, OpenCode, Copilot, Cursor, Trae, and OpenClaw. Defaults to hybrid retrieval and falls back to BM25 when dense embeddings are unavailable.

**Implementation**: Spawns a persistent Node.js search worker (JSONL-over-stdin/stdout IPC) backed by a Python semantic search subprocess. If the worker is unavailable, falls back to a one-shot Python process. Timeout is **120 seconds**.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `query` | `string` | — | **Yes** | Natural-language search query. |
| `mode` | `string` | `"hybrid"` | No | Retrieval mode: `bm25`, `dense`, `hybrid`, `auto`. `hybrid` is recommended. |
| `strategy` | `string` | — | No | Alias for `mode`. |
| `route` | `string` | `"auto"` | No | Query routing profile: `auto`, `mixed`, `durable`, `task`, `recent`, `reference`. `auto` infers best layer mix from query intent. |
| `limit` | `number` | `8` | No | Maximum number of results returned. |
| `tool` | `string` | `""` | No | Exact tool filter (substring match on tool name). |
| `project` | `string` | `""` | No | Project/workspace substring filter. |
| `scope` | `string` | `""` | No | Scope filter: `user`, `feedback`, `project`, `task`, `run`, `summary`. |
| `sourceKind` | `string` | `""` | No | Source kind filter: `session`, `writeback`, `cron`, `run`, `blackboard`. |
| `workspace` | `string` | `""` | No | Workspace filter. |
| `taskState` | `string` | `""` | No | Task state filter. |
| `preferSummaries` | `boolean` | `false` | No | Boost session/summary records in ranking. |

**Output**

```json
{
  "ok": true,
  "results": [
    {
      "content": "...",
      "source": "...",
      "tool": "...",
      "score": 0.95,
      "metadata": { ... }
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `ok` | `boolean` | Whether the search succeeded. |
| `results` | `array` | Array of matching memory records. |
| `results[].content` | `string` | Text content of the memory entry. |
| `results[].source` | `string` | File or origin of the entry. |
| `results[].tool` | `string` | Originating tool that created the entry. |
| `results[].score` | `number` | Relevance score (0–1). |
| `results[].metadata` | `object` | Additional entry metadata. |

**Notes**
- Calls Python (`semantic-search.py`) — Python runtime must be available.
- Cache behavior: the persistent search worker caches query/BM25/result data in-memory. Use `clear_shared_memory_search_cache` to reset.
- Timeout: 120 000 ms for the primary worker request.
- Route values are case-normalized to lowercase.
- Falls back to one-shot spawn if the persistent worker exits.

---

### `clear_shared_memory_search_cache`

Clears the persistent search worker's in-memory caches. Optionally also drops loaded entry and embeddings index data so the next query fully reloads from disk.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `includeDataCaches` | `boolean` | `false` | No | When `true`, also drops loaded entries and embeddings index caches in addition to query/BM25/result caches. |

**Output**

```json
{
  "ok": true,
  "cleared": true,
  "includeDataCaches": false
}
```

**Notes**
- Pure Node.js (IPC with search worker). No Python call.
- Timeout: 30 000 ms.
- Does not clear the embeddings index file on disk — only in-memory caches.

---

### `list_embedding_runtimes`

Lists the configured embedding defaults, providers, and profiles, along with the currently resolved active runtime and whether the dense index is aligned or needs a rebuild.

**Input**: none

**Output**

```json
{
  "ok": true,
  "catalog": {
    "runtime": {
      "profile": "...",
      "provider": "...",
      "adapter": "hash",
      "model": "all-MiniLM-L6-v2",
      "baseUrl": "...",
      "apiKeyConfigured": true,
      "configHash": "abc123",
      "indexedCount": 42,
      "indexCompatible": true,
      "rebuildRequired": false
    },
    "providers": [ ... ],
    "profiles": [ ... ]
  },
  "embeddingIndexState": {
    "status": "aligned",
    "rebuildRequired": false,
    "activeConfigHash": "abc123",
    "indexedConfigHash": "abc123"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `catalog.runtime` | `object` | Currently active embedding runtime. |
| `catalog.providers` | `array` | All available provider configurations. |
| `catalog.profiles` | `array` | All available named profiles. |
| `embeddingIndexState.status` | `string` | `aligned`, `stale`, `missing`, `mixed`. |
| `embeddingIndexState.rebuildRequired` | `boolean` | Whether `rebuild_memory_embeddings` should be run. |

**Notes**
- Pure Node.js — reads config files and `embeddings/index.jsonl`.
- No timeout (local file reads only).

---

## 2. Embeddings

### `rebuild_memory_embeddings`

Rebuilds the dense embeddings index from shared Obsidian structured memory. Spawns `generate-embeddings.js` (Node.js) which walks the structured memory directory and computes vector embeddings for each record.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `force` | `boolean` | `false` | No | Re-embed even unchanged records (bypass diff). |

**Output**

```json
{
  "ok": true,
  "command": "node /path/to/generate-embeddings.js --force",
  "stdout": "...",
  "stderr": "...",
  "summary": {
    "exists": true,
    "count": 137,
    "bytes": 48120,
    "tools": { "claude-code": 42, "cursor": 95 },
    "backends": { "openai": 42, "hash": 95 },
    "models": { "text-embedding-3-small": 42 },
    "dimensions": { "384": 95, "1536": 42 }
  }
}
```

**Notes**
- Calls Node.js (`generate-embeddings.js`), not Python.
- Writes to `embeddings/index.jsonl` in the store (`AI_MEMORY_STORE`).
- No fixed timeout; relies on subprocess completion.
- `force: true` bypasses content-hash diff checks and re-embeds all records.

---

### `rebuild_shared_embeddings`

**Alias** for `rebuild_memory_embeddings`. Identical input, output, and behavior.

---

### `set_embedding_runtime`

Activates an embedding profile or provider in the runtime config file. Returns the updated runtime selection and whether the dense embeddings index now needs a rebuild. Automatically restarts the search worker if it was running and the runtime signature changed.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `profile` | `string` | `""` | No | Configured embedding profile name to activate. |
| `provider` | `string` | `""` | No | Provider name to activate directly. |
| `clearProfile` | `boolean` | `false` | No | Clear the persisted `activeProfile` selection. |
| `clearProvider` | `boolean` | `false` | No | Clear the persisted `activeProvider` selection. |

**Output**

```json
{
  "ok": true,
  "runtimeChanged": true,
  "catalog": { ... },
  "embeddingIndexState": { "status": "stale", "rebuildRequired": true },
  "searchWorkerRestart": {
    "ok": true,
    "requested": true,
    "previousPid": 1234,
    "currentPid": 5678,
    "pidChanged": true,
    "stop": { "stopped": true, "exitCode": 0 }
  }
}
```

**Notes**
- Pure Node.js — writes `runtime-config.json`.
- If the search worker was running and the runtime signature changed, the worker is restarted automatically (SIGTERM, 5 s timeout, then SIGKILL).
- After calling this tool, `rebuild_memory_embeddings` may be needed if `embeddingIndexState.rebuildRequired` is `true`.

---

## 3. Memory Build

### `rebuild_memory_layers`

Rebuilds derived shared memory layers: shared inbox records, session-layer records, and shared event records. Invokes `memory-bus.ps1` via PowerShell.

**Input**: none

**Output**

```json
{
  "ok": true,
  "stdout": "...",
  "stderr": "...",
  "summary": {
    "generatedAt": "2026-04-04T...",
    "layers": { ... }
  }
}
```

**Notes**
- Calls PowerShell (`memory-bus.ps1 RefreshDerivedArtifacts`).
- Python: not required.
- Reads back `MEMORY-LAYERS.json` from the store generated folder.
- No fixed timeout.

---

### `build_handoff_pack`

Builds a bounded handoff pack with current goal, done, next, blocked, files, open threads, and tool invariants. Also invokes `memory-bus.ps1`.

**Input**: none

**Output**

```json
{
  "ok": true,
  "stdout": "...",
  "stderr": "...",
  "summary": {
    "goal": "...",
    "done": [ ... ],
    "next": [ ... ],
    "blocked": [ ... ],
    "files": [ ... ],
    "threads": [ ... ],
    "toolInvariants": { ... }
  }
}
```

**Notes**
- Calls PowerShell (`memory-bus.ps1 RefreshDerivedArtifacts`).
- Reads back `HANDOFF.json` from the store generated folder.
- No fixed timeout.

---

### `run_memory_dream`

Runs one memory dream consolidation pass over durable, session, and task layers to refresh `AUTO-DREAM` summaries.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `force` | `boolean` | `false` | No | Force a dream pass even when internal gates would normally skip. |

**Output**

```json
{
  "ok": true,
  "stdout": "...",
  "stderr": "...",
  "summary": { ... },
  "force": true
}
```

**Notes**
- Calls PowerShell (`memory-bus.ps1 RefreshDerivedArtifacts`).
- Reads back `AUTO-DREAM.json` from the store generated folder.
- No fixed timeout.

---

## 4. Compatibility

### `query_claude_mem`

Queries the local `claude-mem` semantic memory API directly at `http://127.0.0.1:37778`. For the canonical cross-tool shared layer, use `search_shared_memory` instead.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `query` | `string` | — | **Yes** | Semantic query string. |
| `limit` | `number` | `5` | No | Maximum number of results. |

**Output**

```json
{
  "ok": true,
  "query": "...",
  "response": {
    "results": [ ... ]
  }
}
```

**Notes**
- Calls HTTP API on `http://127.0.0.1:37778/api/search`.
- Node.js `fetch` (no external HTTP library needed).
- The `claude-mem` service must be running locally (port 37778).
- On upstream non-success responses, the tool returns a structured failure payload with `route`, `status`, `statusText`, `contentType`, plus either `response` or `responseText`.
- No timeout set on the fetch call.

---

### `insert_claude_mem`

Inserts a new item into the local `claude-mem` store.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `content` | `string` | — | **Yes** | Memory content to insert. |
| `metadata` | `object` | `{}` | No | Optional arbitrary key-value metadata. |

**Output**

```json
{
  "ok": true,
  "route": "/api/memory/save",
  "verifiedPersistence": true,
  "warning": "...",
  "verification": {
    "verified": true,
    "source": "observations",
    "observation": {
      "id": 2482,
      "title": "codex-bridge-probe",
      "project": "local-ai-memory-bus"
    }
  },
  "response": {
    "id": "...",
    "created": true
  }
}
```

**Notes**
- Primary write path is HTTP POST `http://127.0.0.1:37778/api/memory/save`.
- If the current worker returns `404` on the modern route, falls back to legacy `http://127.0.0.1:37778/api/memories`.
- Derives `title` and `project` from common metadata keys when present (`title`, `summary`, `subject`, `project`, `workspace`, `repo`, etc.).
- If `/api/memory/save` returns a non-success status after the observation is already persisted, the bridge verifies the write through `/api/observations` and returns `verifiedPersistence: true`.
- On non-success results that cannot be verified, the tool returns a structured failure payload with `failures[]`.
- Node.js `fetch` with `Content-Type: application/json`.
- `claude-mem` service must be running.

---

## 5. Blackboard

### `memory_status`

High-level health check of the entire shared memory stack. Returns watchdog state, contract/integrity status, embeddings index summary, search worker health, and `claude-mem` health — all in one call.

**Input**: none

**Output**

```json
{
  "ok": true,
  "generatedAt": "2026-04-04T10:00:00.000Z",
  "pythonRuntime": {
    "command": "python",
    "argsPrefix": [],
    "source": "resolved",
    "available": true,
    "version": "3.11.0"
  },
  "searchWorker": {
    "enabled": true,
    "running": true,
    "pid": 12345,
    "startedAt": "2026-04-04T09:55:00.000Z",
    "pendingRequests": 0,
    "restartCount": 0,
    "lastError": "",
    "health": { "ok": true, "status": "ready" }
  },
  "watchdog": {
    "pid": 67890,
    "running": true,
    "stale": false,
    "stateAgeSeconds": 12,
    "status": "running"
  },
  "memoryIntegrity": { "ok": true, "files": [ ... ] },
  "embeddingRuntime": { ... },
  "embeddingIndexState": { "status": "aligned", "rebuildRequired": false },
  "embeddings": { "exists": true, "count": 137 },
  "handoffPack": { ... },
  "memoryLayers": { ... },
  "autoDream": { ... },
  "claudeMem": { "ok": true, "status": "ok" }
}
```

| Field | Type | Description |
|---|---|---|
| `pythonRuntime` | `object` | Python interpreter resolution result. |
| `searchWorker` | `object` | Persistent search worker state. |
| `watchdog` | `object` | `memory-watchdog.ps1` process state. |
| `memoryIntegrity` | `object` | File contract integrity report. |
| `embeddingRuntime` | `object` | Active embedding runtime config. |
| `embeddingIndexState` | `object` | Index alignment vs. runtime. |
| `embeddings` | `object` | Embeddings index file statistics. |
| `claudeMem` | `object` | `claude-mem` HTTP health check result. |

**Notes**
- Pure Node.js — no Python or PowerShell subprocesses.
- No timeout (local reads and in-process health pings only).
- This is the best first call to diagnose any shared memory bus issue.

---

### `get_blackboard_tasks`

Reads recent OpenClaw blackboard tasks from the shared AI Shrimp SQLite blackboard (`tasks.db`).

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `limit` | `number` | `10` | No | Maximum rows to return. |
| `state` | `string` | `""` | No | Single state filter (case-insensitive). |
| `states` | `array<string>` | `[]` | No | Multiple state filters, e.g. `["PENDING", "ACTIVE"]`. |

**Output**

```json
{
  "ok": true,
  "rows": [
    {
      "id": 1,
      "repo": "owner/repo",
      "issue_number": 42,
      "issue_title": "Fix memory leak",
      "state": "PENDING",
      "assigned_agent": "intel",
      "processor": "",
      "updated_at": "2026-04-04T..."
    }
  ]
}
```

**Notes**
- Calls Python (inline SQLite script) via `spawnProcess`.
- Python runtime must be available.
- State values are normalized to uppercase strings.
- `limit` is clamped to `max(1, limit)`.

---

### `write_blackboard_task`

Inserts a new task record into the OpenClaw blackboard SQLite database.

**Input**

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `repo` | `string` | — | **Yes** | Repository name, e.g. `browser-use/browser-use`. |
| `issue_number` | `number` | — | **Yes** | GitHub issue number. |
| `assigned_agent` | `string` | `"intel"` | No | OpenClaw agent lane: `intel` or `developer`. |
| `issue_title` | `string` | `""` | No | Optional issue title. |

**Output**

```json
{
  "ok": true,
  "insertedId": 42
}
```

**Error output**

```json
{
  "ok": false,
  "error": "blackboard-db-missing: ..."
}
```

**Notes**
- Calls Python (inline SQLite script) via `spawnProcess`.
- Python runtime must be available.
- Inserts with state `PENDING` unconditionally.
- `assigned_agent` defaults to `"intel"` if omitted or empty.
- `issue_title` defaults to `"{repo}#{issue_number}"` if omitted.

---

## Tool Summary Matrix

| Tool | Category | Python | PowerShell | Node.js Only | HTTP | SQLite | Timeout |
|---|---|---|---|---|---|---|---|
| `memory_status` | Retrieval | No | No | **Yes** | No | No | none |
| `search_shared_memory` | Retrieval | **Yes** | No | No | No | No | 120 s |
| `clear_shared_memory_search_cache` | Retrieval | No | No | **Yes** | No | No | 30 s |
| `list_embedding_runtimes` | Embeddings | No | No | **Yes** | No | No | none |
| `set_embedding_runtime` | Embeddings | No | No | **Yes** | No | No | 5 s (worker) |
| `rebuild_memory_embeddings` | Embeddings | No | No | **Yes** | No | No | subprocess |
| `rebuild_shared_embeddings` | Embeddings | No | No | **Yes** | No | No | subprocess |
| `rebuild_memory_layers` | Memory Build | No | **Yes** | No | No | No | subprocess |
| `build_handoff_pack` | Memory Build | No | **Yes** | No | No | No | subprocess |
| `run_memory_dream` | Memory Build | No | **Yes** | No | No | No | subprocess |
| `query_claude_mem` | Compatibility | No | No | **Yes** | **Yes** | No | none |
| `insert_claude_mem` | Compatibility | No | No | **Yes** | **Yes** | No | none |
| `get_blackboard_tasks` | Blackboard | **Yes** | No | No | No | **Yes** | none |
| `write_blackboard_task` | Blackboard | **Yes** | No | No | No | **Yes** | none |

---

## Runtime Requirements

| Runtime | Purpose | Default Path Resolution |
|---|---|---|
| Python | Semantic search, SQLite blackboard | `AI_MEMORY_PYTHON`, then `python`/`python3` |
| PowerShell | Memory bus scripts (`RefreshDerivedArtifacts`) | `pwsh` on Unix; `powershell.exe` on Windows |
| Node.js | Embeddings generation, server itself | `process.execPath` (the running Node) |
| claude-mem HTTP | Local semantic memory API | `http://127.0.0.1:37778` (configurable via `CLAUDE_MEM_BASE`) |
| SQLite | OpenClaw blackboard | `~/.openclaw/workspace/ai-shrimp/blackboard/tasks.db` |
