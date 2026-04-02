# Operations

This runbook covers normal day-to-day operation of the shared memory bus.

## Check Shared MCP Status
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## Start The Default Shared Stack
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

## Restart Everything
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

## Restart One Shared Service
Example: restart only Playwright.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-shared-mcp.ps1 -Only playwright -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-shared-mcp.sh -Only playwright -ForceRestart
```

## Regenerate Shared Derived Context
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\memory-bus.ps1 -Action Generate
```

```bash
~/.ai-memory/memory-bus.sh -Action Generate
```

## Rebuild Layered Memory Summaries
```powershell
node $env:AI_MEMORY_ROOT\build-handoff-pack.js
node $env:AI_MEMORY_ROOT\build-memory-layers.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-memory-dream.ps1 -Force
```

```bash
node ~/.ai-memory/build-handoff-pack.js
node ~/.ai-memory/build-memory-layers.js
~/.ai-memory/run-memory-dream.sh -Force
```

## Rebuild Memory Embeddings
Use this only when you intentionally want to refresh dense retrieval artifacts.

```powershell
node $env:AI_MEMORY_ROOT\generate-embeddings.js
```

```bash
node ~/.ai-memory/generate-embeddings.js
```

## Run Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <your-project-root> -RunCliChecks
```

## Run Pressure Tests
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
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
- treat `MEMORY-LAYERS` and `AUTO-DREAM` as generated outputs, not hand-edited source of truth

## Common Recovery Pattern
1. inspect `status-shared-mcp.ps1` or `status-shared-mcp.sh`
2. restart the affected shared service
3. rerun validation
4. only rebuild embeddings if the problem is actually retrieval-index related
