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
