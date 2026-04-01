# Install

## Requirements
- Windows PowerShell
- Node.js on `PATH`
- Python on the machine if you want the Python-based search helpers
- Obsidian installed locally
- `uv` if you want the shared `fetch` and `time` MCP services
- `npx` if you want the shared `context7` and `sequential-thinking` MCP services

## Default Install Target
The bundle installs into:

```text
%USERPROFILE%\.ai-memory
```

## One-Line Install
From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## What The Installer Does
1. Copies the runtime into `%USERPROFILE%\.ai-memory`
2. Copies the shared MCP runtime, proxy scripts, and `package.json`
3. Runs `npm install --omit=dev` inside `%USERPROFILE%\.ai-memory\shared-mcp`, including the local `@bitbonsai/mcpvault` dependency
4. Preserves any existing `agents.json`
5. Writes `AI_MEMORY_ROOT` into the user environment
6. Registers watchdog startup on Windows
7. Registers the safe default shared MCP startup shortcut
8. Generates initial shared-memory artifacts and MCP config snippets

## After Install
Start the shared MCP stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
```

That default starter brings up:
- `context7`
- `fetch`
- `time`
- `sequential-thinking`
- `obsidian`
- `memory`
- `playwright`
- `MiniMax` when its environment variables are configured

If you want a narrower shared set and prefer to leave Playwright out, start an explicit subset instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-shared-mcp.ps1 -Only context7,fetch,time,sequential-thinking,obsidian,memory
```

Register a client:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\bus\register-agent.ps1 -AgentName cursor -Preset cursor
```

Wire supported local clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-integrations.ps1 -WorkspaceRoot <your-project-root>
```

Verify the setup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Pressure test before trusting a heavy multi-agent workflow:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

## Optional Secrets
These must be environment variables, not committed files.

### MiniMax Shared MCP
```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_HOST", "https://api.minimax.chat", "User")
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "<your-key>", "User")
```

If `minimax-coding-plan-mcp` is not already on `PATH`, point the wrapper at it explicitly:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_MCP_COMMAND", "C:\path\to\minimax-coding-plan-mcp.exe", "User")
```

Make sure `minimax-coding-plan-mcp.exe` is available on `PATH` before enabling the shared MiniMax service.

### Optional OpenAI-Compatible Embeddings
```powershell
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_BACKEND", "openai", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_BASE_URL", "https://your-openai-compatible-endpoint/v1", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_API_KEY", "<your-key>", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_MODEL", "<your-model-id>", "User")
```

## Notes
- The default dense retrieval backend is offline `hashing-v1`
- Remote embeddings are optional and should be tested with the probe and benchmark scripts first
- `pencil` stays isolated because it is tied to desktop UI state
- `playwright` is shared by default in the starter script because it is usually the largest source of duplicated per-agent MCP processes, but you can omit it by starting an explicit subset
