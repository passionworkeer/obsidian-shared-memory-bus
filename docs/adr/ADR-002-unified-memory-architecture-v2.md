# ADR-002: Unified Memory Architecture v2

**Status**: Draft
**Date**: 2026-04-03
**Deciders**: Architect
**Supersedes**: ADR-001
**Reason for superseding**: ADR-001 had critical retrieval gaps (no BM25/FTS content index, typed promotion documented but not in schema, no chunk mechanism) confirmed by cross-system benchmarking against OpenClaw, Claude Code native, and claude-mem.

---

## Context

ADR-001 established the event sourcing + dream consolidation model for shared multi-agent memory. Three-system benchmarking revealed the following confirmed gaps:

| Gap | Evidence | Severity |
|-----|----------|----------|
| Phase 1 has no content-level index | OpenClaw has FTS5+BM25; claude-mem has rank-bm25+jieba; ADR-001 Phase 1 only searches `description` frontmatter field | P0 — users get severe recall misses |
| Typed promotion not in frontmatter schema | ADR-001 doc describes `promotion` metadata; actual schema has no such field; claude-mem has full typed promotion metadata with version tracking | P0 — contract exists only on paper |
| No chunk mechanism, sessions/ is whole-file append | OpenClaw has `start_line/end_line/hash` per chunk for incremental re-index; ADR-001 consolidation must read full session files | P1 — sessions/ growth = O(n) consolidation cost |
| No BM25 weight layer | ADR-001 four-step hybrid skips text relevance until vector step; OpenClaw weights vector×0.7 + text×0.3 | P1 — keyword queries fall back to weak frontmatter match |
| No MMR (Maximal Marginal Relevance) | OpenClaw has MMR with configurable lambda; ADR-001 returns all intersected IDs, high duplicate risk | P1 — result diversity not controlled |
| No temporal decay | OpenClaw has configurable half-life decay (default 30d); ADR-001 all memories equal weight | P1 — stale memories not demoted |
| No embedding cache | OpenClaw has `embedding_cache` table (provider/model/key/hash); ADR-001 re-embeds on every query | P1 — API cost waste |
| Consolidation Phase 3 has no lock | 4-phase consolidation writes user/feedback/project/ simultaneously; multi-agent concurrent consolidation has race condition | P1 — data corruption risk |
| Obsidian optional-UI vs Markdown portability tension | ADR-001 says "Obsidian optional" but "Markdown human-readable" — without Obsidian, value of Markdown is just human editing, not the full experience | P2 — value proposition unclear |
| Cross-language runtime complexity | claude-mem has Node.js → Python → PowerShell chain; ADR-001's MCP stdio+HTTP dual-mode adds Windows subprocess lifecycle risk | P2 — operational complexity |
| No session-compaction trigger | Claude Code native has `sessionMemoryCompact` on session end; ADR-001 has no such mechanism, relying only on idle consolidation | P2 — session-end memory leak |

---

## Decision

**Adopt a unified architecture that merges the best of three systems:**

```
OpenClaw 贡献:     SQLite chunk schema + FTS5+BM25 + sqlite-vec + MMR + temporal decay + embedding cache
Claude Code 贡献:  4-type typed memory + MEMORY.md 200-line index cap + extractMemories stopHook
claude-mem 贡献:  10-layer structured hierarchy + typed promotion with version contracts + Obsidian MCP bridge
ADR-001 贡献:     event sourcing (append-only sessions) + Tier 1/2/3 agent integration + consolidation lock + Prune phase
```

Core design principles preserved from ADR-001:
- Canonical store is filesystem (`.memory/`)
- Event sourcing: append-only sessions, consolidation is only write authority for durable memory
- Dreamer model: user's most-used agent executes consolidation
- Tier 1/2/3 agent integration protocol

Core design principles added:
- **BM25 Phase 1**: content-level full-text index, not just frontmatter
- **Chunk-native sessions**: sessions/ stores chunk manifests with hash + line tracking, not whole-file append
- **Embedding cache**: avoid re-embedding identical text
- **MMR + temporal decay**: result diversity + recency weighting
- **Typed promotion in frontmatter**: contract enforcement at schema level
- **Phase 3 lock**: multi-file write protection during consolidation

---

## Detailed Architecture

### Directory Structure

```
.memory/                              ← Root (git-syncable, agent-native Markdown)
├── MEMORY.md                         ← Index (max 200 lines, one entry per line)
├── README.md                         ← Agent integration guide (self-describing)
├── TEMPLATE.md                       ← Memory file template with frontmatter
│
├── user/                             ← Durable: user preferences and knowledge
│   └── *.md
├── feedback/                         ← Durable: workflow guidance and corrections
│   └── *.md
├── project/                         ← Durable: project state, goals, decisions
│   └── *.md
├── reference/                        ← Durable: external system pointers
│   └── *.md
│
├── sessions/                         ← Ephemeral: per-agent session logs (chunk-native)
│   ├── 2026-04-03/
│   │   ├── claude-code.md           ← Chunk manifest + content
│   │   │     # Session: 2026-04-03 10:30 (Claude Code)
│   │     # Chunks:
│   │     #   - id: c1, lines: 1-25, hash: sha256...
│   │     #   - id: c2, lines: 26-50, hash: sha256...
│   │     ## Events
│   │     - Created `src/api/users.ts`
│   │     ## Extracted Memories
│   │     - User prefers Chinese responses
│   │     ## User Feedback
│   │     - "stop summarizing at the end"
│   │   ├── codex.md
│   │   ├── openclaw.md
│   │   └── events.jsonl             ← Cross-agent events (append-only)
│   └── ...
│
├── archived/                         ← Archived: not deleted, user-controlled
│   ├── user/
│   ├── feedback/
│   ├── project/
│   └── reference/
│
├── .index/                           ← Embedding index (rebuilt on idle consolidation)
│   └── memory.db                     ← SQLite: chunks + chunks_fts + chunks_vec + embedding_cache + meta + files
│
├── .lock/                            ← Lock files
│   ├── consolidation.lock            ← PID + mtime (lastConsolidatedAt)
│   └── indexing.lock                  ← PID + mtime (active indexing run)
│
└── .config/                          ← Runtime configuration
    ├── embedding.json                 ← Embedding provider config (API keys, URLs)
    ├── agent-stats.json              ← Agent usage statistics
    ├── dreamer-preference.json       ← Preferred dreamer agent
    └── retention-policy.json          ← Archive + permanent delete policy
```

### Memory File Frontmatter Schema v2

```yaml
---
name: memory_name
description: One-line description for relevance matching
type: user|feedback|project|reference
created: 2026-04-03T10:00:00Z
modified: 2026-04-03T10:00:00Z
source: claude-code|codex|openclaw|session-extraction|consolidation
confidence: 0.8
archived: false

# --- Content integrity (new in v2) ---
content_hash: sha256:abc123...       # SHA-256 of content body for dedup

# --- Typed Promotion Contract (new in v2) ---
promotion:
  version: 1
  durable_type: user|feedback|project|reference
  key: memory_name
  reason: initial|updated|conflict_resolved
  source_type: session|event|blackboard|manual
  source_confidence: 0.8
  promoted_at: 2026-04-03T10:00:00Z

# --- Provenance (new in v2) ---
provenance:
  original_session: 2026-04-03-claude-code
  original_chunk_ids: [c1, c2]     # Session chunks that contributed
  consolidation_pass: 3             # Which consolidation run promoted this
  conflict_with: []                 # IDs of memories this superseded

# --- Lifecycle (new in v2) ---
lifecycle:
  expires_at: null|2027-04-03       # null = permanent, else TTL
  access_count: 42                  # Retrieved N times (for recency scoring)
  last_accessed: 2026-04-03T18:00:00Z
  promotion_count: 1                # How many times promoted

# --- Relationships ---
files: []                            # Related file paths (enables code→memory linkage)
projects: []                         # Related project paths
```

### Session Chunk Manifest Format

```markdown
# Session: 2026-04-03 10:30 (Claude Code)
# Chunk-Manifest-Version: 2
# Schema: SHA256, start_line, end_line, id
# Chunks:
# c1  sha256:a1b2c3  1   25
# c2  sha256:d4e5f6  26  50
# c3  sha256:g7h8i9  51  75

## Events
- Created `src/api/users.ts` — user CRUD endpoint
- Fixed auth middleware session token bug

## Extracted Memories
- User prefers Chinese responses
- Don't mock database in integration tests

## User Feedback
- "stop summarizing at the end of every response"

## Notes
- Architecture change: moving from REST to GraphQL
```

### Four-Layer Memory Hierarchy

Layer 1 — Ephemeral (event-level, not in durable store):
```
sessions/YYYY-MM-DD/<agent>.md   ← Chunk manifest + raw events
structured/session-memory.jsonl   ← Per-session structured records
structured/shared-events.jsonl    ← Cross-agent events
```

Layer 2 — Session Durable (cross-session, per-project):
```
structured/claude-code.jsonl      ← Claude Code cross-session records
structured/openclaw.jsonl         ← OpenClaw cross-session records
structured/openclaw-blackboard.jsonl ← OpenClaw tasks
structured/openclaw-runs.jsonl    ← OpenClaw runs
structured/task-memory.jsonl      ← Shared task memory
```

Layer 3 — Project Durable (project-specific, long-term):
```
project/*.md                      ← Project-scoped memories (MEMORY.md subdirectory)
project/MEMORY.md                 ← Project-level memory index
```

Layer 4 — Shared Durable (cross-project, system-wide):
```
user/*.md                         ← User preferences
feedback/*.md                     ← Workflow guidance
reference/*.md                   ← External system pointers
```

---

## SQLite Index Schema

```sql
-- File manifest (tracks indexed files)
CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL,          -- 'memory' | 'sessions' | 'structured'
  hash        TEXT NOT NULL,          -- SHA-256 of current content
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Chunk storage (core table, replaces ADR-001's whole-file approach)
CREATE TABLE chunks (
  id          TEXT PRIMARY KEY,       -- uuid or hash
  path        TEXT NOT NULL,
  source      TEXT NOT NULL,          -- 'memory' | 'sessions' | 'structured'
  start_line  INTEGER NOT NULL,       -- Chunk boundary (inclusive)
  end_line    INTEGER NOT NULL,       -- Chunk boundary (inclusive)
  content_hash TEXT NOT NULL,          -- SHA-256 of chunk text (dedup key)
  model       TEXT,                    -- Embedding model used (null = no embedding)
  text        TEXT NOT NULL,           -- Raw chunk text
  embedding   TEXT,                     -- JSON-serialized vector (null if FTS-only)
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (path) REFERENCES files(path)
);

-- FTS5 full-text index (Phase 1 content-level search)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id,
  path,
  source,
  start_line,
  end_line
);

-- Vector index via sqlite-vec
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[ dims ]
);

-- Embedding cache (prevents re-embedding identical text)
CREATE TABLE embedding_cache (
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash        TEXT NOT NULL,           -- SHA-256 of text
  embedding   TEXT NOT NULL,
  dims        INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- Memory metadata (denormalized for fast filtering)
CREATE TABLE memory_meta (
  chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id),
  memory_type TEXT NOT NULL,           -- 'user'|'feedback'|'project'|'reference'
  memory_name TEXT NOT NULL,
  description TEXT,
  confidence  REAL,
  archived    INTEGER DEFAULT 0,
  promoted_at INTEGER,
  expires_at  INTEGER,
  access_count INTEGER DEFAULT 0,
  last_accessed INTEGER,
  promotion_count INTEGER DEFAULT 0,
  project     TEXT,
  session_id  TEXT,
  consolidation_pass INTEGER
);

-- Consolidation lock state
CREATE TABLE consolidation_state (
  key         TEXT PRIMARY KEY,        -- 'consolidation' | 'indexing'
  pid         INTEGER,
  mtime       INTEGER NOT NULL,
  owner       TEXT                     -- agent name
);
```

---

## Write Path (v2)

### Trigger A: Event Auto-Recording (stopHook / MCP)
```
Tool call completes → agent writes event to sessions/YYYY-MM-DD/<agent>.md
  → Append-only, no lock required
  → Event recorded with timestamp, tool name, file affected
```

### Trigger B: Active Extraction (per-turn, stopHook)
```
Every N turns → forked agent extracts memories from recent conversation
  → Writes to sessions/YYYY-MM-DD/<agent>.md (Extracted Memories section)
  → Tool permissions: Read/Grep/Glob only outside memory/, Edit/Write only inside memory/
```

### Trigger C: Session End Compaction (NEW — Claude Code native feature)
```
Session ends → compaction triggered
  → Session memory (SESSION.md) flushed to sessions/YYYY-MM-DD/<agent>.md
  → Append-only, preserves all session context
  → Triggers incremental index update (chokidar debounce 1500ms)
```

### Trigger D: Idle Consolidation (Dreamer)
```
Idle 15min + accumulation threshold → Dreamer executes 4-phase consolidation
  → Phase 3 write is now protected by consolidation.lock
```

### Session Chunk Manifest — Incremental Indexing

Instead of ADR-001's whole-file append, sessions/ now uses chunk manifests:

```
1. Session file written (append-only)
     → chokidar detects change (debounce 1500ms)
     → Compute SHA-256 per NEW/CHANGED section
     → Compare against last known chunk hashes
     → Only re-index chunks with new/changed hash
     → Update files.hash + chunks table
     → Upsert FTS5 rows for changed chunks
     → Update vector entries for changed chunks (or skip if embedding_cache hits)
```

**Benefit**: A 10,000-line session file with 1 changed line only re-indexes 1 chunk — not the whole file.

---

## Read Path (v2)

### Three-Stage Retrieval Pipeline

```
User Query
    │
    ▼
Stage 1: SQLite Metadata Filter
  → Filter by memory_type, archived=false, expires_at > now
  → Returns candidate chunk IDs — zero embedding API cost

    ▼
Stage 2: Parallel Search (candidate pool)
  ┌─────────────────────────┐   ┌────────────────────────────────┐
  │ BM25 / FTS5             │   │ Vector Search (sqlite-vec)     │
  │ bm25(query, candidates) │   │ cosine_similarity(embed(query),│
  │ Returns: {id, bm25_score}│   │   embed(candidates))          │
  │                          │   │ Returns: {id, vec_score}      │
  └─────────────────────────┘   └────────────────────────────────┘
    │                                    │
    └────────────┬──────────────────────┘
                 │
                 ▼
Stage 3: Hybrid Merge + Rerank
  score = vectorWeight × vec_score + textWeight × bm25_score
    ├── MMR (Maximal Marginal Relevance)
    │     λ=0.7: 70% relevance + 30% diversity
    │     Jaccard similarity for dedup
    │
    ├── Temporal Decay (NEW)
    │     weight *= exp(-λ × days_since_access)
    │     half-life: configurable (default 30 days)
    │
    └── access_count boost (NEW)
          recently_accessed memories get slight relevance boost

    ▼
Stage 4: Hydrate + Return
  Load full chunk content for intersected IDs
  Return: { path, startLine, endLine, snippet, score, type, citation }
```

**Weighted formula** (default from OpenClaw):
```
score = 0.7 × cosine_similarity + 0.3 × bm25_score
```
Configurable via `.config/retrieval.json`:
```json
{
  "retrieval": {
    "vectorWeight": 0.7,
    "textWeight": 0.3,
    "candidateMultiplier": 4,
    "mmr": { "enabled": true, "lambda": 0.7 },
    "temporalDecay": { "enabled": true, "halfLifeDays": 30 },
    "maxResults": 6,
    "minScore": 0.35
  }
}
```

**Fallback chain**:
1. Full hybrid (BM25 + vector + MMR + decay) — requires embedding provider
2. BM25 only (FTS5) — works offline, zero API cost
3. Frontmatter keyword only (Phase 1 MVP) — last resort

---

## Embedding System (v2)

### Provider Auto-Detection (from OpenClaw)

```typescript
// Priority order: local → cloud, fallback chain
const providerPriority = [
  'ollama',      // Local, no API key needed
  'openai',      // Cloud, requires OPENAI_API_KEY
  'gemini',      // Cloud, requires GEMINI_API_KEY
  'voyage',      // Cloud, requires VOYAGE_API_KEY
  'qwen',        // Cloud, proxy endpoint
]

// Runtime config
interface EmbeddingProfile {
  provider: string
  model: string
  baseUrl?: string        // for Ollama / custom endpoints
  apiKeyEnv?: string      // env var name
  apiKey?: string         // direct (not recommended)
  dims: number
  batchSize: number
  requestDelayMs: number
}
```

### Embedding Cache (NEW — from OpenClaw)

```
On embed request:
  hash = SHA-256(text)
  key  = (provider, model, api_key, hash)
  →
  IF key exists in embedding_cache:
    RETURN cached embedding
  ELSE:
    CALL provider API
    INSERT INTO embedding_cache
    RETURN embedding
```

**API cost reduction**: Identical text across sessions/chunks is embedded once and cached indefinitely.

### Embedding Cache Config
```json
{
  "cache": {
    "enabled": true,
    "maxEntries": 100000,
    "ttlDays": 90
  }
}
```

---

## Typed Promotion Contract (v2 — now enforced in schema)

### Promotion Flow

```
Session memory (structured/*.jsonl)
    │
    ▼ Phase 2: Gather (consolidation)
Consolidation agent analyzes session records
    │ Extracts: user prefs, feedback corrections, project decisions
    │ Detects: conflicts, stale memories, duplicate facts
    │
    ▼ Phase 3: Promote
For each record to be promoted:
  1. Compute content_hash (SHA-256 of content body)
  2. Check if identical hash already exists in target durable/ layer
     → IF identical: SKIP (dedup)
     → IF similar: supersede old, write new with conflict_with: [old_id]
     → IF new: write new with full promotion metadata
  3. Write frontmatter with promotion contract (v2 schema)
  4. Acquire consolidation.lock before Phase 3
  5. Release lock after Phase 3
```

### Promotion Metadata (v2 frontmatter)

```yaml
promotion:
  version: 1
  durable_type: feedback        # NOT the session-layer source type
  key: no_mock_db_integration_tests  # Stable key for dedup
  reason: initial|updated|conflict_resolved|downgraded
  source_type: session|event|blackboard|manual|run|cron
  source_confidence: 0.6        # Confidence at source
  promoted_at: 2026-04-03T10:00:00Z

provenance:
  original_session: 2026-04-03-claude-code
  original_chunk_ids: [c1, c2]  # Which session chunks contributed
  consolidation_pass: 3         # Which consolidation run
  conflict_with: []             # IDs superseded (if conflict detected)
```

### Type Mapping (session → durable)

| Session Source Type | Durable Type | Promotion Trigger |
|--------------------|--------------|-------------------|
| `session` (user preference signal) | `user` | Explicit user instruction or 3+ confirmations |
| `event` (user correction) | `feedback` | Any user correction |
| `event` (project artifact created) | `project` | Task completion, decision made |
| `blackboard` (external system found) | `reference` | External resource discovery |
| `run` (automated task output) | `project` | Run completion summary |
| `cron` (scheduled observation) | `reference` | Scheduled system check |

---

## Four-Phase Consolidation (v2 — with Phase 3 lock)

### Phase 1: Orient
- Read MEMORY.md to understand current long-term memories
- Scan sessions/YYYY-MM-DD/ for chunk manifests with `processed: false`
- Read structured/ layer files for new records
- Build consolidation manifest

### Phase 2: Gather
- Collect signals worth promoting to long-term memory
- **Detect conflicts**: if memory with same `promotion.key` but different `content_hash` exists → flag for conflict resolution
- **Detect stale**: if recent code/CLAUDE.md contradicts existing memory → flag for archive
- **Deduplicate**: SHA-256 content_hash comparison

### Phase 3: Consolidate (LOCKED — v2 fix)
```typescript
// Acquire consolidation lock before multi-file writes
acquireLock('.lock/consolidation.lock')  // PID + mtime check, 60min expiry

try {
  // Write user/ entries (from user prefs signals)
  writeOrUpdate('user/', promotees.filter(s => s.durable_type === 'user'))

  // Write feedback/ entries (from corrections)
  writeOrUpdate('feedback/', promotees.filter(s => s.durable_type === 'feedback'))

  // Write project/ entries (from decisions + completions)
  writeOrUpdate('project/', promotees.filter(s => s.durable_type === 'project'))

  // Write reference/ entries (from external discoveries)
  writeOrUpdate('reference/', promotees.filter(s => s.durable_type === 'reference'))

  // Update MEMORY.md index
  updateMemoryIndex(added, removed, updated)
} finally {
  releaseLock('.lock/consolidation.lock')
}
```

### Phase 4: Prune (enhanced)
- Mark stale memories: `archived: true`, move to `archived/`
- Update `lifecycle.expires_at` based on memory type:
  - `user`: permanent (null)
  - `feedback`: 1 year
  - `project`: 6 months
  - `reference`: 1 year
- If `archived/` entry > 6 months: prompt user for permanent deletion
- **Update session chunk manifests**: mark processed chunks

---

## Retrieval Route Profiles (v2 — from claude-mem's 7-route system)

```typescript
type QueryRoute =
  | 'auto'       // Infer best route from query intent
  | 'mixed'      // BM25 + vector (full hybrid)
  | 'bm25'       // FTS5 only (offline mode)
  | 'dense'      // Vector only (semantic queries)
  | 'durable'    // Filter: memory_type in [user, feedback, project, reference]
  | 'task'       // Filter: memory_type = task
  | 'recent'     // Sort by last_accessed desc
  | 'reference'  // Filter: memory_type = reference only

// Route inference rules
if (query matches /linear|jira|bug tracker/i)      → route: 'reference'
if (query matches /project|goal|deadline/i)        → route: 'project'
if (query matches /user|prefer|always/i)           → route: 'durable'
if (query contains specific filename)               → route: 'bm25' (exact match)
if (embedding provider unavailable)                 → route: 'bm25'
if (query is conversational/question)              → route: 'dense'
```

---

## Tier Integration Protocol (unchanged from ADR-001)

```
Tier 1: Hook (Claude Code, OpenClaw)
  → stopHooks: active extraction every N turns
  → Writes: sessions/YYYY-MM-DD/<agent>.md (append-only)
  → Reads: MEMORY.md + typed memories on session start

Tier 2: MCP (Codex, Cursor, Copilot, Trae)
  → MCP Server exposes memory tools
  → search_memory({ query, route?, maxResults?, type? })
  → write_memory({ name, description, type, content })
  → trigger_consolidation({ force? })

Tier 3: Filesystem (any agent)
  → Read .memory/ files directly
  → Append to sessions/YYYY-MM-DD/<agent>.md
```

---

## MCP Protocol (v2 — updated tools)

```typescript
// Search with route profile
search_memory({
  query: string,
  maxResults?: number,      // default: 6
  minScore?: number,        // default: 0.35
  route?: QueryRoute,       // default: 'auto'
  memory_type?: string,     // filter by type
  archived?: boolean,       // default: false
  project?: string           // filter by project path
})
→ { results: [{ path, startLine, endLine, snippet, score, type, citation }] }

// Write with typed promotion
write_memory({
  name: string,
  description: string,
  type: 'user'|'feedback'|'project'|'reference',
  content: string,
  source_type?: string,      // session|event|blackboard|manual
  source_confidence?: number,
  files?: string[],
  projects?: string[]
})
→ { id: string, path: string, content_hash: string, promotion_version: 1 }

// Typed promotion (for consolidation agent)
promote_memory({
  session_chunk_ids: string[],
  durable_type: 'user'|'feedback'|'project'|'reference',
  source_type: string,
  reason: 'initial'|'updated'|'conflict_resolved',
  conflict_with?: string[]   // IDs to supersede
})
→ { promoted_id: string, content_hash: string, archived_ids: string[] }

// Memory status with hit stats
get_memory_status()
→ {
    sessionCount: number,
    memoryCount: number,
    chunkCount: number,
    lastConsolidated: string,
    dreamer: string,
    embeddingProvider: string,
    embeddingCacheHitRate: number,   // NEW
    avgQueryLatencyMs: number         // NEW
  }

// Retrieval config
get_retrieval_config() → RetrievalConfig
set_retrieval_config(config: Partial<RetrievalConfig>) → RetrievalConfig
```

---

## Configuration Schema (v2)

```json
{
  "retrieval": {
    "vectorWeight": 0.7,
    "textWeight": 0.3,
    "candidateMultiplier": 4,
    "maxResults": 6,
    "minScore": 0.35,
    "mmr": { "enabled": true, "lambda": 0.7 },
    "temporalDecay": { "enabled": true, "halfLifeDays": 30 }
  },
  "embedding": {
    "activeProfile": "auto",
    "providers": {
      "ollama": {
        "adapter": "ollama",
        "model": "nomic-embed-text",
        "baseUrl": "http://localhost:11434"
      },
      "openai": {
        "adapter": "openai-compatible",
        "model": "text-embedding-3-small",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    },
    "profiles": {
      "auto": {
        "provider": "ollama",
        "fallback": "openai"
      }
    },
    "cache": {
      "enabled": true,
      "maxEntries": 100000,
      "ttlDays": 90
    }
  },
  "chunking": {
    "tokens": 400,
    "overlap": 80,
    "byHeader": true
  },
  "consolidation": {
    "idleMinutes": 15,
    "minAccumulation": 1,
    "timeWindowStart": "22:00",
    "timeWindowEnd": "06:00",
    "lockExpiryMinutes": 60,
    "phases": {
      "orient": true,
      "gather": true,
      "consolidate": true,
      "prune": true
    }
  },
  "lifecycle": {
    "user": { "expiresAt": null },
    "feedback": { "expiresAt": "P1Y" },
    "project": { "expiresAt": "P6M" },
    "reference": { "expiresAt": "P1Y" },
    "archiveDeleteSuggestionDays": 180
  }
}
```

---

## Prune Policy (v2 — enhanced from ADR-001)

```typescript
const LIFECYCLE: Record<MemoryType, { expiresAt: string | null }> = {
  user:      { expiresAt: null },        // Permanent
  feedback: { expiresAt: 'P1Y' },       // 1 year
  project:   { expiresAt: 'P6M' },        // 6 months
  reference: { expiresAt: 'P1Y' },       // 1 year
}

// Archive workflow:
// 1. Memory exceeds expiresAt → auto-archive (archived: true, moved to archived/)
// 2. Archived > 180 days → prompt user: "Delete permanently?"
// 3. User confirms → permanent deletion
// 4. User declines → stays in archived/ indefinitely

// Conflict detection at archive time:
// If newer memory with same promotion.key supersedes older:
// older → archived with conflict_with: [newer_id]
```

---

## Consequences

### Positive

- **BM25 Phase 1 closes the biggest recall gap**: content body now indexed, not just frontmatter
- **Chunk manifests eliminate full-file re-read**: sessions/ consolidation is now O(changed_chunks), not O(session_size)
- **Embedding cache cuts API costs**: identical text embedded once, cached indefinitely
- **MMR + temporal decay**: result quality approaches OpenClaw's retrieval quality
- **Typed promotion in schema**: contract is now enforceable, not just documented
- **Phase 3 lock eliminates consolidation races**: multi-agent concurrent consolidation is safe

### Negative

- **Schema migration required**: existing `.memory/` files need frontmatter upgrade script
- **SQLite dependency**: requires `better-sqlite3` or equivalent Node.js binding (ADR-001 was pure Markdown)
- **Higher complexity**: hybrid search + cache + MMR + decay is more complex than ADR-001's Phase 1
- **Embedding provider still required for full quality**: BM25-only fallback works but is weaker

### Trade-offs

- **Portability vs. capability**: ADR-001's "pure filesystem" portability is reduced by SQLite dependency — but sqlite-vec is the standard for local vector search, and the `.memory/` Markdown files remain portable and git-versioned
- **Retrieval quality vs. complexity**: MMR + decay + cache add ~400 lines of retrieval logic, but they close the quality gap with OpenClaw

---

## Migration from ADR-001

```bash
# Migration script: migrate-adr-001-to-adr-002.sh
# 1. Add content_hash to all existing frontmatter (compute SHA-256 of content)
# 2. Add promotion metadata stub (version: 1, promoted_at: now)
# 3. Add lifecycle metadata (expires_at: null, access_count: 0)
# 4. Add provenance stub (consolidation_pass: 0)
# 5. Build initial SQLite index from .memory/ files
# 6. Convert sessions/ files to chunk manifest format
# 7. Back up before migration: .memory/ → .memory.bak
```

---

## Open Questions

1. **sqlite-vec extension loading on Windows**: OpenClaw uses `require('sqlite-vec')` which requires native bindings. Consider pure-JS BM25-only fallback for Windows environments without native module support.
2. **Chunk boundary for session files**: OpenClaw chunks at 400 tokens with 80 overlap. Should session chunking use the same parameters or session-turn boundaries (one chunk = one agent turn)?
3. **Embedding model compatibility**: Different embedding providers produce vectors of different dimensions. Does the vector cache key include dims? Should we normalize vectors to a fixed dimension?
4. **typed promotion conflict resolution**: When two consolidation passes produce conflicting memories for the same `promotion.key`, which wins? Latest `promoted_at`? Highest `source_confidence`? User confirmation?
