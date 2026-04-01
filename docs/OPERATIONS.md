# Operations

This runbook covers normal day-to-day operation of the shared memory bus.

## Check Shared MCP Status
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\status-shared-mcp.ps1
```

## Start The Default Shared Stack
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
```

## Restart Everything
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

## Restart One Shared Service
Example: restart only Playwright.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-shared-mcp.ps1 -Only playwright -ForceRestart
```

## Regenerate Shared Derived Context
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\bus\memory-bus.ps1 -Action Generate
```

## Rebuild Memory Embeddings
Use this only when you intentionally want to refresh dense retrieval artifacts.

```powershell
node $env:USERPROFILE\.ai-memory\bus\generate-embeddings.js
```

## Run Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

## Run Pressure Tests
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

## Logs And Runtime State
Look here first:
- `shared-mcp/logs/`
- `shared-mcp/state.json`

These are operational files, not canonical memory.

## Backup Guidance
- back up the Obsidian vault separately from the runtime bundle
- treat the vault as canonical and the runtime as reproducible
- do not assume logs or caches are durable memory

## Common Recovery Pattern
1. inspect `status-shared-mcp.ps1`
2. restart the affected shared service
3. rerun validation
4. only rebuild embeddings if the problem is actually retrieval-index related
