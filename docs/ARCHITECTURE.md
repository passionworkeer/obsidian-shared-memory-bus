# Architecture

## Canonical Source Of Truth
Shared long-term memory lives in an Obsidian vault.

Treat the vault as the canonical local data plane. Memory indexing, MCP transport, backup, and optional sync are separate layers built around that source of truth rather than replacements for it.

Core canonical notes:
- `02-KB/OBSIDIAN.md`
- `02-KB/MEMORY.md`
- `02-KB/WORKING.md`
- `00-System/ai-memory/generated/GLOBAL-CONTEXT.md`

## Main Layers
1. Native tool memory
   - claude-mem
   - OpenClaw sessions and blackboard
   - Codex/OpenCode/Copilot/other local activity
2. Shared structured memory
   - JSONL records under `00-System/ai-memory/structured/`
   - governed as one contract universe, including imported `claude-code.jsonl` and `openclaw.jsonl`
3. Retrieval layer
   - `retrieval/semantic-search.py`
   - `bus/generate-embeddings.js`
   - default offline dense backend: `hashing-v1`
   - optional OpenAI-compatible remote embeddings
   - provider/profile runtime registry through `~/.ai-memory/config/runtime.json`
   - source-tree direct runs can fall back to `templates/config/runtime.json` before install
4. Shared MCP access layer
   - `shared-mcp/omni-memory-server.js`
   - shared HTTP endpoints for `context7`, `fetch`, `time`, `sequential-thinking`, `obsidian`, `memory`, and the managed `playwright` backend
- exposes `memory_status`, `search_shared_memory`, embeddings rebuild tools, claude-mem compatibility tools, and OpenClaw blackboard tools
- exposes `memory_wake_up` for compact bootstrap context and optional verbatim snippet windows on `search_shared_memory`
- keeps a warm shared Python retrieval worker for `search_shared_memory`, with one-shot fallback if the worker is unavailable
- reports worker cache metrics through `memory_status` and supports explicit cache resets through `clear_shared_memory_search_cache`
- reports contract/integrity state through `memory_status.memoryIntegrity`
5. Client integration layer
   - Codex, Claude, OpenCode, Cursor, Copilot, Trae, OpenClaw

## Data, Bridge, And Control Planes
Thinking about the system in planes helps keep the portability and sharing story honest.

- Canonical data plane:
  - the Obsidian vault plus structured JSONL records under `00-System/ai-memory/`
- Retrieval plane:
  - BM25, dense, and hybrid search over the canonical data plane
- Bridge plane:
  - claude-mem sync, OpenClaw blackboard sync, imported native snapshots, generated onboarding overlays
- Control and transport plane:
  - watchdog, installers, startup registration, and shared MCP HTTP transport

Shared MCP only centralizes transport for safe-to-share services. It does not collapse all of these planes into one state store.

## Borrowed Strengths
This bundle intentionally combines the strongest ideas from two native memory styles instead of copying either one literally.

- Claude-style strengths folded in:
  - session memory for live task continuity
  - compaction and handoff style summaries
  - typed durable promotion from short-term notes into cleaner long-term memory buckets
  - dream-like consolidation into generated summaries
- OpenClaw-style strengths folded in:
  - blackboard task layer
  - run ledger and cron/job recall
  - explicit task-state memory instead of only freeform notes
  - subagent activity captured as structured recall targets

## Memory Outputs
- durable shared inbox:
  - `structured/shared-inbox.jsonl`
- session and event memory:
  - `structured/session-memory.jsonl`
  - `structured/shared-events.jsonl`
- imported session-layer memory:
  - `structured/claude-code.jsonl`
  - `structured/openclaw.jsonl`
- OpenClaw task memory:
  - `structured/openclaw-blackboard.jsonl`
  - `structured/openclaw-runs.jsonl`
  - `structured/openclaw-jobs.jsonl`
  - `structured/openclaw-journal.jsonl`
- generated handoff layers:
  - `generated/HANDOFF.md`
  - `generated/HANDOFF.json`
  - `generated/MEMORY-LAYERS.md`
  - `generated/MEMORY-LAYERS.json`
  - `generated/AUTO-DREAM.md`
  - `generated/AUTO-DREAM.json`

## Source Tree Vs Installed Runtime
- Source tree groups files by responsibility: `bus/`, `ops/`, `retrieval/`, `shared-mcp/`, `scripts/`, `templates/`
- Installed runtime under `~/.ai-memory` stays flat for backward compatibility with startup shortcuts, existing client configs, and old direct script paths
- The installer also generates root-level `.sh` wrappers for installed `.ps1` entrypoints plus activation helpers for macOS/Linux shells
- `scripts/install-layout.psd1` is the canonical source-to-install mapping; update it when adding or renaming runtime files
- `scripts/validate-layout.ps1`, `scripts/validate-layout.sh`, `.github/workflows/windows-validate.yml`, and `.github/workflows/portable-core.yml` are the guardrails that keep the grouped source tree and flat runtime contract from drifting
- The installer writes `~/.ai-memory/install-manifest.json` so upgrades can remove stale managed runtime files from older layouts

## Transport Model
| Mode | Use it for | Why |
| --- | --- | --- |
| `stdio` | local development and adapter processes | good fit for tools launched by one client or wrapped into a shared proxy |
| Streamable HTTP | shared singleton MCP services | best fit for process deduplication and shared local endpoints |
| isolated local server | UI-bound or desktop-stateful tools | avoids cross-session state leakage and desktop contention |

The architecture uses local shared HTTP for safe-to-share services and leaves strongly stateful desktop tooling isolated.

## Runtime Roles

### `bus/memory-bus.ps1`
Builds and refreshes shared derived artifacts for onboarding, global context, imported snapshots, and inbox notes.

### `bus/memory-watchdog.ps1`
Runs in the background, watches key native sources, triggers syncs, and keeps the shared memory layer fresh. Heavy follow-up work such as `MEMORY-LAYERS`, `HANDOFF`, `AUTO-DREAM`, and embeddings refresh is now gated by real structured-memory signature drift instead of every watched source change.

### `ops/build-memory-layers.js`
Builds layered memory views from durable writeback, session memory, shared events, and OpenClaw task/run data.
It is the first step in the generated-artifact chain and establishes the structured snapshot that later artifacts must sign against.

### `ops/build-handoff-pack.js`
Builds a bounded resume packet so the next agent can recover faster without rereading the entire history.
It should be rebuilt after `build-memory-layers.js`, not in parallel with it.

### `ops/run-memory-dream.ps1`
Runs a consolidation pass over durable, session, and task layers to produce a cleaner handoff-oriented `AUTO-DREAM` summary.
It now also builds a typed durable promotion and refresh queue, so downstream writeback can see `sourceLayer`, `sourceScope`, `targetScope`, `sourceKind`, `sourceRecordId`, and the recorded promotion reason instead of relying on untyped "newer than baseline" guesses.
It should run after both `MEMORY-LAYERS` and `HANDOFF` so all generated outputs share the same `sourceStructuredSignature`.

### `ops/run-obsidian-mcp.ps1`
Finds the active Obsidian vault and launches the Obsidian MCP server from the bundle-local or global `mcpvault` install.

### `ops/run-minimax-mcp.ps1`
Starts the optional MiniMax MCP using environment-provided secrets and either an auto-detected executable or `MINIMAX_MCP_COMMAND`.

### `shared-mcp/start-default-shared-mcp.ps1`
Starts the default shared MCP set: `context7`, `fetch`, `time`, `sequential-thinking`, `obsidian`, `memory`, `playwright`, and `MiniMax` when its environment is configured.

### `shared-mcp/start-shared-mcp.ps1`
Starts or adopts shared singleton MCP listeners from `shared-mcp/manifest.json`.

### `shared-mcp/manifest.json`
Describes which servers are shared, isolated, or optional. `playwright` stays marked as `optional` in the manifest so advanced users can opt out or run their own backend, but the default starter deliberately opts into it because it is usually the biggest per-agent process multiplier.

### `shared-mcp/omni-memory-server.js`
The shared `memory` MCP server. It is intentionally the main shared operator endpoint today, but it is still a monolithic adapter: retrieval, embeddings rebuilds, handoff generation, dream runs, claude-mem bridge calls, and OpenClaw blackboard access still meet here.
`search_shared_memory` now accepts an explicit `route` profile (`auto / mixed / durable / task / recent / reference`) and returns route metadata plus per-result ranking factors so operators can see why a result surfaced.

## Sharing Boundaries
- Shared:
  `memory`, `obsidian`, `context7`, `fetch`, `time`, `sequential-thinking`, optional `MiniMax`
- Shared process, but session-isolated:
  `playwright`
- Must remain isolated:
  UI-bound desktop tools such as `pencil`

This is process deduplication with per-client session isolation, not one merged agent context.

## Retrieval Modes
- `bm25`
- `dense`
- `hybrid`

The default recommendation is `hybrid`.
Embedding provider selection is now decoupled into `defaults + providers + profiles`, but dense retrieval is still not truly hot-swapped. After changing adapter, model, or base URL, rebuild the stored embeddings index so query and stored vectors share the same fingerprint.
The shared retrieval path now avoids per-request Python cold starts by keeping a long-lived worker behind the `memory` MCP. Cache invalidation is file-signature-driven, so structured JSONL or embeddings changes trigger a refresh without requiring manual restarts. The worker now also keeps query-embedding and bounded result caches in memory, which improves repeated-query latency without pretending the cache is durable truth.

## Typed Durable Promotion
Typed durable promotion now exists in the structured record contract instead of only inside the generated dream summary.

- `ops/build-memory-layers.js` stamps `metadata.promotion` onto governed records
- the current typed durable buckets are `user`, `feedback`, `project`, and `reference`
- `metadata.promotion` currently carries `version`, `durable_type`, `key`, `reason`, `source_type`, `source_confidence`, and `source_record_id`
- promotion keys are token-fingerprint based rather than full-text exact hashes, so refresh matching tolerates light wording drift better than exact-text identity
- summary-like and task-journal/task-run style records are explicitly blocked with reasons such as `non-promotable-type:summary`, and low-confidence candidates are held back with `low-confidence:*`
- `ops/run-memory-dream.ps1` consumes that metadata first and only falls back to heuristic scope inference for older records that do not yet carry promotion metadata
- typed promotion and refresh queue items now surface `sourceType`, `sourceConfidence`, `sourceRecordId`, `promotionKey`, and `promotionReason` for downstream auditability

This is intentionally auditable rather than magical. The system prefers explicit typed promotion metadata over hidden writeback behavior.

## Query Routing And Layered Hybrid Ranking
`retrieval/semantic-search.py` now performs route-aware layered reranking instead of only returning the raw `bm25` or dense order.

- the route can be explicitly set to `durable`, `task`, `recent`, `reference`, or `mixed`
- `auto` infers the route from query text plus explicit filters such as `scope`, `sourceKind`, and `taskState`, with task filters winning over generic durable scope hints and `scope=reference` mapping directly to the reference route
- ranking combines retrieval score with route-specific weights for `layer`, `scope`, `sourceKind`, `freshness`, task state, and hybrid coverage
- search responses now expose `queryIntent`, `queryRoute`, `candidateCount`, `layerCounts`, and per-result `layer`, `freshness`, and `rankMeta`
- single-mode `bm25` and `dense` queries keep their retrieval semantics; hybrid-only coverage bonus is applied only when both retrievers contribute to the same candidate

The current weights are still hand-tuned. They improve operator control and inspectability, but they are not a learned or benchmark-calibrated ranker yet.

`search_shared_memory` can also attach query-aware verbatim snippet windows when `includeVerbatim=true`, which keeps the canonical store unchanged while exposing the exact matched text needed for decision recall and auditability.

## Portability Boundary
- Windows:
  - deepest live acceptance coverage today
  - installer, startup hooks, watchdog, and client wiring are exercised here end to end
- macOS/Linux:
  - portable install, upgrade, validate, and shared-MCP control wrappers ship through `pwsh` + `.sh`
  - the installed `.sh` wrappers are POSIX `sh`, not Bash-only
  - installed runtime commands also get generated `.sh` wrappers and activation scripts
  - Python discovery now works across Windows, macOS, and Linux candidates through the shared runtime helper
  - core memory generation, dream consolidation, embeddings, retrieval, and wrapper parsing are smoke-validated in CI
  - startup registration is emitted as LaunchAgents on macOS and as `systemd --user` units or XDG autostart entries on Linux, but still has less live field validation than the Windows path

## Why The Architecture Works
- Obsidian stays canonical
- memory retrieval is shared over HTTP, not duplicated per agent
- stateless MCPs are centralized
- Playwright can be centralized because one HTTP backend can still serve isolated MCP sessions and isolated browser profiles
- only UI-bound desktop MCPs such as `pencil` stay isolated
- watchdog plus structured sync keeps the cross-tool memory layer current
- generated artifacts are now aligned by explicit content-hash signatures, so stale summaries can be detected even when timestamps look fresh

## Known Design Debt
- `shared-mcp/omni-memory-server.js` is still a broad "god server" rather than a narrow retrieval-only service
- runtime behavior is spread across PowerShell, Node.js, and Python helpers, so duplicated logic must stay aligned
- the memory contract is now versioned and validated in Node, but it is still not a fully shared cross-language schema contract
- retrieval is now warmer and less restart-heavy, but it still favors local simplicity over large-scale indexing sophistication
- typed durable promotion now exists, but promotion and refresh decisions are still heuristic and not yet benchmark-calibrated or user-tunable
- query routing and layered reranking now exist, but the weight tables are still hand-tuned and need better evaluation data before they should be treated as settled policy

See [`docs/MEMORY-ARCHITECTURE-CRITIQUE.md`](MEMORY-ARCHITECTURE-CRITIQUE.md) for the fuller critique and next refactor targets.

## Deployment Shapes
See [`docs/DEPLOYMENT-MATRIX.md`](DEPLOYMENT-MATRIX.md) for recommended operating modes, sync guidance, and portability boundaries.
