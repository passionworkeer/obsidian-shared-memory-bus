# Memory Architecture Critique

This document is intentionally more skeptical than the rest of the docs. The goal is to keep the public bundle honest about what is strong today, what is merely workable, and where the next refactor should go.

## What Is Strong Already
- Obsidian is a clear canonical store instead of a hidden proprietary state layer.
- Shared MCP successfully removes the worst per-agent process duplication for `memory`, `obsidian`, and other safe-to-share services.
- The runtime no longer depends on native Node `sqlite3` for the shared memory core.
- The source tree and the flat installed runtime now have an explicit contract, validated at install and release time.
- Windows, macOS, and Linux all have a real install/start/stop path instead of Windows-only scripts plus wishful docs.
- The shared retrieval path keeps a warm Python worker alive so BM25 state and caches survive across repeated searches.
- Typed durable promotion exists in the structured record contract through `metadata.promotion`; promotion key collisions are now detected and reported with `collidingWithId` metadata.
- Shared retrieval has explicit query routing and layered hybrid reranking; the eval harness has 30 judgment entries covering all five route types.
- Python-side schema validation (`retrieval/schema_validation.py`) is integrated into the retrieval worker, filtering contract-invalid records during search.
- `omni-memory-server.js` is now split into six focused modules (`memory-retrieval`, `memory-generation`, `memory-bridge`, `memory-status`, `memory-embeddings`, `memory-tools`) plus a slimmer main server (1094 lines, down from ~2400).

## Main Weaknesses

### 1. God Server — Now Split Into Modules
`omni-memory-server.js` has been refactored into six focused modules. All 18 tool definitions live in `memory-tools.js`. Process risk is reduced but the main server still routes all traffic — a crash in one module still affects the server process.

### 2. Runtime Logic Still Exists In Three Languages
PowerShell, Node.js, and Python each own meaningful pieces of the runtime:
- startup and installation in PowerShell
- shared MCP transport plus embeddings rebuild in Node.js
- retrieval and BM25/dense ranking in Python

Some logic is duplicated across those layers. The most obvious example is the hash embedding implementation duplicated in `bus/generate-embeddings.js` and `retrieval/semantic-search.py`. That is workable, but it creates drift risk.

### 3. Embedding Providers Are Cleaner, But Still Not True Hot Swap
The current architecture now resolves embeddings through `defaults + providers + profiles`, which is much cleaner than the older inline-profile config. Dense retrieval still depends on the stored embeddings index, though.

What this means in practice:
- changing `adapter`, `model`, or `baseUrl` can happen through config or env
- the query side can switch immediately
- the stored vectors do not magically change with it
- a rebuild is still required for a clean dense match

That is why the docs now describe this as decoupled provider/profile runtime config rather than "hot-swappable embeddings."

### 4. The Data Plane And Bridge Plane Are Still Too Tightly Coupled
Conceptually, the system has at least four planes:
- canonical data plane: Obsidian plus structured JSONL
- retrieval plane: BM25, dense, hybrid search
- bridge plane: claude-mem, OpenClaw, imported snapshots, generated overlays
- control plane: watchdog, installers, startup hooks, shared MCP

Those planes are clearer in the docs than they are in the code. Today the bridge and control behavior still meet in a few broad scripts, especially `bus/memory-bus.ps1` and `shared-mcp/omni-memory-server.js`.

### 5. Retrieval Still Optimizes For Simplicity Over Scale
The current search path is good for a serious single-machine workflow, but it is not yet a large-scale retrieval architecture.

Current limits:
- the shared `memory` MCP now keeps a persistent Python retrieval worker, but that worker still scans JSONL files directly instead of querying a dedicated retrieval store
- BM25/model caches now persist across searches only while the shared worker stays healthy
- transformer-based dense query embedding is cached per worker process, not as a separately managed model service
- cache invalidation is file-signature-driven and local, not event-stream-driven or centrally coordinated
- remote query embeddings add network latency and rate-limit sensitivity

This is acceptable for the repo's target shape today, but it is not the same as a persistent indexed retrieval service.

### 5.1 Obsidian Is Canonical At Rest, Not Yet A Single Write Plane
The docs are right that Obsidian is the durable source of truth, but the live architecture still has multiple write planes:
- human-written notes in the vault
- shared inbox/event generation
- direct claude-mem bridge writes
- OpenClaw blackboard task/journal writes

That means "canonical" currently means canonical storage and recall layer, not that every client writes through one unified transactional boundary.

### 5.2 Query Routing Is Inspectable, But Still Hand-Tuned
The new route-aware reranker is a real improvement over flat hybrid output, but it is still a rule-and-weight system rather than an evaluated ranking policy.

Current limits:
- route inference depends on regex and filter hints, so ambiguous prompts can still route poorly
- `layer`, `scope`, `sourceKind`, freshness, and task-state weights are hand-tuned rather than learned from judgments
- `candidateCount` still reflects the full scored union, not a route-pruned candidate pool
- there is no offline relevance benchmark yet for comparing route profiles or tuning weights safely

This is a good operator-friendly step, not the final ranking architecture.

### 5.3 Typed Promotion Is Better, But Still Not A Full Durable Policy Engine
Typed durable promotion closes an important gap, but it does not magically solve memory quality.

Current limits:
- promotion typing is still driven by heuristics and source text classification
- queue generation does not yet model conflicts between overlapping durable candidates
- refresh decisions are timestamp-based once keys overlap, not semantic diff aware
- there is no approval policy layer or learned promotion scoring yet

This means the system is now auditable and much less ad hoc, but not yet a trustworthy autopilot for long-term writeback.

### 5.3 Typed Promotion — Conflict Detection Now Exists
Promotion key collisions are now detected and surfaced in both Dream JSON output (`promotionKeyCollisions` array) and Dream markdown (`## Promotion Key Collisions` section). Colliding records carry `collidingWithId` so operators can manually review. However, the system does not yet auto-resolve — it still defaults to the higher-confidence candidate and skips the rest.

### 6. Extension Contracts — Python Schema Validation Now Integrated
Python-side `schema_validation.py` (mirroring `memory-contract.js` v2) is integrated into the retrieval worker and actively filters contract-invalid records during search. Node-side validation and Python-side validation are now in sync on schema version 2. The remaining gap is a formal cross-language schema as a single source of truth.

### 7. Observability Is Good For An Operator, Thin For A Platform
There are real logs, reports, state files, and pressure tests. That is a solid operator story.

Still missing:
- long-lived metrics
- latency histograms
- a structured error taxonomy across PowerShell, Node.js, and Python
- alerting or anomaly detection
- a stronger view of backlog growth, index staleness, or sync lag over time

This is fine for a local-first power-user tool. It is not yet platform-grade observability.

### 8. Cross-Platform Support Is Real, But Not Symmetric
The project now genuinely ships Windows, macOS, and Linux entrypoints. That is a big improvement.

But the maturity is still asymmetric:
- Windows has the deepest live acceptance coverage
- macOS and Linux have strong portable-core smoke coverage plus wrapper validation
- startup registration on macOS/Linux is implemented realistically, but field validation is still thinner than on Windows

That is why the docs should keep saying "portable-core supported" instead of implying identical maturity across all three OSes.

### 9. Shared MCP Is A Deliberate Boundary, Not A Universal One
The project correctly does not try to share every MCP process.

Important limits:
- `playwright` can be shared because the backend still supports isolated sessions
- `pencil` and other UI-bound desktop tools should remain isolated
- some client `mcp list` commands still give misleading health signals even when real tasks work

This means "shared MCP" is an optimization boundary, not a claim that every tool belongs in the shared pool.

## Best Next Refactors
- Make `omni-memory-server.js` split into actual separate processes rather than just modules within one process.
- Add a persistent retrieval cache or index layer so BM25 corpus construction is not repeated on every query.
- Add an evaluation harness for query routing and layered rerank weight tuning (eval data now exists, harness code is the gap).
- Add conflict-aware durable promotion scoring with manual resolution UI instead of silent skip.
- Formalize a versioned adapter schema for new agents, skills, and plugin bridges.
- Improve observability with structured metrics and staleness reporting, not only logs and last-run reports.

## Bottom Line
The current architecture is good at what it is actually trying to be:
- a local-first, multi-agent, shared-memory bus for one machine
- with explicit portability work for Windows, macOS, and Linux
- and with practical process deduplication for shared MCP services

It is not yet:
- a cleanly decomposed micro-architecture (now modular at module level, not yet at process level)
- a high-scale retrieval service
- or a fully uniform three-platform product with identical operational maturity everywhere

That is a strong place to be for an open-source power-user bundle, as long as the docs keep those boundaries explicit.
