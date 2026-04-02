# Install

## Requirements
- Windows PowerShell for the full installer and startup registration flow
- PowerShell 7 (`pwsh`) if you want to run the portable core scripts on macOS or Linux
- Node.js on `PATH`
- A usable Python runtime for shared semantic search; `scripts/install.ps1` auto-detects one and can fall back to uv-managed Python
- Obsidian installed locally
- `uv` if you want the shared `fetch` and `time` MCP services
- `npx` if you want the shared `context7` and `sequential-thinking` MCP services

## Support Levels
- Windows:
  - full install, shared MCP startup, watchdog startup registration, and client wiring are validated here
- macOS/Linux:
  - core memory generation, dream consolidation, embeddings, and retrieval are portable
  - full installer/startup automation is not yet parity-complete with Windows

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

If you are changing the runtime layout itself, validate the contract first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
```

## What The Installer Does
1. Copies the runtime into `%USERPROFILE%\.ai-memory`
2. Flattens the grouped source tree according to `scripts/install-layout.psd1` so runtime entrypoints remain stable
3. Copies the shared MCP runtime, proxy scripts, and `package.json`
4. Removes stale managed runtime files left behind by older installs or renamed entrypoints
5. Runs `npm ci --omit=dev` inside `%USERPROFILE%\.ai-memory\shared-mcp` when a lockfile is present, falling back to `npm install --omit=dev` only if the lockfile is absent
6. Writes `%USERPROFILE%\.ai-memory\install-manifest.json` so later upgrades know which files are installer-managed
7. Preserves any existing `agents.json`
8. Resolves a usable Python runtime and writes `AI_MEMORY_PYTHON` into the user environment
9. Writes `AI_MEMORY_ROOT` into the user environment
10. Registers watchdog startup on Windows
11. Registers the safe default shared MCP startup shortcut
12. Generates initial shared-memory artifacts and MCP config snippets
13. Starts the watchdog and shared MCP stack immediately for the current interactive session unless the installer is running under CI

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\register-agent.ps1 -AgentName cursor -Preset cursor
```

Wire supported local clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-integrations.ps1 -WorkspaceRoot <your-project-root>
```

Verify the setup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Pressure test before trusting a heavy multi-agent workflow:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
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

After changing remote embedding settings, rebuild the index so the stored vectors match the active provider:

```powershell
node $env:USERPROFILE\.ai-memory\generate-embeddings.js
```

## Notes
- The default dense retrieval backend is offline `hashing-v1`
- Remote embeddings are optional and should be tested with the probe and benchmark scripts first
- The embeddings index now stores a provider fingerprint (`backend + model + base URL`) to avoid silently reusing vectors from a different remote endpoint
- Remote rebuilds now stop on provider errors by default so one run cannot write a mixed `openai + hash` index; set `AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK=1` only if you intentionally want batch-level fallback
- `pencil` stays isolated because it is tied to desktop UI state
- `playwright` is shared by default in the starter script because it is usually the largest source of duplicated per-agent MCP processes, but you can omit it by starting an explicit subset
- `install-manifest.json` is installer-owned state; keep it in the installed runtime so upgrades can clean up stale managed files safely
- The shared `memory` MCP and OpenClaw blackboard daemon no longer depend on native Node `sqlite3`; they use Python's standard-library `sqlite3` through the resolved Python runtime instead
