# Validation

This document records the current validation story for the public bundle.

## Shared Ports
- `9331`: `context7`
- `9332`: `fetch`
- `9333`: `time`
- `9334`: `sequential-thinking`
- `9335`: `obsidian`
- `9336`: `MiniMax` when configured
- `9337`: `playwright`
- `9338`: `memory`

## Validated Behaviors
- source-to-install layout validates cleanly through `scripts/validate-layout.ps1`
- portable shell wrappers parse cleanly through `sh -n` and invoke the same PowerShell entrypoints
- installed runtime now emits root `.sh` wrappers and activation helpers for macOS/Linux
- shared MCP stack starts cleanly from the default starter
- shared services keep stable listener PIDs across repeated checks
- shared `memory` and `obsidian` initialize and list tools successfully
- shared Playwright responds to real MCP browser calls
- client integration checks pass for the main supported local clients
- layered memory generation succeeds through `ops/build-memory-layers.js`
- bounded handoff pack generation succeeds through `ops/build-handoff-pack.js`
- dream consolidation succeeds through `ops/run-memory-dream.ps1`
- OpenClaw blackboard sync works both ways between SQLite and `02-KB/WORKING.md`
- the shared memory core no longer requires native Node `sqlite3`
- installed `install.sh` smoke runs now validate the flat runtime layout plus executable `shared-mcp/*.sh` wrappers on Windows, macOS, and Linux CI runners

## Validated Clients
- Codex
- Claude Code
- OpenCode
- Cursor config path
- VS Code / GitHub Copilot config path
- OpenClaw bridge path

## Pressure Story
The bundle has already been validated with repeated multi-wave shared-stack pressure checks. The important signal is stable single listeners on the shared ports rather than one new MCP process per task.

## Current Live Results
Validated on this workstation on April 2, 2026:
- `verify-client-integrations.ps1 -RunCliChecks` passed for Codex, Claude Code, OpenCode, Cursor, VS Code/Copilot paths, and workspace configs
- `run-pressure-test.ps1 -Waves 5 -RunCliChecks` passed `35/35` with `overallPass=true`, `singleListenerPerPort=true`, and stable shared PIDs
- `scripts/validate-layout.sh` and `shared-mcp/status-shared-mcp.sh` were smoke-executed locally through Git Bash with `AI_MEMORY_PWSH=powershell.exe`
- `scripts/install.sh -TargetRoot <temp> -RegisterStartup false -PersistUserEnvironment false` completed successfully, and the installed `shared-mcp/status-shared-mcp.sh` wrapper returned healthy shared services from that temporary flat runtime
- installed `semantic-search.py --mode hybrid --json` succeeded from `~/.ai-memory` with the runtime config resolved from the installed flat layout
- a post-hardening rerun of `run-pressure-test.ps1 -Waves 3 -RunCliChecks` passed `21/21` after removing the blackboard daemon's native Node `sqlite3` dependency
- `sync-openclaw-to-obsidian.js` successfully ingested OpenClaw sessions, jobs, runs, blackboard tasks, and journal records
- `benchmark-architecture.py` produced an average retrieval score of `0.867`
- a dedicated smoke test confirmed the OpenClaw blackboard daemon still syncs both `SQLite -> WORKING.md` and `WORKING.md -> SQLite`

Portable-core CI now also smoke-runs the same wrapper chain on `windows-latest`, `ubuntu-latest`, and `macos-latest`. Treat that as portable-core coverage, not identical live operator acceptance on all three platforms.

## Known Non-Blocking Noise
- some client `mcp list` flows can show false negatives for the shared Playwright backend
- old already-running sessions may keep old local Playwright trees alive until those sessions close
- optional third-party integrations can fail independently of the base local shared-memory stack

## Reproduce The Basic Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

```bash
./scripts/validate-layout.sh
./scripts/install.sh
source ~/.ai-memory/activate-ai-memory.sh
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <your-project-root> -RunCliChecks
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

## CI Guardrail
The repository also includes `.github/workflows/windows-validate.yml`, which runs the layout validator and a temporary Windows smoke install on every PR and push to `main`.

For the portable core, `.github/workflows/portable-core.yml` runs a three-platform smoke matrix over layered memory generation, dream consolidation, embeddings, hybrid retrieval, and the public `install.sh` plus `shared-mcp/*.sh` wrapper chain on Windows, macOS, and Linux.
