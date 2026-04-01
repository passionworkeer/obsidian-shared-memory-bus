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
   - `semantic-search.py`
   - `generate-embeddings.js`
   - default offline dense backend: `hashing-v1`
   - optional OpenAI-compatible remote embeddings
4. Shared MCP access layer
   - `shared-mcp/omni-memory-server.js`
   - shared HTTP endpoints for `context7`, `fetch`, `time`, `sequential-thinking`, `obsidian`, `memory`, and the managed `playwright` backend
   - exposes `memory_status`, `search_shared_memory`, embeddings rebuild tools, claude-mem compatibility tools, and OpenClaw blackboard tools
5. Client integration layer
   - Codex, Claude, OpenCode, Cursor, Copilot, Trae, OpenClaw

## Transport Model
| Mode | Use it for | Why |
| --- | --- | --- |
| `stdio` | local development and adapter processes | good fit for tools launched by one client or wrapped into a shared proxy |
| Streamable HTTP | shared singleton MCP services | best fit for process deduplication and shared local endpoints |
| isolated local server | UI-bound or desktop-stateful tools | avoids cross-session state leakage and desktop contention |

The architecture uses local shared HTTP for safe-to-share services and leaves strongly stateful desktop tooling isolated.

## Runtime Roles

### `memory-bus.ps1`
Builds and refreshes shared derived artifacts for onboarding, global context, imported snapshots, and inbox notes.

### `memory-watchdog.ps1`
Runs in the background, watches key native sources, triggers syncs, and keeps the shared memory layer fresh.

### `run-obsidian-mcp.ps1`
Finds the active Obsidian vault and launches the Obsidian MCP server from the bundle-local or global `mcpvault` install.

### `run-minimax-mcp.ps1`
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

## Why The Architecture Works
- Obsidian stays canonical
- memory retrieval is shared over HTTP, not duplicated per agent
- stateless MCPs are centralized
- Playwright can be centralized because one HTTP backend can still serve isolated MCP sessions and isolated browser profiles
- only UI-bound desktop MCPs such as `pencil` stay isolated
- watchdog plus structured sync keeps the cross-tool memory layer current

## Deployment Shapes
See [`docs/DEPLOYMENT-MATRIX.md`](DEPLOYMENT-MATRIX.md) for recommended operating modes, sync guidance, and portability boundaries.
