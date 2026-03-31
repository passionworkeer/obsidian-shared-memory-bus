# MCP Dedup

## Problem
When every agent starts its own MCP servers, a multi-agent run can waste a lot of local CPU and memory.

Typical pain points:
- duplicated `memory` servers
- duplicated `obsidian` servers
- duplicated stateless MCP utilities like `fetch`, `time`, and `context7`

## Strategy
This bundle centralizes safe-to-share MCP servers behind local HTTP endpoints.

Shared by default:
- `context7`
- `fetch`
- `time`
- `sequential-thinking`
- `obsidian`
- `memory`
- `MiniMax` when its environment variables are configured

Keep isolated:
- `playwright`
- `pencil`

## Why `memory` Is Shared
The shared `memory` MCP is the main fuzzy retrieval layer for:
- shared structured Obsidian memory
- hybrid `bm25 + dense` retrieval
- embeddings rebuilds
- claude-mem compatibility reads and inserts
- OpenClaw blackboard access

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
