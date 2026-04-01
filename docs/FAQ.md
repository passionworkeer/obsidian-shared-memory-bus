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

## When Should I Use `bm25`, `dense`, Or `hybrid`?
- `bm25`: exact or keyword-heavy queries
- `dense`: semantic similarity
- `hybrid`: default recommendation because it balances both

## Why Might `mcp list` Show Playwright As Failed Even When Real Tasks Work?
Some clients do shallow or transport-specific checks that can produce false negatives. Real MCP `initialize` or real browser tasks are the stronger signal.

## Does This Require Remote Embeddings?
No. Offline `hashing-v1` is the default dense path.

## Can I Use This Across Multiple Devices?
You can, but do not confuse sync strategy with memory architecture. Keep one canonical vault and understand sync conflict behavior before layering more systems on top.

## Operational Troubleshooting

### My memory retrieval returns empty results. What do I do?
1. Check that your Obsidian vault path is set: `echo $env:AI_MEMORY_OBSIDIAN_VAULT`
2. Verify the watchdog is running: `powershell ...\status-shared-mcp.ps1`
3. Check that structured memory has data: look for `00-System/ai-memory/structured/*.jsonl`
4. Try a BM25-only search (bypass dense): use `mode: "bm25"` in search_shared_memory
5. Rebuild embeddings: call `rebuild_memory_embeddings` tool

### The watchdog stopped running. Is my memory still fresh?
No. Without the watchdog, structured memory stops updating. Agent sessions will still work, but cross-agent shared memory will become stale. To restart:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\memory-watchdog.ps1
```

### My embeddings fell back to "hashing-v1". What happened?
The system tried to use OpenAI-compatible embeddings but the API returned an error (401/403/429). It fell back to the local hash-based retrieval. Check your API key and endpoint configuration. You will see a `console.warn` in the generate-embeddings output.

### How long until a new Obsidian note appears in shared memory?
The watchdog polls on a schedule. Embeddings rebuild runs every 15 minutes by default. For immediate indexing, call `rebuild_memory_embeddings` tool manually.

### What happens if two agents write to the same note simultaneously?
The system uses last-write-wins at the note level. Chokidar events from obsidian-blackboard-daemon.js will fire for each save. Under high concurrency, some writes may be lost. This is a known limitation - there is no conflict detection yet.

### How do I customize the MCP ports (9331-9338)?
Currently ports are not configurable via env var. Edit `shared-mcp/manifest.json` directly to change port numbers in the URL fields. Note: changing ports requires updating all client MCP configs.

### My vault is on a different drive or path. How do I configure it?
Set the `AI_MEMORY_OBSIDIAN_VAULT` environment variable to your vault root path. The system also auto-detects from `obsidian.json` in the vault directory.

