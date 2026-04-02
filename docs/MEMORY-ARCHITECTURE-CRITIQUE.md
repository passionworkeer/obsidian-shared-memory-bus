# Memory Architecture Critique

This document is intentionally more skeptical than the rest of the docs. The goal is to keep the public bundle honest about what is strong today, what is merely workable, and where the next refactor should go.

## What Is Strong Already
- Obsidian is a clear canonical store instead of a hidden proprietary state layer.
- Shared MCP successfully removes the worst per-agent process duplication for `memory`, `obsidian`, and other safe-to-share services.
- The runtime no longer depends on native Node `sqlite3` for the shared memory core.
- The source tree and the flat installed runtime now have an explicit contract.
- Windows, macOS, and Linux all have a real install/start/stop path instead of Windows-only scripts plus wishful docs.
- The shared retrieval path now keeps a warm Python worker alive, so BM25 state, entry caches, and transformer model caches can survive across repeated searches.

## Main Weaknesses

### 1. `shared-mcp/omni-memory-server.js` Is Still A God Server
One MCP entrypoint currently owns too many responsibilities:
- shared retrieval
- embeddings rebuilds
- handoff generation
- dream generation
- claude-mem bridge calls
- OpenClaw blackboard access

That reduces process count, which is good, but it also means one large adapter carries too much integration risk. A failure or behavior change in one area is more likely to affect unrelated areas.

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

### 6. Extension Contracts Are Moving Toward Schema-First, But Not There Yet
The project now has a versioned memory-contract validator and integrity status surface, which is a real improvement over pure generator-first onboarding. Even so, the overall contract is still only partially schema-first.

Missing pieces:
- a versioned adapter schema for third-party agents
- a formal plugin contract beyond generated instructions and MCP snippets
- compatibility tests for arbitrary external agent integrations
- one shared contract implementation that Node, PowerShell, and Python all derive from instead of only Node-side validation

In other words, new-agent onboarding is practical, but not yet a hardened ecosystem API.

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
- Split `omni-memory-server.js` into narrower services or internal modules: retrieval, generation, and bridge adapters.
- Move duplicated embedding/runtime logic behind one versioned contract shared by Node.js and Python.
- Add a persistent retrieval cache or index layer so BM25 corpus construction is not repeated on every query.
- Add a long-lived embedding worker or query-time model cache for transformer mode.
- Formalize a versioned adapter schema for new agents, skills, and plugin bridges.
- Improve observability with structured metrics and staleness reporting, not only logs and last-run reports.

## Bottom Line
The current architecture is good at what it is actually trying to be:
- a local-first, multi-agent, shared-memory bus for one machine
- with explicit portability work for Windows, macOS, and Linux
- and with practical process deduplication for shared MCP services

It is not yet:
- a cleanly decomposed micro-architecture
- a high-scale retrieval service
- or a fully uniform three-platform product with identical operational maturity everywhere

That is a strong place to be for an open-source power-user bundle, as long as the docs keep those boundaries explicit.
