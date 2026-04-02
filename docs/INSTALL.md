# Install

## Requirements
- Windows PowerShell for the Windows install/startup flow
- PowerShell 7 (`pwsh`) for macOS/Linux install and shared-MCP control scripts
- Node.js on `PATH`
- A usable Python runtime for shared semantic search; `scripts/install.ps1` auto-detects one and can fall back to uv-managed Python
- Obsidian installed locally
- `uv` if you want the shared `fetch` and `time` MCP services
- `npx` if you want the shared `context7` and `sequential-thinking` MCP services

## Support Levels
- Windows:
  - full install, shared MCP startup, watchdog startup registration, and client wiring are live-validated here
- macOS/Linux:
  - install, shared-MCP start/status/stop wrappers, and startup registration are implemented through `pwsh`
  - installed runtime commands now also get generated root `.sh` wrappers so day-to-day operations do not require manually typing `pwsh -File ...`
  - the shipped `.sh` wrappers are POSIX `sh`, not Bash-only
  - current live acceptance is still deepest on Windows, but the portable entrypoints and layout are now shipped in the public bundle

## Default Install Target
The bundle installs into:

`~/.ai-memory` on every platform.

## One-Line Install
From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot <your-project-root>
```

```bash
./scripts/install.sh -WorkspaceRoot <your-project-root>
```

If you are changing the runtime layout itself, validate the contract first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
```

```bash
./scripts/validate-layout.sh
```

## What The Installer Does
1. Copies the runtime into `~/.ai-memory`
2. Flattens the grouped source tree according to `scripts/install-layout.psd1` so runtime entrypoints remain stable
3. Copies the shared MCP runtime, proxy scripts, and `package.json`
4. Removes stale managed runtime files left behind by older installs or renamed entrypoints
5. Runs `npm ci --omit=dev` inside `~/.ai-memory/shared-mcp` when a lockfile is present, falling back to `npm install --omit=dev` only if the lockfile is absent
6. Writes `~/.ai-memory/install-manifest.json` so later upgrades know which files are installer-managed
7. Preserves any existing `agents.json`
8. Resolves a usable Python runtime
9. Best-effort installs the lightweight retrieval dependencies used by shared search today: `rank-bm25` and `jieba`
10. On Windows, writes `AI_MEMORY_PYTHON` and `AI_MEMORY_ROOT` into the user environment
11. On macOS/Linux, generates `activate-ai-memory.sh` and `activate-ai-memory.ps1` instead of trying to mutate shell startup files automatically
12. Registers watchdog startup through the native per-user startup mechanism for the current OS:
    - Windows Startup folder
    - macOS LaunchAgents
    - Linux `systemd --user`, or XDG autostart when `systemctl --user` is unavailable
13. Registers the safe default shared MCP bootstrap through the same OS-specific mechanism
14. Generates initial shared-memory artifacts, runtime shell wrappers, and MCP config snippets
15. Applies supported client integrations through `install-client-integrations.ps1` when `-ApplyClientIntegrations` stays enabled
16. Starts the watchdog and shared MCP stack immediately for the current interactive session unless the installer is running under CI

## After Install
If you want the environment variables in your current macOS/Linux shell session, run:

```bash
source ~/.ai-memory/activate-ai-memory.sh
```

If `pwsh` is installed in a non-standard location for your shell environment, set `AI_MEMORY_PWSH` before using the `.sh` wrappers.

Start the shared MCP stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

That default starter brings up:
- `context7`
- `fetch`
- `time`
- `sequential-thinking`
- `obsidian`
- `memory`
- `playwright`
- `MiniMax` only when its environment variables are configured or the starter is told to include it explicitly

If you want a narrower shared set and prefer to leave Playwright out, start an explicit subset instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-shared-mcp.ps1 -Only context7,fetch,time,sequential-thinking,obsidian,memory
```

```bash
~/.ai-memory/shared-mcp/start-shared-mcp.sh -Only context7,fetch,time,sequential-thinking,obsidian,memory
```

Register a client pack explicitly if you need a generated onboarding preset:

The installer already auto-applies supported client integrations when you pass `-WorkspaceRoot`. Re-apply them manually later without reinstalling:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\install-client-integrations.ps1 -WorkspaceRoot <your-project-root>
```

```bash
~/.ai-memory/install-client-integrations.sh -WorkspaceRoot <your-project-root>
```

By default, that apply step wires every shared-mode server in `shared-mcp/manifest.json`, plus `playwright`. Add `-IncludeOptionalServers` if you also want `MiniMax`. Use `-SkipPlaywright` if you want a narrower footprint.

`verify-integrations.ps1` and `verify-integrations.sh` remain as compatibility aliases, but they now forward into `install-client-integrations` and should be treated as side-effecting apply helpers rather than validators.

Verify the setup with the hard validation gate:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks -RunRuntimeChecks
```

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <your-project-root> -RunCliChecks -RunRuntimeChecks
```

Pressure test before trusting a heavy multi-agent workflow:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

`<your-project-root>` means the repository or workspace root where overlays such as `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/rules/shared-memory.md`, and `opencode.json` should be written. It is not the user-home config directory itself.

If you need the installer to skip client rewiring entirely, pass `-ApplyClientIntegrations false`. If you want the installer to include optional servers such as `MiniMax` during that automatic apply step, pass `-IncludeOptionalClientServers`.

## Optional Secrets
These must be environment variables, not committed files.

### MiniMax Shared MCP
```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_HOST", "https://api.minimax.chat", "User")
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "<your-key>", "User")
```

```bash
export MINIMAX_API_HOST="https://api.minimax.chat"
export MINIMAX_API_KEY="<your-key>"
```

If `minimax-coding-plan-mcp` is not already on `PATH`, point the wrapper at it explicitly:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_MCP_COMMAND", "C:\path\to\minimax-coding-plan-mcp.exe", "User")
```

```bash
export MINIMAX_MCP_COMMAND="/path/to/minimax-coding-plan-mcp"
```

Make sure `minimax-coding-plan-mcp` is available on `PATH` before enabling the shared MiniMax service.

### Optional OpenAI-Compatible Embeddings
The installer seeds `~/.ai-memory/config/runtime.json` on first install. Prefer switching providers there through:
- `embeddings.defaults`
- `embeddings.providers.<name>`
- `embeddings.profiles.<name>.provider`

Use environment variables for secrets, temporary overrides, or quick live tests.

```powershell
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_PROVIDER", "openai-compatible-remote", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_ADAPTER", "openai-compatible", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_BASE_URL", "https://your-openai-compatible-endpoint/v1", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_API_KEY", "<your-key>", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_MODEL", "<your-model-id>", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_PROFILE", "openai-compatible", "User")
```

```bash
export AI_MEMORY_EMBED_PROVIDER="openai-compatible-remote"
export AI_MEMORY_EMBED_ADAPTER="openai-compatible"
export AI_MEMORY_EMBED_BASE_URL="https://your-openai-compatible-endpoint/v1"
export AI_MEMORY_EMBED_API_KEY="<your-key>"
export AI_MEMORY_EMBED_MODEL="<your-model-id>"
export AI_MEMORY_EMBED_PROFILE="openai-compatible"
```

If you are driving the system through the shared `memory` MCP, prefer:
- `list_embedding_runtimes` to inspect the configured defaults/providers/profiles
- `set_embedding_runtime` to switch the persisted active profile/provider
- `memory_status.embeddingIndexState` to see whether the dense index is aligned, stale, mixed, or missing

`list_embedding_runtimes` also annotates each configured provider/profile with `configHash`, `indexedCount`, `indexCompatible`, and `rebuildRequired`, so you can tell in advance whether switching to that runtime will need a rebuild.

For the long-running shared runtime, `runtime.json` is now the canonical selector by default. If you truly want one process to honor selection/tuning env overrides such as `AI_MEMORY_EMBED_PROFILE` or `AI_MEMORY_EMBED_MODEL`, opt in explicitly:

```powershell
$env:AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES = "1"
```

```bash
export AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES="1"
```

After changing remote embedding settings, rebuild the index so the stored vectors match the active provider:

```powershell
node $env:AI_MEMORY_ROOT\generate-embeddings.js
```

```bash
node ~/.ai-memory/generate-embeddings.js
```

## Notes
- The default dense retrieval backend is offline `hashing-v1`
- `config/runtime.json` is the provider/profile runtime registry for embeddings; keep secrets out of it and use `apiKeyEnv`
- `AI_MEMORY_EMBED_BACKEND` remains supported as a compatibility alias, but new setups should prefer `AI_MEMORY_EMBED_ADAPTER`
- Switching providers or profiles is a config change, not a true dense hot swap. Rebuild the stored index after changing adapter, model, or base URL.
- `set_embedding_runtime` updates the persisted runtime selection, but it does not silently mutate the dense index; check `memory_status.embeddingIndexState.rebuildRequired`
- Shared `memory` MCP now ignores selection/tuning embedding env overrides by default so stale user-level env vars do not silently shadow `runtime.json`; set `AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES=1` only for deliberate per-process overrides
- `apiKeyConfigured` in runtime status is now meaningful only for providers that actually need an API key; local hash/transformer profiles no longer show a misleading `true` just because a remote key exists in the environment
- Remote embeddings are optional and should be tested with the probe and benchmark scripts first
- The embeddings index now stores a provider fingerprint (`adapter + model + base URL`) to avoid silently reusing vectors from a different remote endpoint
- Remote rebuilds now stop on provider errors by default so one run cannot write a mixed `openai + hash` index; set `AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK=1` only if you intentionally want batch-level fallback
- Shared `fetch` and `time` now prefer `AI_MEMORY_MCP_PYTHON` and need a Python 3.10+ runtime; the installer auto-selects a compatible uv-managed Python when available
- If your network to PyPI is slow, set `AI_MEMORY_PIP_INDEX_URL` or `PIP_INDEX_URL` before install so auxiliary Python MCP packages can use a faster mirror
- `pencil` stays isolated because it is tied to desktop UI state
- `playwright` is shared by default in the starter script because it is usually the largest source of duplicated per-agent MCP processes, but you can omit it by starting an explicit subset
- `install-manifest.json` is installer-owned state; keep it in the installed runtime so upgrades can clean up stale managed files safely
- The shared `memory` MCP and OpenClaw blackboard daemon no longer depend on native Node `sqlite3`; they use Python's standard-library `sqlite3` through the resolved Python runtime instead
- Before install, source-tree direct runs can resolve `templates/config/runtime.json`; after install, the canonical runtime config path should be `~/.ai-memory/config/runtime.json`
