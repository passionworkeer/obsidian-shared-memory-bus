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
3. Retrieval layer
   - `retrieval/semantic-search.py`
   - `bus/generate-embeddings.js`
   - default offline dense backend: `hashing-v1`
   - optional OpenAI-compatible remote embeddings
4. Shared MCP access layer
   - `shared-mcp/omni-memory-server.js`
   - shared HTTP endpoints for `context7`, `fetch`, `time`, `sequential-thinking`, `obsidian`, `memory`, and the managed `playwright` backend
   - exposes `memory_status`, `search_shared_memory`, embeddings rebuild tools, claude-mem compatibility tools, and OpenClaw blackboard tools
5. Client integration layer
   - Codex, Claude, OpenCode, Cursor, Copilot, Trae, OpenClaw

## Borrowed Strengths
This bundle intentionally combines the strongest ideas from two native memory styles instead of copying either one literally.

- Claude-style strengths folded in:
  - session memory for live task continuity
  - compaction and handoff style summaries
  - durable promotion from short-term notes into cleaner long-term memory
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
- Installed runtime under `%USERPROFILE%\.ai-memory` stays flat for backward compatibility with startup shortcuts, existing client configs, and old direct script paths
- `scripts/install-layout.psd1` is the canonical source-to-install mapping; update it when adding or renaming runtime files
- `scripts/validate-layout.ps1` and `.github/workflows/windows-validate.yml` are the guardrails that keep the grouped source tree and flat runtime contract from drifting
- The installer writes `%USERPROFILE%\.ai-memory\install-manifest.json` so upgrades can remove stale managed runtime files from older layouts

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
Runs in the background, watches key native sources, triggers syncs, rebuilds layered summaries, and keeps the shared memory layer fresh.

### `ops/build-memory-layers.js`
Builds layered memory views from durable writeback, session memory, shared events, and OpenClaw task/run data.

### `ops/build-handoff-pack.js`
Builds a bounded resume packet so the next agent can recover faster without rereading the entire history.

### `ops/run-memory-dream.ps1`
Runs a consolidation pass over durable, session, and task layers to produce a cleaner handoff-oriented `AUTO-DREAM` summary.

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
The shared `memory` MCP server.

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

## Portability Boundary
- Windows:
  - full installer, startup shortcuts, watchdog, and shared MCP control plane are validated here first
- macOS/Linux:
  - the core memory engine is intentionally being kept more portable
  - Python discovery now works across Windows, macOS, and Linux candidates
  - core memory generation, dream consolidation, embeddings, and retrieval are smoke-validated in CI
  - full one-command install and desktop startup registration are still Windows-first

## Why The Architecture Works
- Obsidian stays canonical
- memory retrieval is shared over HTTP, not duplicated per agent
- stateless MCPs are centralized
- Playwright can be centralized because one HTTP backend can still serve isolated MCP sessions and isolated browser profiles
- only UI-bound desktop MCPs such as `pencil` stay isolated
- watchdog plus structured sync keeps the cross-tool memory layer current

## Deployment Shapes
See [`docs/DEPLOYMENT-MATRIX.md`](DEPLOYMENT-MATRIX.md) for recommended operating modes, sync guidance, and portability boundaries.
