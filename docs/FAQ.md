# FAQ

## Why Is Obsidian The Canonical Store?
Because it keeps durable memory in plain local files that multiple tools can read and write with low lock-in.

## Does Shared MCP Mean All Agents Share One Giant Context?
No. Shared MCP deduplicates processes. Each client still has its own session lifecycle and tool calls.

## Why Are Some MCPs Shared And Others Isolated?
Because safe process deduplication depends on the service type. Stateless utilities and canonical memory services are good shared candidates. UI-bound or strongly stateful tools are not.

## Why Can Playwright Be Shared But Pencil Cannot?
The shared Playwright backend still supports isolated sessions and browser profiles. `pencil` is tied to desktop app state and should stay isolated per client.

## What Is The Relationship Between `claude-mem` And Shared Memory?
`claude-mem` remains a native source. The shared memory bus bridges or syncs durable signals into the canonical Obsidian-backed layer instead of pretending native memory never exists.

## Should I Integrate Via MCP, Skills, Or Plugins?
- MCP:
  - best for shared runtime access, process deduplication, and tool transport
- skills:
  - best for portable onboarding, read order, writeback policy, and task decomposition habits
- plugins:
  - best only when a host app needs native lifecycle hooks or UI

The default recommendation is MCP plus skills. Add plugins only as a host-specific last mile.

## When Should I Use `bm25`, `dense`, Or `hybrid`?
- `bm25`: exact or keyword-heavy queries
- `dense`: semantic similarity
- `hybrid`: default recommendation because it balances both

## Why Might `mcp list` Show Playwright As Failed Even When Real Tasks Work?
Some clients do shallow or transport-specific checks that can produce false negatives. Real MCP `initialize` or real browser tasks are the stronger signal.

## Does This Require Remote Embeddings?
No. Offline `hashing-v1` is the default dense path.

## Are Embedding Providers Truly Hot-Swappable?
Not in the strict dense-index sense. You can switch the active profile or provider without editing code, but if the adapter, model, or base URL changes, rebuild the stored embeddings index so the query side and stored vectors match.

The new control surface makes that less opaque:
- `list_embedding_runtimes` shows what is configured
- `set_embedding_runtime` persists the active selection
- `memory_status.embeddingIndexState` tells you whether the index is aligned or needs a rebuild

## Can I Use This Across Multiple Devices?
You can, but do not confuse sync strategy with memory architecture. Keep one canonical vault and understand sync conflict behavior before layering more systems on top.

## Is This Really Cross-Platform?
Yes for the shipped runtime contract, with one caveat: Windows still has the deepest live acceptance coverage. The public bundle now includes `pwsh` plus `.sh` entrypoints for install/start/status/stop flows on macOS and Linux, while the core memory engine avoids native Node `sqlite3`, auto-detects Python across common Windows/macOS/Linux locations, and is smoke-validated in CI on all three platforms.

## Operational Troubleshooting

### My memory retrieval returns empty results. What do I do?
1. Check that `AI_MEMORY_OBSIDIAN_VAULT` or `OBSIDIAN_VAULT_ROOT` points at the right vault, or that Obsidian config detection can find it
2. Verify the shared stack is running:
   - Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1`
   - macOS/Linux: `~/.ai-memory/shared-mcp/status-shared-mcp.sh`
3. Check that structured memory has data: look for `00-System/ai-memory/structured/*.jsonl`
4. Try a BM25-only search (bypass dense): use `mode: "bm25"` in search_shared_memory
5. Rebuild embeddings: call `rebuild_memory_embeddings` tool

### The watchdog stopped running. Is my memory still fresh?
No. Without the watchdog, structured memory stops updating. Agent sessions will still work, but cross-agent shared memory will become stale. To restart:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\memory-watchdog.ps1
```

```bash
~/.ai-memory/memory-watchdog.sh
```

### My embeddings fell back to "hashing-v1". What happened?
The system tried to use OpenAI-compatible embeddings but the API returned an error (401/403/429). It fell back to the local hash-based retrieval. Check your API key and endpoint configuration. You will see a `console.warn` in the generate-embeddings output.

### How long until a new Obsidian note appears in shared memory?
The watchdog polls on a schedule. Embeddings rebuild runs every 15 minutes by default. For immediate indexing, call `rebuild_memory_embeddings` tool manually.

### What happens if two agents write to the same note simultaneously?
The system protects durable consolidation with a Phase 3 lock (`.lock/consolidation.lock`) that serializes multi-file writes during the consolidation pass — concurrent consolidation agents cannot corrupt each other's durable writes.

For cross-agent blackboard events, last-write-wins still applies: `ops/obsidian-blackboard-daemon.js` fires a Chokidar event per save, and under high concurrency some writes may be overwritten by later saves. This is a known limitation. Conflict-safe event log or lease semantics is tracked in the Roadmap.

### How do I customize the MCP ports (9331-9338)?
Set the `AI_MEMORY_BASE_PORT` environment variable to override the base port (default 9330). Individual server ports are calculated as basePort + offset (context7=1, fetch=2, time=3, sequential-thinking=4, obsidian=5, MiniMax=6, playwright=7, memory=8). Note: changing ports requires updating all client MCP configs.

### How do I configure the metrics server?
The metrics server (port 9090) supports two environment variables:
- `AI_MEMORY_METRICS_PORT`: Override the default port (9090)
- `AI_MEMORY_METRICS_TOKEN`: Set a bearer token for authentication. If set, requests to `/metrics` require `Authorization: Bearer <token>` header.

### My vault is on a different drive or path. How do I configure it?
Set the `AI_MEMORY_OBSIDIAN_VAULT` environment variable to your vault root path. The system also auto-detects from Obsidian's app config on Windows, macOS, and Linux.

### How do I stop all shared MCP services?
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1 -Stop
```
This gracefully shuts down all running shared MCP servers. On Windows it also kills any orphaned background launcher processes. After stopping, `status-shared-mcp.ps1` should report all services as stopped.

### Why do I see multiple Node.js processes?
The shared MCP stack runs each server as a separate Node.js process (one per MCP server on ports 9331-9338). Process deduplication ensures that if two clients request the same MCP server, they share the existing process rather than each launching their own -- this keeps servers alive across client sessions. Each entry in `status-shared-mcp.ps1` maps to one Node process. Seeing multiple Node processes is normal and expected.

### How does Windows console window hiding work?
The Windows launchers use a three-layer approach to keep windows hidden:
1. `Start-Process -WindowStyle Hidden` to suppress the visible window on launch.
2. A helper launcher script (`run-obsidian-mcp.ps1`, `run-minimax-mcp.ps1`, etc.) that relaunches the actual process via a second `Start-Process -WindowStyle Hidden` call, which covers cases where the first layer fails.
3. A background launcher wrapper that is itself launched via `Start-Process -WindowStyle Hidden` before it spawns the helper layer.

This cascading approach handles the case where PowerShell or Node.js themselves show a console window. The shared MCP background processes should be invisible to the user in normal operation.

### What is the memory contract?
The memory contract (`ops/memory-contract.js`) defines a versioned schema for all structured JSONL files in the canonical memory layers. It is checked automatically by `ops/check-memory-integrity.js` whenever you run validation or pressure tests. Each record must carry a recognized `schemaVersion` field; records with unknown versions are flagged rather than silently accepted. This prevents cross-version corruption when the schema evolves between releases.

### How do I disable the background watchdog (auto-sync)?
Set `AI_MEMORY_WATCHDOG_ENABLED=0` before starting the watchdog. When disabled, the watchdog exits immediately with exit code 0 and no background sync occurs. You can still trigger sync manually via `memory-bus.ps1 -Action SyncAll`. This is useful if you want to control sync timing explicitly or run sync only on-demand.

### How do I see all environment variables used by the system?
See `docs/ENVIRONMENT.md` for the complete reference.

