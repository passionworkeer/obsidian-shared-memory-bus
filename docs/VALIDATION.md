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
- shared MCP stack starts cleanly from the default starter
- shared services keep stable listener PIDs across repeated checks
- shared `memory` and `obsidian` initialize and list tools successfully
- shared Playwright responds to real MCP browser calls
- client integration checks pass for the main supported local clients

## Validated Clients
- Codex
- Claude Code
- OpenCode
- Cursor config path
- VS Code / GitHub Copilot config path
- OpenClaw bridge path

## Pressure Story
The bundle has already been validated with repeated multi-wave shared-stack pressure checks. The important signal is stable single listeners on the shared ports rather than one new MCP process per task.

## Known Non-Blocking Noise
- some client `mcp list` flows can show false negatives for the shared Playwright backend
- old already-running sessions may keep old local Playwright trees alive until those sessions close
- optional third-party integrations can fail independently of the base local shared-memory stack

## Reproduce The Basic Validation
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```
