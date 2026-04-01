# Architecture

## Canonical Source Of Truth
Shared long-term memory lives in an Obsidian vault.

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
