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

Shared by default through `start-default-shared-mcp.ps1`:
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

## Why `playwright` Is Shared Now
The managed Playwright backend runs once on `http://127.0.0.1:9337/mcp` and can still serve separate MCP sessions with isolated browser profiles. In practice, this removes the biggest source of duplicated Node.js processes without forcing agents to share browser state.

## Validate Dedup Worked
Start the default shared stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
```

Inspect status:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\status-shared-mcp.ps1
```

Run a pressure test:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-shared-stack-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

Good signs:
- one listener per shared port
- stable PIDs across waves
- all shared services healthy
- client CLIs all point to the shared HTTP endpoints

One extra note: some client `mcp list` commands can still show Playwright as failed even while real browser tasks succeed. Treat a real browser task or direct MCP initialize call as the stronger signal.
