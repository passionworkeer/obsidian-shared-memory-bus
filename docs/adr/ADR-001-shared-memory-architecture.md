# ADR-001: Shared Memory Architecture

**Status**: Superseded by [ADR-002](ADR-002-unified-memory-architecture-v2.md)
**Date**: 2026-04-03
**Superseded**: 2026-04-03
**Reason**: Superseded by ADR-002 after cross-system benchmarking revealed critical gaps: no BM25/FTS content index, typed promotion not in schema, no chunk mechanism, no MMR/temporal decay, no embedding cache.

---

## Context

Multiple AI agents (Claude Code, Codex, Cursor, Copilot, Trae, OpenClaw, etc.) are used simultaneously on a single machine. Each agent maintains its own isolated memory system, leading to:

- Knowledge fragmentation across agents
- No shared context for cross-agent collaboration
- Redundant memory entries for the same facts
- No unified memory lifecycle management

The goal is to build a shared memory layer that is:
- Agent-agnostic (any agent can read/write)
- Portable (open source, no mandatory dependencies like Obsidian)
- Cross-platform (Windows, macOS, Linux)
- Self-describing (agent auto-detects integration method)

---

## Decision

Build a **Event Sourcing + Dream Consolidation** shared memory system with the following core principles:

1. **Canonical store is filesystem** — `.memory/` directory with Markdown + frontmatter files
2. **Writing is always append-only** — Each agent writes to its own `sessions/` subdirectory, never conflicts
3. **Consolidation is the only write authority for long-term memory** — Consolidation merges session logs into `user/`, `feedback/`, `project/`, `reference/` directories
4. **Embedding is idle-time only** — Embedding rebuilds happen during consolidation idle time, not on every write
5. **Embedding is external** — Agent fetches API key/URL from user at runtime via prompt, no hardcoded providers
6. **Dreamer is the user's most-used agent** — Consolidation is executed by the most frequently used agent, running in idle time

---

## Detailed Architecture

### Directory Structure

```
.memory/                          ← Root (git-syncable, agent-native Markdown)
├── MEMORY.md                     ← Index (max 200 lines, one entry per line)
├── README.md                     ← Agent integration guide (self-describing)
├── TEMPLATE.md                   ← Memory file template with frontmatter
│
├── user/                         ← User preferences and knowledge
│   └── *.md
├── feedback/                      ← Workflow guidance and corrections
│   └── *.md
├── project/                      ← Project state, goals, decisions
│   └── *.md
├── reference/                    ← External system pointers
│   └── *.md
│
├── sessions/                     ← Raw session logs (append-only, no conflicts)
│   ├── 2026-04-03/
│   │   ├── claude-code.md       ← Claude Code session log
│   │   ├── codex.md             ← Codex session log
│   │   ├── openclaw.md          ← OpenClaw session log
│   │   └── events.jsonl         ← Cross-agent events
│   ├── 2026-04-02/
│   │   └── ...
│   └── 2026-04-01/
│       └── ...
│
├── archived/                     ← Archived memories (not deleted, user-controlled)
│   ├── user/
│   ├── feedback/
│   ├── project/
│   └── reference/
│
├── .index/                       ← Embedding index (rebuilt on idle consolidation)
│   └── memory.db                 ← SQLite + sqlite-vec (optional)
│
├── .lock/                        ← Consolidation lock (PID file)
│   └── consolidation.lock
│
└── .config/                      ← Runtime configuration
    ├── embedding.json             ← Embedding provider config (API keys, URLs)
    ├── agent-stats.json          ← Agent usage statistics
    └── dreamer-preference.json   ← Preferred dreamer agent
```

### Memory File Format

Every memory file uses YAML frontmatter + Markdown content:

```yaml
---
name: memory_name
description: One-line description for relevance matching
type: user|feedback|project|reference
created: 2026-04-03T10:00:00Z
source: claude-code|codex|openclaw|session-extraction|consolidation
confidence: 0.8
archived: false
files: []   # Optional: related file paths (enables consolidation-time code→memory linkage)
---

Content here...

**Why:** [Optional: reason this matters]

**How to apply:** [Optional: when/where this applies]
```

### Hybrid Memory Format

Frontmatter is machine-parseable for Phase 1 keyword filtering; content remains human-writable Markdown. The optional `files` field enables consolidation to correlate "which code changed" with "which memories are relevant."

### Session Log Format

Session logs are Markdown with section headers:

```markdown
# Session: 2026-04-03 10:30

## Events
- Created `src/api/users.ts` — user CRUD endpoint
- Fixed auth middleware session token bug

## Extracted Memories
- User prefers Chinese responses
- Don't mock database in integration tests
- Pipeline bugs tracked in Linear project "INGEST"

## User Feedback
- "stop summarizing at the end of every response"

## Notes
- Architecture change: moving from REST to GraphQL
```

---

## Write Path (Always Conflict-Free)

### Event Sourcing Model

Every agent writes to its own session log. **No locking required for session writes.**

```
Agent writes (append-only):
  sessions/YYYY-MM-DD/<agent>.md

Session structure:
  sessions/YYYY-MM-DD/
  ├── claude-code.md      ← Claude Code writes here
  ├── codex.md            ← Codex writes here (different file)
  ├── openclaw.md         ← OpenClaw writes here (different file)
  └── events.jsonl        ← Cross-agent events only

Trigger A: Event Auto-Recording
  - Tool call results (created/modified important files)
  - Task state changes (pending → in_progress → done)
  - User explicit instructions ("remember X")

Trigger B: Active Extraction (every N turns)
  - Agent semantically judges "what's worth remembering"
  - Writes to sessions/<agent>/<timestamp>-extraction.md
  - Via stopHooks (Claude Code) or MCP tool (others)

Trigger C: Manual
  - User says "remember X"
```

---

## Read Path

### Three-Stage Loading

```
Stage 1: Session Start
  → Read MEMORY.md (index, max 200 lines)
  → Read user/ + feedback/ latest 3-5 entries (short, always loaded)
  → Read project/ + reference/ entries relevant to current project

Stage 2: On-Demand Query (during session)
  → Phase 1 (MVP): frontmatter keyword match on description
  → Phase 2 (with embedding): HybridSearch (metadata filter → semantic → intersect → hydrate)
  → Returns snippet + path + score
  → Agent decides when to query based on context

Stage 3: Project Context (automatic)
  → When working in a new project directory
  → Scan project/ for entries matching current project path
  → Also check `files` field in frontmatter for related memories
  → Inject relevant memories into context
```

### Frontmatter Description Matching

**Phase 1 (MVP, no embedding):** Pure frontmatter `description` + keyword matching.
Works out of the box, zero dependencies.

```typescript
// Simple relevance matching without embedding
function matchMemories(query: string, memories: MemoryFile[]): MemoryFile[] {
  const queryTokens = tokenize(query.toLowerCase())
  return memories
    .filter(m => !m.archived)
    .sort((a, b) => {
      const aDesc = (a.description || '').toLowerCase()
      const bDesc = (b.description || '').toLowerCase()
      const aScore = queryTokens.filter(t => aDesc.includes(t)).length
      const bScore = queryTokens.filter(t => bDesc.includes(t)).length
      return bScore - aScore  // Higher score = better match
    })
}
```

**Phase 2 (with embedding):** See "Hybrid Search (Four-Step Pattern)" above for the
full metadata-first → semantic → intersect → hydrate flow.

---

## Consolidation (Dreamer)

### Trigger Conditions (all must be true)

```
1. Idle Detection
   - User's preferred agent (dreamer) has no activity for 15 minutes
   - Configurable via .config/dreamer-preference.json

2. Accumulation
   - At least 1 new session log since last consolidation
   - OR MEMORY.md exceeds 150 lines (approaching 200 limit)

3. Timing (soft gate, not hard block)
   - Preferred window: 22:00–06:00 local time
   - Overridden by: MEMORY.md size threshold OR manual /consolidate trigger
   - User can force consolidation at any time via /consolidate command
```

### Four-Phase Consolidation

```
Phase 1: Orient
  - Read MEMORY.md to understand current long-term memories
  - Scan sessions/YYYY-MM-DD/ for unprocessed session logs
  - Mark processed logs with #processed tag

Phase 2: Gather
  - Collect signals worth promoting to long-term memory
  - Detect conflicts (same fact remembered differently)
  - Identify stale memories (contradicted by recent code)

Phase 3: Consolidate
  - Write/update user/ entries (from feedback + preferences)
  - Write/update feedback/ entries (from corrections + confirmations)
  - Write/update project/ entries (from task completions + decisions)
  - Write/update reference/ entries (from discovered external systems)

Phase 4: Prune
  - Move stale memories to archived/ (not delete)
  - Update MEMORY.md index (remove archived entries)
  - If memory > 6 months in archived/, suggest permanent deletion
```

### Dreamer Preference Detection

```typescript
// .config/agent-stats.json
{
  "agents": {
    "claude-code": { "sessionCount": 42, "lastUsed": "2026-04-03T..." },
    "codex":        { "sessionCount": 12, "lastUsed": "2026-04-02T..." }
  },
  "preferred": "claude-code",  // User override
  "lastConsolidated": "2026-04-02T01:00:00Z"
}

// Priority:
// 1. User manual setting (.config/dreamer-preference.json)
// 2. Highest sessionCount
// 3. Most recently used
```

### Consolidation Lock

```typescript
// .lock/consolidation.lock
// PID + mtime (mtime = lastConsolidatedAt)

// Acquisition:
// 1. Read existing lock (PID + mtime)
// 2. If mtime < 60min ago AND PID alive → skip (lock held)
// 3. Write PID, set mtime = now
// 4. Verify PID matches

// Crash recovery:
// If PID not alive OR mtime > 60min ago → lock is stale, can re-acquire
```

---

## Embedding

### Phase 1: MVP (No Embedding)

- Pure frontmatter `description` + keyword matching
- Works out of the box, zero dependencies
- README.md prompts user to configure embedding if needed

### Phase 2: Idle-Time Embedding

```
When:
  - Consolidation just completed
  - Dreamer idle for > 5 minutes
  - No active user sessions

How:
  - Recursively index all .md files in .memory/ (excluding sessions/ older than 7 days)
  - Generate embeddings via configured provider
  - Store in .index/memory.db (SQLite + sqlite-vec)
  - Provider auto-detected: Ollama (local) → OpenAI → Gemini → Voyage

Embedding provider config (.config/embedding.json):
  {
    "provider": "ollama|openai|gemini|voyage|auto",
    "model": "nomic-embed-text|gpt-4o-mini-embed|...",
    "baseUrl": "http://localhost:11434",  // for Ollama
    "apiKey": "sk-..."  // for cloud providers
  }
```

### Hybrid Search (Four-Step Pattern)

For Phase 2 retrieval, adopt a four-step hybrid pattern:

```
Step 1: SQLite metadata filter
  → Filter by type (user/feedback/project/reference), date range, archived=false
  → Returns candidate IDs — fast, zero API cost

Step 2: Semantic ranking (top N)
  → Vector search on candidate pool (or full corpus if pool is small)
  → Returns ranked results with similarity scores

Step 3: Intersection
  → IDs that appear in both Step 1 and Step 2
  → Preserves semantic rank order from Step 2

Step 4: Hydrate
  → Load full memory content for intersected IDs
  → Return { path, snippet, score, type }
```

This ordering (metadata-first → semantic) reduces embedding API calls significantly
compared to scoring the full corpus. The `files` frontmatter field enables
consolidation-time code-change → memory relevance linkage.

### External Provider Configuration

Agent prompts contain:

```
## Memory Embedding
To use semantic search, configure your embedding provider:

If using local Ollama:
  1. Install Ollama: https://ollama.ai
  2. Pull model: ollama pull nomic-embed-text
  3. Start: ollama serve

If using cloud API:
  1. Set OPENAI_API_KEY or GEMINI_API_KEY
  2. Or configure via: shared-memory config embedding

Current provider: $PROVIDER_NAME
```

---

## Integration Protocol (Auto-Detection)

### Agent Capability Detection

```typescript
type AgentCapabilities = {
  hasHooks: boolean       // Claude Code, OpenClaw
  hasMCP: boolean         // Codex, Cursor, Copilot, Trae
  hasFileSystem: boolean   // All agents
}

type IntegrationTier = {
  tier: 1 | 2 | 3
  method: 'hook' | 'mcp' | 'filesystem'
  requiresConfig: boolean
  setupInstructions: string
}
```

### Three Integration Tiers

```
Tier 1: Hook (Claude Code, OpenClaw)
  - stopHooks / PostToolUse triggers active extraction
  - Writes to sessions/YYYY-MM-DD/<agent>.md
  - No MCP required for writes
  - MCP for read acceleration (optional)

Tier 2: MCP (Codex, Cursor, Copilot, Trae)
  - MCP Server exposes write_memory() tool
  - MCP Server exposes memory_search() tool
  - Server runs as background daemon
  - Writes to sessions/YYYY-MM-DD/<agent>.md

Tier 3: Filesystem (Fallback)
  - Agent reads .memory/ directly via file operations
  - Agent writes to sessions/YYYY-MM-DD/<agent>.md
  - Works without any setup
```

### .memory/README.md (Self-Describing)

Every `.memory/` bundle includes a README that agents read to self-configure:

```markdown
# Shared Memory — Agent Integration Guide

This is your shared memory folder. Read this file to understand
how to access and contribute to the shared memory system.

## Quick Start

### You are Claude Code?
- stopHooks is configured. You auto-extract memories.
- Read `.memory/MEMORY.md` at session start.
- No extra setup needed.

### You are Codex / Cursor / Copilot / Trae?
- MCP server is running at http://localhost:9338
- Use `mcp__memory__write_memory()` to record
- Or: read `.memory/` files directly — they are plain Markdown

### You are any other agent?
- Read `.memory/` directly — it's plain Markdown
- To write: append to `sessions/YYYY-MM-DD/<your-name>.md`
- Follow the format in `.memory/TEMPLATE.md`

## Memory Types

- `user/` — User preferences and knowledge
- `feedback/` — Workflow guidance and corrections
- `project/` — Project state and decisions
- `reference/` — External system pointers

## Format

```yaml
---
name: memory_name
description: one-line description
type: user|feedback|project|reference
---

Content...
```

## What to Save

- User role, goals, expertise
- Feedback (what to avoid and what works)
- Project state, goals, decisions
- External system pointers

## What NOT to Save

- Code patterns (read from code instead)
- Git history (use git log)
- Debug solutions (they're in the code)
- In-progress work (session memory handles this)
```

---

## MCP Protocol

### Tools Exposed

```typescript
// Read
read_memory({ path: string, from?: number, lines?: number })
  → { text: string, path: string }

// Search (Phase 2: with embedding)
search_memory({ query: string, maxResults?: number, type?: string })
  → { results: [{ path, snippet, score, type }] }

// Write (Tier 2 agents)
write_memory({ name, description, type, content })
  → { id: string, path: string }

// Events
log_event({ event: string, agent: string, metadata?: object })
  → { id: string }

// Consolidation
trigger_consolidation({ force?: boolean })
  → { status: 'started' | 'locked' | 'skipped', message: string }

// Embedding
rebuild_embeddings({ force?: boolean })
  → { status: 'started' | 'completed', indexed: number }

// Lifecycle
archive_memory({ id: string })  → { archived: true }
forget_memory({ id: string })   → { deleted: true }  // User command only

// Status
get_memory_status()
  → { sessionCount, memoryCount, lastConsolidated, dreamer }

// Configuration
get_dreamer_preference()  → { preferred: string, agents: {...} }
set_dreamer_preference({ agent: string })  → { preferred: string }
```

### Transport

- **Primary**: stdio (for Claude Code MCP integration)
- **Secondary**: HTTP (port 9338, for multi-agent sharing)
- **Startup**: Singleton proxy (`singleton-stdio-mcp-proxy.mjs`) wraps stdio MCPs as HTTP listeners

### Startup Triple Protection

MCP Server startup uses three-layer protection (inspired by claude-mem's WorkerService):

```
Layer 1: Lock file (.lock/consolidation.lock)
  → PID + mtime (mtime = lastConsolidatedAt)
  → If mtime < 60min ago AND PID alive → skip (lock held)
  → Crash recovery: if PID not alive OR mtime > 60min ago → stale, can re-acquire

Layer 2: Port health check (port 9338)
  → Read /health endpoint
  → If responding → server already running, skip startup
  → If not responding → proceed to acquire Layer 1 lock

Layer 3: Startup lock (temporary, session-scoped)
  → Written at start of startup sequence
  → Deleted after server is confirmed listening
  → Prevents double-startup from concurrent launch attempts
```

---

## Multi-Agent Concurrency

### Timeline Example

```
T0: User opens Claude Code + Codex simultaneously
T1: Claude Code writes sessions/2026-04-03/claude-code.md (stopHooks)
T2: Codex     writes sessions/2026-04-03/codex.md (event recording)
T3: Claude Code writes sessions/2026-04-03/extraction-T3.md (active extraction)
T4: idle 15min, Dreamer (claude-code) starts consolidation
    → Read sessions/2026-04-03/claude-code.md
    → Read sessions/2026-04-03/codex.md
    → Consolidate into user/feedback/project/
    → Write .lock/consolidation.lock (protection)
T5: Codex continues writing sessions/2026-04-03/codex.md (no conflict)
T6: Dreamer completes, updates MEMORY.md
T7: idle 5min, embedding rebuild
    → .memory/ full .md embedding → .index/memory.db
```

**Key**: Consolidation lock prevents concurrent long-term writes. Session writes are always append-only, never blocked.

---

## Obsidian as Optional Layer

- **Not required**: `.memory/` is the canonical store, Obsidian is optional
- **User benefit**: Obsidian provides a nice UI for browsing memories
- **Sync**: User can open `.memory/` as an Obsidian vault for visual editing
- **Backwards compatibility**: Keep `00-System/ai-memory/` compatible with existing setup

---

## Installation & Distribution

```bash
git clone https://github.com/user/shared-memory
cd shared-memory
./setup.sh                    # Auto-detect OS + agent types
./setup.sh --agent claude-code  # Manual override
./setup.sh --skip-obsidian   # No Obsidian dependency
```

### Auto-Detection Logic

```bash
1. Detect OS (Windows/macOS/Linux)
2. Scan for installed agents:
   - ~/.claude/                    → Claude Code
   - ~/.codex/                     → Codex
   - ~/.cursor/                    → Cursor
   - ~/.openclaw/                  → OpenClaw
3. Apply integration configs:
   - Claude Code → hooks.json + CLAUDE.md injection
   - Codex/Cursor → MCP server config
   - Others → filesystem fallback
4. Initialize .memory/ directory
5. Start shared-memory-server (daemon mode)
```

---

## OpenClaw Integration

OpenClaw's blackboard and structured task memory are valuable signal sources:

```
Integration:
  - OpenClaw exports session logs to sessions/openclaw/YYYY-MM-DD.md
  - Format: standard session log format (see above)
  - QMD continues to work for OpenClaw's own memory needs
  - sessions/openclaw/ syncs to shared .memory/ for cross-agent use
```

---

## Forgetting (User-Controlled)

```bash
# List archived memories
shared-memory list archived

# Restore from archive
shared-memory restore <memory-id>

# Permanent delete (user confirms)
shared-memory forget <memory-id>

# Auto-suggest when archived/ > 6 months
# Prompt user: "These memories have been archived for 6+ months. Delete?"
```

**Principle**: Never auto-delete. User command only. Archive first, delete later.

---

## Consequences

### Positive

- **Zero conflicts**: Event sourcing ensures append-only writes never conflict
- **Agent-agnostic**: New agents join by writing to sessions/ directory
- **Portable**: No mandatory dependencies, pure filesystem + Markdown
- **Embedding-flexible**: External provider model, user controls API keys
- **Dreamer model**: Leverages user's preferred agent, no extra infrastructure
- **Self-describing**: README.md enables auto-integration for any agent

### Negative

- **Consolidation delay**: Session logs are not immediately in long-term memory
- **Embedding staleness**: Embeddings rebuilt only on idle consolidation
- **Session log growth**: sessions/ directory grows over time (need archival strategy)

### Trade-offs

- **Complexity vs. simplicity**: Event sourcing + consolidation is more complex than direct writes, but eliminates all concurrency conflicts
- **Embedding cost vs. quality**: Lazy embedding (idle-only) is cheaper but less real-time
- **Auto vs. manual**: Silent consolidation is convenient but requires trust in the dreamer

---

## Alternatives Considered

### Alternative 1: MCP as Single Write Authority

All agents write through MCP Server. Server handles locking.

- Rejected: Single point of failure; Server unavailable → no writes
- Event sourcing is more resilient

### Alternative 2: Agent-专属 Folders

`.memory/claude-code/`, `.memory/codex/`, etc.

- Rejected: Poor extensibility; new agents need folder restructuring
- Shared folders by type (user/feedback/project/reference) scale better

### Alternative 3: Real-time Embedding

Embed on every write.

- Rejected: Too expensive for frequent writes; user needs embedding API always available
- Idle-time embedding is sufficient for memory use case

### Alternative 4: Obsidian as Canonical Store

- Rejected: Not portable; open-source users may not use Obsidian
- Obsidian becomes optional UI layer, not canonical store
