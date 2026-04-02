# Troubleshooting

## Installer Fails Immediately

Check these first:
- `Node.js` is installed and `npm` is on `PATH`
- `powershell.exe` can run local scripts with `-ExecutionPolicy Bypass`
- the target install path is writable

Quick checks:

```powershell
node -v
npm -v
```

## `search_shared_memory` Returns `spawn python ENOENT`

Cause:
- the machine has Python installed, but not exposed as `python` on `PATH`
- only Windows Store shims exist, which are not usable as a real interpreter

Fix:
- rerun `scripts/install.ps1`; the installer now resolves a usable interpreter and persists `AI_MEMORY_PYTHON`
- if needed, set `AI_MEMORY_PYTHON` manually to a real interpreter path such as `C:\Users\<you>\AppData\Roaming\uv\python\...\python.exe`

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
3. the active or most recent vault in `%APPDATA%\obsidian\obsidian.json`
4. `%USERPROFILE%\Documents\Obsidian Vault`

If auto-detection is wrong, set it explicitly:

```powershell
[Environment]::SetEnvironmentVariable("AI_MEMORY_OBSIDIAN_VAULT", "D:\Your\Vault", "User")
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

## Shared MCP Ports Are Already In Use

Inspect shared listeners:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\status-shared-mcp.ps1
```

Force a clean restart:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

## `search_shared_memory` Falls Back To BM25 After Switching Embedding Provider

If `search_shared_memory` reports a fallback reason like `embedding-config-mismatch` or `embedding-dimension-mismatch`, the query side is using different embedding settings from the stored index.

Fix:
- confirm the active environment variables:
  - `AI_MEMORY_EMBED_BACKEND`
  - `AI_MEMORY_EMBED_BASE_URL`
  - `AI_MEMORY_EMBED_MODEL`
- rebuild the stored index:

```powershell
node $env:USERPROFILE\.ai-memory\generate-embeddings.js
```

- inspect `memory_status` and confirm:
  - `embeddings.backends`
  - `embeddings.models`
  - `embeddings.dimensions`
  - `embeddings.providerHosts`

If a remote rebuild fails with an API error (for example `403`), the run now aborts instead of silently mixing remote and hash vectors in one index. Increase `AI_MEMORY_EMBED_REQUEST_DELAY_MS`, retry later, or use the smaller probe/benchmark scripts before attempting another full rebuild.

## Shared MCP Starts But Stays Unhealthy

If `context7`, `fetch`, `time`, or `playwright` keep showing `running=false` after a restart, inspect the per-server logs under `%USERPROFILE%\.ai-memory\shared-mcp\logs\`.

Typical cause:
- an old pinned upstream package version was removed from npm or PyPI

The bundled manifest now prefers registry-resolvable current specs for these thin wrapper servers, but if you are upgrading from an older install, reinstall the runtime first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

## Playwright Shows Failed In A Client `mcp list`

This can be a false negative.

Some clients do shallow transport checks that do not perfectly match the shared Playwright HTTP backend, even when real MCP calls still work. The shared runtime probes Playwright with an actual MCP `initialize` request on `http://127.0.0.1:9337/mcp`, which is the stronger health signal.

Check shared status first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\status-shared-mcp.ps1
```

If needed, force-restart just the shared Playwright backend:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-shared-mcp.ps1 -Only playwright -ForceRestart
```

Then verify with a real browser task instead of relying only on `mcp list`.

## Verify Before Heavy Multi-Agent Use

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

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
