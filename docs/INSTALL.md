# Install

## Requirements
- Windows PowerShell for the Windows install/startup flow
- PowerShell 7 (`pwsh`) for macOS/Linux install and shared-MCP control scripts
- Node.js on `PATH`
- A usable Python runtime for shared semantic search; `scripts/install.ps1` auto-detects one and can fall back to uv-managed Python
- `uv` if you want the shared `fetch` and `time` MCP services
- `npx` if you want the shared `context7` and `sequential-thinking` MCP services

> **Note:** Obsidian is no longer required. The shared memory store is a pure local filesystem at `AI_MEMORY_STORE` (default `E:\.ai-memory\`). Obsidian can still be used as a human-readable browsing layer, but it is not a dependency.

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

`-WorkspaceRoot` is optional. When provided, it must point at an existing repo/workspace root where overlays should be written.

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
Startup hooks and some internal helpers now launch hidden in the background on Windows, but manual `install`, `start`, `status`, `verify`, and `pressure` commands are still foreground terminal commands by design.

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
- `memory` (with `memory_boot`, `memory_query`, `search_shared_memory`, etc.)
- `playwright`
- `MiniMax` only when its environment variables are configured or the starter is told to include it explicitly

### Search Capabilities

The `memory` MCP server exposes `memory_wake_up` as a compact session bootstrap tool available at port 9338. It returns a structured pack combining durable anchors, handoff data, and recent activity without requiring individual file reads.

The server also supports verbatim snippet extraction on `search_shared_memory`:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeVerbatim` | `boolean` | `false` | Return query-aware exact snippet windows around matched text |
| `snippetWindow` | `integer` | `220` | Character window kept around each exact match |
| `maxVerbatimPerResult` | `integer` | `1` | Maximum verbatim snippet windows per result |

### Standalone Operations

The watchdog supervisor can be started independently of the shared MCP stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\bus\memory-watchdog-supervisor.ps1 -Daemon
```

```bash
pwsh "$HOME/.ai-memory/bus/memory-watchdog-supervisor.ps1" -Daemon
```

Inbox hygiene removes entries older than 7 days:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\cleanup-inbox.ps1
```

```bash
pwsh "$HOME/.ai-memory/ops/cleanup-inbox.ps1"
```

### Memory Generation Pipeline

After install, run the full memory generation pipeline for complete bootstrap data:

```powershell
node $env:AI_MEMORY_ROOT\ops\build-memory-layers.js
node $env:AI_MEMORY_ROOT\ops\build-handoff-pack.js
```

```bash
node ~/.ai-memory/ops/build-memory-layers.js
node ~/.ai-memory/ops/build-handoff-pack.js
```

These are also run automatically by `install.ps1`, but you can re-run them to refresh generated artifacts at any time.

If you want a narrower shared set and prefer to leave Playwright out, start an explicit subset instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-shared-mcp.ps1 -Only context7,fetch,time,sequential-thinking,memory
```

```bash
~/.ai-memory/shared-mcp/start-shared-mcp.sh -Only context7,fetch,time,sequential-thinking,memory
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

`verify-client-integrations` is a self-healing validation gate, not a read-only status probe. It may restart unhealthy shared MCP services and always refreshes its report file. If you only want to inspect state, use `shared-mcp/status-shared-mcp.ps1 -Json` or `shared-mcp/status-shared-mcp.sh -Json`.

Pressure test before trusting a heavy multi-agent workflow:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

`<your-project-root>` means the existing repository or workspace root where overlays such as `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/rules/shared-memory.md`, and `opencode.json` should be written. It is not the user-home config directory itself.

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

---

## Adding Another AI Tool

### Quick Connect (Windows)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\install-client-integrations.ps1 -WorkspaceRoot <your-project-root>
```

This auto-configures: Claude Code, OpenCode, Cursor, VS Code/Copilot, Trae.

### Manual HTTP MCP Endpoints

All tools support these shared endpoints:

| Service | Endpoint | What it does |
|---------|----------|--------------|
| memory | http://127.0.0.1:9338/mcp | Shared memory search, memory_boot, memory_query |
| context7 | http://127.0.0.1:9331/mcp | Code search |
| fetch | http://127.0.0.1:9332/mcp | Web fetch |
| time | http://127.0.0.1:9333/mcp | Current time |
| playwright | http://127.0.0.1:9337/mcp | Browser automation (optional) |

### Shared Memory Read Order

Preferred: use `memory_wake_up` on port 9338 for compact structured bootstrap.

Fallback: read files in this order:
1. `SKILL.md` (repository root) — universal entry point
2. `{store}/generated/L0-bootstrap.md` — L0 + L1 facts (project-aware)
3. `{store}/generated/GLOBAL-CONTEXT.md` — full history overlay
4. `{store}/generated/SHARED-SKILLS.md` — shared skill context

### Durable Writeback Rules
- Cross-project facts → `{store}/inbox/{tool}.md`
- Active task state → `{store}/structured/session-memory.jsonl`
- Project-specific facts → relevant project note in vault or store
- **Never write secrets into shared memory**

### Canonical Read Order for Structured Bootstrap
Use `memory_wake_up` MCP tool on port 9338 — returns durable anchors, next steps, blockers, and recent activity in a single call.

### Verbatim Snippet Search
`search_shared_memory` supports:
- `includeVerbatim: true` — return query-aware exact text windows
- `snippetWindow` (default 220 chars) — character window size
- `maxVerbatimPerResult` (default 1) — snippets per result
