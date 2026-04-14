# Data Flow

## End-to-End Architecture

This document maps the complete data flow from agent activity to shared memory retrieval, across all three runtime languages (PowerShell, Node.js, Python).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENTS                                          │
│   Claude Code · Codex · OpenCode · Cursor · Copilot · Trae · OpenClaw        │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ tool calls, stopHooks, MCP protocol
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SHARED MCP TRANSPORT LAYER                               │
│   HTTP → omni-memory-server.js (port 9338)                                   │
│   HTTP → obsidian MCP server (port 9335)                                     │
│   HTTP → context7 · fetch · time · sequential-thinking · playwright        │
└──────┬────────────────────┬──────────────────────────┬──────────────────────┘
       │                    │                          │
       │ Node.js spawns     │ Node.js stdio proxy      │ Node.js spawns
       │ Python retrieval    │ for playwright           │
       ▼                    ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      NODE.JS BUSINESS LAYER                                 │
│                                                                              │
│  generate-embeddings.js    ← generates embeddings index                     │
│  build-memory-layers.js    ← builds MEMORY-LAYERS.json from structured/     │
│  build-handoff-pack.js     ← builds HANDOFF.json for next agent             │
│  sync-openclaw-to-memory.js   ← ingests OpenClaw sessions/runs/blackboard  │
│  vault-blackboard-daemon.js   ← watches store and detects note changes     │
│  memory-bus.ps1 (spawned) ← runs SyncAll to refresh structured/ JSONL      │
└──────┬──────────────────────────────────────────────┬──────────────────────┘
       │ PowerShell spawns                             │ Node.js calls
       │ memory-watchdog.ps1 (daemon loop)             │
       ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    POWERSHELL ORCHESTRATION LAYER                           │
│                                                                              │
│  memory-watchdog.ps1                                                      │
│    ├── monitors: claude-mem, claude-code skills, codex, openclaw,          │
│    │             opencode, copilot, trae, traecn                           │
│    ├── triggers: bus sync → structured JSONL refresh                        │
│    ├── triggers: MEMORY-LAYERS / HANDOFF / AUTO-DREAM rebuild              │
│    └── triggers: embeddings refresh (cooldown 180s)                        │
│                                                                              │
│  memory-bus.ps1 (per-call)                                                │
│    ├── SyncAll: updates structured/*.jsonl from all native sources          │
│    └── RefreshDerivedArtifacts: rebuilds generated artifacts                │
└──────┬──────────────────────────────────────────────┬──────────────────────┘
       │ Python stdio                                 │ Python stdio
       ▼                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PYTHON RETRIEVAL LAYER                                 │
│                                                                              │
│  semantic-search.py                                                        │
│    ├── Stage 1: SQLite metadata filter (memory_type, archived, expires_at) │
│    ├── Stage 2: Parallel BM25 + dense search over candidate chunks         │
│    ├── Stage 3: Hybrid merge + MMR + temporal decay + reranking             │
│    ├── persistent query-embedding cache (30s TTL)                          │
│    ├── persistent result cache (30s TTL)                                    │
│    └── fallback: BM25-only if dense provider unavailable                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  LOCAL .AI-MEMORY STORE (CANONICAL DATA PLANE)               │
│                                                                              │
│  {AI_MEMORY_STORE}\  (default: E:\.ai-memory\)                            │
│    ├── inbox/                                                              │
│    │   └── {tool}.md                  ← per-agent inbox                      │
│    ├── structured/                                                         │
│    │   ├── shared-inbox.jsonl          ← cross-agent shared inbox          │
│    │   ├── session-memory.jsonl         ← session-layer events             │
│    │   ├── shared-events.jsonl          ← cross-agent events               │
│    │   ├── task-memory.jsonl             ← shared task state                │
│    │   ├── claude-code.jsonl             ← Claude Code cross-session records│
│    │   ├── openclaw.jsonl                ← OpenClaw cross-session records   │
│    │   ├── openclaw-blackboard.jsonl     ← OpenClaw task blackboard         │
│    │   ├── openclaw-runs.jsonl           ← OpenClaw run ledger              │
│    │   ├── openclaw-jobs.jsonl           ← OpenClaw cron job recall         │
│    │   └── openclaw-journal.jsonl        ← OpenClaw daily journal           │
│    ├── generated/                                                          │
│    │   ├── L0-bootstrap.md               ← L0 + L1 project-aware bootstrap │
│    │   ├── MEMORY-LAYERS.{md,json}  ← layered memory snapshot              │
│    │   ├── HANDOFF.{md,json}        ← bounded resume packet                │
│    │   ├── AUTO-DREAM.{md,json}     ← consolidated dream summary           │
│    │   └── GLOBAL-CONTEXT.md        ← onboarding overlay                   │
│    ├── kg/                                                              │
│    │   └── knowledge-graph.sqlite3  ← knowledge graph triples             │
│    └── embeddings/                                                       │
│        └── index.jsonl               ← BM25 + dense embeddings index       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Write Paths

There are five trigger paths for writing to shared memory, from most to least frequent:

### 1. Agent Tool Call → structured JSONL (most frequent)
```
Agent completes a tool call
  → shared MCP HTTP request
    → omni-memory-server.js (Node.js)
      → memory-bus.ps1 (PowerShell, spawned)
        → writes/updates structured/*.jsonl
```
**Latency**: Near-real-time, driven by watchdog polling (default 15s).

### 2. Watchdog Scan → Structured Refresh (background)
```
memory-watchdog.ps1 detects file-change signature drift
  → Invoke-BusSync
    → memory-bus.ps1 -Action SyncAll
      → scans claude-mem, claude-code, codex, openclaw, opencode, copilot, trae
      → updates structured/*.jsonl
  → Invoke-StructuredRefreshPipeline
    → refreshes MEMORY-LAYERS → HANDOFF → AUTO-DREAM
    → triggers embeddings rebuild if structured changed
```

### 3. Dream Consolidation → Durable Promotion (idle trigger, `-Writeback` mode)
```
Idle 15min + accumulation threshold
  → memory-watchdog.ps1 → Invoke-MemoryDream
    → run-memory-dream.ps1 (PowerShell)
      → reads structured/*.jsonl
      → builds typed promotion queue (session/event/task → durable)
      → [writes] durable typed records to structured/shared-inbox.jsonl
        with source_kind=writeback, memory_level=durable
      → [writes] MEMORY.md index entries
      → generates AUTO-DREAM.md + AUTO-DREAM.json (report)
      → build-handoff-pack.js (Node.js)
        → writes HANDOFF.json
```
**Notes**:
- `build-memory-layers.js` does NOT write durable memories — it only builds the `MEMORY-LAYERS.json` snapshot artifact.
- Durable writeback is gated by the `-Writeback` flag; without it, `run-memory-dream.ps1` only generates the report.
- Conflict detection uses SHA-256 `content_hash`比对: identical content is skipped (idempotent); differing content for the same promotion key is appended with `conflict_with`.

### 4. Blackboard Daemon → Note Watching (real-time)
```
obsidian-blackboard-daemon.js (Node.js, chokidar)
  detects vault note change
    → emits structured event
      → watchdog picks up next poll cycle
        → triggers bus sync + artifact refresh
```

### 5. Embeddings Rebuild → Index Update (cooldown: 180s)
```
memory-watchdog.ps1 detects structured/ newer than embeddings/index.jsonl
  → generate-embeddings.js (Node.js)
    → calls embedding provider (hashing-v1 / OpenAI-compatible / Ollama)
    → writes embeddings/index.jsonl
```

---

## Read Path — Three-Stage Retrieval Pipeline

```
Agent query
    │
    ▼
┌───────────────────────────────────────┐
│  Stage 1: Metadata Filter (zero cost)  │
│  SQLite: filter by memory_type,        │
│  archived=false, expires_at > now     │
│  Returns: candidate chunk IDs          │
└──────────────────┬────────────────────┘
                   │
       ┌────────────┴────────────┐
       ▼                         ▼
┌──────────────────┐  ┌──────────────────────────────────┐
│  BM25 / FTS5     │  │  Dense Vector Search             │
│  (always avail)  │  │  (requires embedding provider)   │
│  rank_bm25 + jieba│  │  hashing-v1 / Ollama / OpenAI  │
└────────┬─────────┘  └────────────────┬─────────────────┘
         │                             │
         └────────────┬────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│  Stage 3: Hybrid Merge + Rerank            │
│  score = 0.7×vec + 0.3×bm25 (configurable)│
│  MMR λ=0.7 (Maximal Marginal Relevance)  │
│  temporal decay: half-life 30d            │
│  route-aware reranking                    │
└──────────────────┬────────────────────────┘
                   │
                   ▼
         Hydrated results with
         path, snippet, score, type, citation
```

**Fallback chain**:
1. Full hybrid (BM25 + dense + MMR + decay) — needs embedding provider
2. BM25 only (FTS5) — works offline, zero API cost
3. Frontmatter keyword only — last resort (no longer the primary path)

---

## Cross-Language Call Chain Summary

| Operation | PowerShell | → Node.js | → Python |
|-----------|-----------|-----------|---------|
| Retrieval | — | `omni-memory-server.js` → spawns | `semantic-search.py` |
| Embeddings build | watchdog triggers | `generate-embeddings.js` | `embedding_providers.py` |
| Structured sync | `memory-bus.ps1` | JS helpers | — |
| Memory layers | watchdog triggers | `build-memory-layers.js` | — |
| Dream consolidation | `run-memory-dream.ps1` | `build-handoff-pack.js` | — |
| OpenClaw sync | watchdog triggers | `sync-openclaw-to-memory.js` | — |
| Blackboard watch | — | `vault-blackboard-daemon.js` | — |

**Contract rule**: PowerShell only orchestrates. Node.js handles business logic and IPC. Python owns retrieval. No layer calls "down" past the layer below it.

---

## Data Lifecycle

```
Session event
  ↓ (structured JSONL, Layer 1-2)
Session memory records
  ↓ (typed promotion, Layer 3)
Project/ durable memories
  ↓ (cross-project promotion, Layer 4)
Shared durable memories (user/feedback/project/reference)
  ↓ (generated artifact, signed by content-hash)
MEMORY-LAYERS.json / HANDOFF.json / AUTO-DREAM.json
  ↓ (embeddings)
embeddings/index.jsonl (BM25 + dense)
  ↓ (retrieval)
Agent query result
```

See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the full layer definition.
