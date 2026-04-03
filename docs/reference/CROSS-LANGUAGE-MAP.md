# Cross-Language Integration Map

This document maps which logic lives in which language, the boundaries between layers, and the cross-language calling conventions. It is the authoritative guide for answering "if I change X, where do I need to update Y?"

## Language Responsibility Matrix

| Layer | Language | Role | Never does |
|-------|----------|------|-----------|
| **Orchestration** | PowerShell | watchdog loop, startup registration, env detection, process lifecycle | Data processing, JSON parsing beyond env config |
| **Business Logic** | Node.js | MCP servers, embeddings generation, structured sync, artifact building | Pure data transformation without I/O |
| **Retrieval Core** | Python | semantic search, BM25, dense retrieval, embeddings | Process spawning, HTTP serving |
| **Canonical Store** | Obsidian + JSONL | durable memory, generated artifacts | — |

## File Ownership Map

### PowerShell (`*.ps1`)

| File | Responsibility | Calls |
|------|---------------|-------|
| `bus/memory-watchdog.ps1` | Background daemon: polls native sources, triggers sync, artifact refresh, embeddings rebuild | `memory-bus.ps1`, `run-memory-dream.ps1`, `generate-embeddings.js`, `sync-openclaw-to-obsidian.js` |
| `bus/memory-bus.ps1` | Syncs all native sources → structured JSONL; rebuilds generated artifacts | PowerShell helper modules only |
| `ops/run-memory-dream.ps1` | Drives 4-phase consolidation: layers → handoff → dream → typed promotion | `build-memory-layers.js`, `build-handoff-pack.js` |

**Rule**: PowerShell scripts never parse structured JSON beyond reading env vars or config files. All data transformation is delegated to Node.js.

### Node.js (`*.js`, `*.mjs`)

| File | Responsibility | Calls |
|------|---------------|-------|
| `shared-mcp/omni-memory-server.js` | Shared `memory` MCP server: HTTP transport, tool dispatch, retrieval worker management | Python (`semantic-search.py`) via child_process spawn |
| `bus/generate-embeddings.js` | Embeddings generation: reads structured JSONL, calls embedding provider, writes index | Python embedding helpers or direct HTTP |
| `ops/build-memory-layers.js` | Reads structured/*.jsonl, builds layered MEMORY-LAYERS snapshot, stamps promotion metadata | None (pure JS) |
| `ops/build-handoff-pack.js` | Builds bounded HANDOFF.json resume packet | None (pure JS) |
| `ops/sync-openclaw-to-obsidian.js` | Ingests OpenClaw sessions/runs/jobs/blackboard → structured JSONL | None (pure JS) |
| `ops/obsidian-blackboard-daemon.js` | Chokidar watcher: detects vault note changes in real-time | None (pure JS) |
| `retrieval/semantic-search.js` | Thin CLI wrapper for retrieval; also used by MCP server | `semantic-search.py` |
| `shared-mcp/singleton-stdio-mcp-proxy.mjs` | stdio MCP proxy for playwright backend | playwright MCP stdio |

**Rule**: Node.js owns all I/O that involves spawning processes or HTTP. It wraps Python results before returning to callers.

### Python (`*.py` in `retrieval/`)

| File | Responsibility | Called by |
|------|---------------|-----------|
| `retrieval/semantic-search.py` | Core retrieval: BM25 + dense + hybrid + MMR + temporal decay + caching | `omni-memory-server.js`, `semantic-search.js` CLI |
| `retrieval/embedding_providers.py` | Embedding provider abstraction: hashing-v1, OpenAI-compatible, Ollama | `generate-embeddings.js` |
| `retrieval/runtime_support.py` | Vault root resolution, env var helpers, Python runtime detection | `semantic-search.py`, `embedding_providers.py` |

**Rule**: Python never spawns subprocesses or makes outbound HTTP calls (except to configured embedding endpoints). It is a pure computation layer.

---

## Cross-Language Calling Conventions

### Node.js → Python

```
omni-memory-server.js:
  child_process.spawn("python", ["semantic-search.py", "--mode", mode, "--top-k", k, "--json", query])
    → parses stdout as JSON
    → timeout: 30s (hard kill on exceed)
```

**Contract**: Python output is always a single JSON object on stdout. Errors go to stderr with a non-zero exit code.

### PowerShell → Node.js

```
memory-watchdog.ps1:
  Start-NodeProcess -ScriptPath <path>
    → Start-SharedBackgroundProcess spawns node.exe
    → heartbeat via Write-State every WatchdogHeartbeatSeconds
```

```
generate-embeddings.js (called by watchdog):
  node generate-embeddings.js
    → writes embeddings/index.jsonl
    → exit 0 on success, non-zero on failure
```

### PowerShell → PowerShell

```
memory-watchdog.ps1 → memory-bus.ps1:
  Start-SharedPowerShellFile -ScriptPath $BusScript -ArgumentList @("-Action", "SyncAll", ...)
    → Wait-ProcessWithHeartbeat (max 300s)
```

```
memory-watchdog.ps1 → run-memory-dream.ps1:
  Start-SharedPowerShellFile -ScriptPath $MemoryDreamScript -ArgumentList @()
    → Wait-ProcessWithHeartbeat (max 45s)
```

---

## JSONL Schema Version Contract

When adding or changing structured JSONL record fields, you **must** update the schema version:

```
structured/.schema-version
```
This file stores the current schema semver. The `ops/memory-contract.js` validator reads this to enforce contract compatibility.

**Adding a new JSONL layer file**:
1. Add the filename to `structuredSignatureFiles` in `bus/memory-watchdog.ps1`
2. Add schema validation in `ops/memory-contract.js`
3. Update `structured/.schema-version`

**Do not** add ad-hoc fields to structured records without updating the contract. The whole retrieval pipeline depends on a stable record shape.

---

## Embedding Runtime Contract

The runtime config lives at:
- Installed: `~/.ai-memory/config/runtime.json`
- Source fallback: `templates/config/runtime.json`

```
runtime.json:
  defaults:     ← active profile + provider
  providers:    ← per-provider adapter/model/baseUrl config
  profiles:     ← named profile → provider mapping
  cache:        ← embedding cache settings
```

When adding a new embedding provider:
1. Add adapter to `bus/embedding-provider-registry.js`
2. Register provider in `runtime.json` template
3. Add smoke test in `retrieval/probe-models.py`
4. Document in `docs/INSTALL.md` (Optional Secrets section)

---

## Watchdog Source Watch Targets

The watchdog monitors 25+ source paths across 7 tool ecosystems:

| Tool | What is watched | Structured output |
|------|----------------|------------------|
| Claude Code | USER.md, MEMORY.md, TODAY.md, session-memory.md, claude-mem.db | `claude-code.jsonl` |
| Claude Code skills | `.claude/skills/*.md` | imported as session signal |
| Codex | history.jsonl, session_index.jsonl, sessions/*.jsonl | `claude-code.jsonl` |
| OpenClaw | sessions/*.jsonl, workspace/*.md, USER.md, MEMORY.md, jobs.json, runs.json, blackboard tasks.db | `openclaw*.jsonl` |
| OpenCode | opencode.db | `openclaw-opencode.jsonl` |
| Copilot | globalStorage/*, workspaceStorage/*, chat sessions | `copilot*.jsonl` |
| Trae | user_rules.md, History/entries.json, mcp.json | imported as session signal |

**Do not** add new source watchers without updating `WatchSpecs` in `bus/memory-watchdog.ps1` and documenting the new structured output here.

---

## Key Invariants

1. **PowerShell never parses structured JSON**. It only writes paths and triggers.
2. **Node.js never does retrieval math**. It delegates to Python.
3. **Python never spawns processes**. It is pure computation.
4. **Structured JSONL is append-only for events**. Overwrites are done by the consolidation pipeline, not by source watchers.
5. **Generated artifacts are content-hash signed**. Stale artifacts are detected by `sourceStructuredSignature` mismatch, not by timestamp alone.
