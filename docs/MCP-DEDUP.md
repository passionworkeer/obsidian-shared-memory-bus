# MCP Dedup

## Problem
When every agent starts its own MCP servers, a multi-agent run can waste a lot of local CPU and memory.

Typical pain points:
- duplicated `memory` servers
- duplicated `obsidian` servers
- duplicated stateless MCP utilities like `fetch`, `time`, and `context7`
- duplicated `playwright` launches, which often create the biggest local process spike in multi-agent runs

## Strategy
This bundle centralizes safe-to-share MCP servers behind local HTTP endpoints.

Use MCP for transport and process deduplication. Use skills for reusable prompting and behavior. Use plugins only when a host app needs native lifecycle or UI integration. See `docs/INTEGRATION-MODES.md`.

Shared by default through `start-default-shared-mcp.ps1` or `start-default-shared-mcp.sh`:
- `context7`
- `fetch`
- `time`
- `sequential-thinking`
- `obsidian`
- `memory`
- `playwright`
- `MiniMax` when its environment variables are configured

Keep isolated:
- `pencil`

`playwright` remains `mode: optional` inside `shared-mcp/manifest.json`, but the default starter opts into it on purpose. That keeps advanced opt-out behavior available without going back to one Playwright MCP process per client.

## Why `memory` Is Shared
The shared `memory` MCP is the main fuzzy retrieval layer for:
- shared structured Obsidian memory
- hybrid `bm25 + dense` retrieval
- embeddings rebuilds
- claude-mem compatibility reads and inserts
- OpenClaw blackboard access

Current limitation:
- the shared `memory` service is still a broad omni-server, not a tiny retrieval-only daemon. That is good for process count, but it keeps a lot of concerns coupled in one MCP entrypoint today.

## Why `playwright` Is Shared Now
The managed Playwright backend runs once on `http://127.0.0.1:9337/mcp` and can still serve separate MCP sessions with isolated browser profiles. In practice, this removes the biggest source of duplicated Node.js processes without forcing agents to share browser state.

## Validate Dedup Worked
Start the default shared stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

Inspect status:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

Run a pressure test:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

Good signs:
- one listener per shared port
- stable PIDs across waves
- all shared services healthy
- client CLIs all point to the shared HTTP endpoints

One extra note: some client `mcp list` commands can still show Playwright as failed even while real browser tasks succeed. Treat a real browser task or direct MCP initialize call as the stronger signal.

For the broader design tradeoffs behind this shared layer, see [`docs/MEMORY-ARCHITECTURE-CRITIQUE.md`](MEMORY-ARCHITECTURE-CRITIQUE.md).
