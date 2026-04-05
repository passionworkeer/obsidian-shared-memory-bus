# Troubleshooting

## Installer Fails Immediately

Check these first:
- `Node.js` is installed and `npm` is on `PATH`
- `pwsh` is installed for the portable wrapper flow; on Windows, `powershell.exe` can still run local scripts with `-ExecutionPolicy Bypass`
- the target install path is writable

Quick checks:

```powershell
node -v
npm -v
```

## `.sh` Wrappers Cannot Find `pwsh`

Cause:
- PowerShell 7 is installed, but not exposed on `PATH` for the current shell
- the wrapper is POSIX `sh`, so it will not guess every custom install location

Fix:
- install `pwsh` normally and ensure it is on `PATH`
- or set `AI_MEMORY_PWSH` explicitly before running wrapper commands

```bash
export AI_MEMORY_PWSH="/opt/homebrew/bin/pwsh"
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## `search_shared_memory` Returns `spawn python ENOENT`

Cause:
- the machine has Python installed, but not exposed as `python` on `PATH`
- only Windows Store shims exist, which are not usable as a real interpreter

Fix:
- rerun `scripts/install.ps1`; the installer now resolves a usable interpreter and persists `AI_MEMORY_PYTHON`
- if needed, set `AI_MEMORY_PYTHON` manually to a real interpreter path such as `C:\Users\<you>\AppData\Roaming\uv\python\...\python.exe` or `~/.local/share/uv/python/.../bin/python3`

## `search_shared_memory` Works, But BM25 Or Chinese Recall Feels Weak

Cause:
- the shared Python runtime is missing `rank-bm25` and/or `jieba`
- shared search is falling back to simple keyword overlap and regex tokenization

Check:
- call `memory_status` and inspect `searchWorker.health.cacheState`
- confirm `bm25Available=true` and `jiebaAvailable=true`

Fix:
- rerun `scripts/install.ps1`; the installer now best-effort bootstraps `rank-bm25` and `jieba`
- if you manage Python manually, install them into the same interpreter exposed as `AI_MEMORY_PYTHON`

## Repeated Searches Still Feel Slow

Cause:
- the expensive part is often the remote query embedding call, not worker startup
- the shared worker now caches query embeddings and full result payloads, but full-result cache hits are intentionally invalidated whenever the structured JSONL or embeddings index changes

Check:
- call `memory_status` and inspect `searchWorker.health.cacheState.metrics`
- repeated stable queries should increase `queryEmbeddingHits`; on a quiet vault you may also see `searchResultHits`

Fix:
- keep using the shared `memory` MCP instead of per-agent local search processes
- if you want to reset state after large rebuilds or debugging, call `clear_shared_memory_search_cache`
- if the vault is extremely write-active, expect query-embedding cache hits to be more common than full-result cache hits

## OpenClaw Blackboard Sync Fails After Removing `sqlite3`

The blackboard daemon now uses Python's standard-library `sqlite3`, not the native Node `sqlite3` package.

Check:
- `AI_MEMORY_PYTHON` points to a real interpreter
- the OpenClaw database path is correct:
  - `OPENCLAW_BLACKBOARD_DB`
- the database actually has a `tasks` table

If needed, run:

```powershell
node .\ops\sync-openclaw-to-obsidian.js
```

## Obsidian MCP Does Not Start

`ops/run-obsidian-mcp.ps1` looks for the vault in this order:
1. `AI_MEMORY_OBSIDIAN_VAULT`
2. `OBSIDIAN_VAULT_ROOT`
3. the active or most recent vault in Obsidian's app config (`%APPDATA%\obsidian\obsidian.json`, `~/Library/Application Support/obsidian/obsidian.json`, or `~/.config/obsidian/obsidian.json`)
4. `~/Obsidian Vault`, `~/Desktop/Obsidian Vault`, or `~/Documents/Obsidian Vault`

If auto-detection is wrong, set it explicitly:

```powershell
[Environment]::SetEnvironmentVariable("AI_MEMORY_OBSIDIAN_VAULT", "D:\Your\Vault", "User")
```

```bash
export AI_MEMORY_OBSIDIAN_VAULT="$HOME/path/to/your/vault"
```

## MiniMax MCP Does Not Start

Make sure these exist:
- `MINIMAX_API_KEY`
- `MINIMAX_API_HOST` or let it default to `https://api.minimax.chat`
- `minimax-coding-plan-mcp` on `PATH`

If the executable is installed somewhere unusual:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_MCP_COMMAND", "C:\path\to\minimax-coding-plan-mcp.exe", "User")
```

```bash
export MINIMAX_MCP_COMMAND="$HOME/.local/bin/minimax-coding-plan-mcp"
```

## Shared MCP Ports Are Already In Use

Inspect shared listeners:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

Force a clean restart:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

## Startup Registration Did Not Appear Where I Expected

The installer uses different per-user startup mechanisms per OS:
- Windows: Startup folder shortcuts/scripts
- macOS: `~/Library/LaunchAgents`
- Linux: `~/.config/systemd/user`, or `~/.config/autostart` when `systemctl --user` is unavailable

If startup was skipped, check:
- whether the installer ran with `-RegisterStartup false`
- whether the target directory is writable
- on Linux, whether `systemctl --user` is actually available in the current session

If needed, rerun the installer and then inspect the generated startup files directly.

## `search_shared_memory` Falls Back To BM25 After Switching Embedding Provider

If `search_shared_memory` reports a fallback reason like `embedding-config-mismatch` or `embedding-dimension-mismatch`, the query side is using different embedding settings from the stored index.

Fix:
- confirm the active runtime selection in `~/.ai-memory/config/runtime.json` and any override variables:
  - `AI_MEMORY_EMBED_PROFILE`
  - `AI_MEMORY_EMBED_PROVIDER`
  - `AI_MEMORY_EMBED_ADAPTER` or legacy `AI_MEMORY_EMBED_BACKEND`
  - `AI_MEMORY_EMBED_BASE_URL`
  - `AI_MEMORY_EMBED_MODEL`
- if you are connected through the shared `memory` MCP, call:
  - `list_embedding_runtimes`
  - `memory_status`
  - inspect `memory_status.embeddingIndexState`
- rebuild the stored index:

```powershell
node $env:AI_MEMORY_ROOT\generate-embeddings.js
```

```bash
node ~/.ai-memory/generate-embeddings.js
```

- inspect `memory_status` and confirm:
  - `embeddingRuntime.profile`
  - `embeddingRuntime.provider`
  - `embeddingRuntime.adapter`
  - `embeddingIndexState.status`
  - `embeddingIndexState.rebuildRequired`
  - `embeddings.backends`
  - `embeddings.models`
  - `embeddings.dimensions`
  - `embeddings.providerHosts`

This usually means the config selection changed successfully, but the stored dense index still belongs to the older provider. Provider/profile switching is config-selectable, not a true dense hot swap.

If a remote rebuild fails with an API error (for example `403`), the run now aborts instead of silently mixing remote and hash vectors in one index. Increase `AI_MEMORY_EMBED_REQUEST_DELAY_MS`, retry later, or use the smaller probe/benchmark scripts before attempting another full rebuild.

## My Shared Runtime Ignores `AI_MEMORY_EMBED_PROFILE` Or `AI_MEMORY_EMBED_MODEL`

Cause:
- the shared `memory` MCP now treats `runtime.json` as canonical by default
- this is intentional, so stale user-level env vars do not keep overriding the saved runtime selection

Fix:
- use `set_embedding_runtime` or edit `~/.ai-memory/config/runtime.json`
- if you intentionally want one process to honor selection/tuning env overrides, opt in before launch:

```powershell
$env:AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES = "1"
```

```bash
export AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES="1"
```

## Source-Tree Commands Cannot Find `runtime.json`

Before install, source-tree tools can resolve runtime config from:
- `AI_MEMORY_RUNTIME_CONFIG_PATH`
- `config/runtime.json`
- `templates/config/runtime.json`

After install, the canonical path should be `~/.ai-memory/config/runtime.json`.

If you are running directly from the repository and see config-path errors:
- install the runtime first, or
- set `AI_MEMORY_RUNTIME_CONFIG_PATH` explicitly, or
- ensure `templates/config/runtime.json` still exists in the source tree

## Shared MCP Starts But Stays Unhealthy

If `context7`, `fetch`, `time`, or `playwright` keep showing `running=false` after a restart, inspect the per-server logs under `~/.ai-memory/shared-mcp/logs/`.

Typical cause:
- an old pinned upstream package version was removed from npm or PyPI
- `fetch` / `time` do not have a usable Python 3.10+ runtime for `mcp_server_fetch` / `mcp_server_time`
- package downloads are timing out against the default PyPI index in your region

The bundled manifest now prefers registry-resolvable current specs for these thin wrapper servers, but if you are upgrading from an older install, reinstall the runtime first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot <repo-root>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

```bash
./scripts/install.sh -WorkspaceRoot <repo-root>
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

For shared `fetch` / `time` specifically, also verify:
- `AI_MEMORY_MCP_PYTHON` points at a Python 3.10+ runtime
- that runtime can import `mcp_server_fetch` and `mcp_server_time`
- `AI_MEMORY_PIP_INDEX_URL` or `PIP_INDEX_URL` is set if you need a faster PyPI mirror

## Playwright Shows Failed In A Client `mcp list`

This can be a false negative.

Some clients do shallow transport checks that do not perfectly match the shared Playwright HTTP backend, even when real MCP calls still work. The shared runtime probes Playwright with an actual MCP `initialize` request on `http://127.0.0.1:9337/mcp`, which is the stronger health signal.

Check shared status first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

If needed, force-restart just the shared Playwright backend:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-shared-mcp.ps1 -Only playwright -ForceRestart
```

```bash
~/.ai-memory/shared-mcp/start-shared-mcp.sh -Only playwright -ForceRestart
```

Then verify with a real browser task instead of relying only on `mcp list`.

## Verify Before Heavy Multi-Agent Use

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 -WorkspaceRoot <repo-root> -RunCliChecks -RunRuntimeChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 -WorkspaceRoot <repo-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <repo-root> -RunCliChecks -RunRuntimeChecks
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <repo-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

`<repo-root>` must be an existing workspace root if you pass it. `verify-client-integrations` is a self-healing validator, not a read-only probe, so it may restart unhealthy shared MCP services and refresh its report file. For a read-only snapshot, use `shared-mcp/status-shared-mcp.ps1 -Json`.

Good signs:
- one listener per shared port
- stable PIDs across waves
- `memory` and `obsidian` MCP endpoints stay healthy
- `playwright` shows `running=true` in `status-shared-mcp.ps1`

If Playwright is the only noisy line in a client CLI health report but real browser tasks still succeed, treat that as a client-side health-check quirk rather than a blocker.

## `npm audit` Shows Vulnerabilities

The current `shared-mcp/package-lock.json` is expected to audit cleanly. If a future upstream package reintroduces warnings:
- keep the repo clean and secret-free
- prefer controlled dependency updates
- avoid `npm audit fix --force` unless you have revalidated the shared MCP runtime afterward
