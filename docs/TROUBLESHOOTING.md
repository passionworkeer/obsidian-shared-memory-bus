# Troubleshooting

## Vault Not Found

**Error**: `VAULT_RESOLUTION_FAILED` at session start, or memory files not being written/read.

**What to do**:

1. **Check if Obsidian is installed and has opened a vault at least once.** The vault path is discovered from Obsidian's app config. If no vault was ever opened, the config won't exist.

2. **Set the vault path explicitly.** Open a PowerShell prompt and run:
   ```powershell
   [Environment]::SetEnvironmentVariable("AI_MEMORY_OBSIDIAN_VAULT", "E:\desktop\Obsidian Vault", "User")
   ```
   Adjust the path to match your actual vault location.

3. **Verify the vault contains the expected folder structure.** The memory bus expects:
   ```
   <vault>/
   ├── 00-System/
   │   └── ai-memory/
   │       ├── inbox/
   │       ├── structured/
   │       └── generated/
   ├── 02-KB/
   │   ├── OBSIDIAN.md
   │   ├── MEMORY.md
   │   └── WORKING.md
   ```

4. **If the folders don't exist**, run the installer which creates them:
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

5. **Verify the path is correct**:
   ```powershell
   # Windows
   echo $env:AI_MEMORY_OBSIDIAN_VAULT
   dir "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory"

   # macOS/Linux
   echo $AI_MEMORY_OBSIDIAN_VAULT
   ls "$AI_MEMORY_OBSIDIAN_VAULT/00-System/ai-memory"
   ```

---

## Embedding API Errors

### API Key Not Set

**Error**: `401 Unauthorized`, `403 Forbidden`, or `embedding_config_mismatch` in search results.

**What to do**:

1. **For OpenAI-compatible providers** (Ollama, ModelScope, Groq, etc.):
   ```powershell
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_PROVIDER", "openai-compatible-remote", "User")
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_ADAPTER", "openai-compatible", "User")
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_BASE_URL", "https://your-endpoint/v1", "User")
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_API_KEY", "your-api-key", "User")
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_MODEL", "your-model-name", "User")
   ```

2. **Rebuild the embeddings index** after setting the API key:
   ```powershell
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```

3. **Verify the settings are saved**:
   ```powershell
   cat ~/.ai-memory/config/runtime.json
   ```
   Confirm `profile`, `provider`, `adapter`, `baseUrl`, and `model` all match your intended provider.

### Rate Limit Errors

**Error**: `429 Too Many Requests` during embeddings build.

**What to do**:

1. **Increase the request delay** to respect rate limits:
   ```powershell
   [Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_REQUEST_DELAY_MS", "500", "User")
   ```

2. **Retry the embeddings rebuild**:
   ```powershell
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```

3. **If using a remote provider**, wait a few minutes and try again. Rate limits typically reset within 60 seconds.

### Embedding Dimension Mismatch

**Error**: `embedding-dimension-mismatch` in search results.

**What to do**:

1. **This means the stored index was built with a different model than the current query side.** Rebuild the index:
   ```powershell
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```

2. **If the rebuild fails with an API error**, the run now aborts instead of silently mixing vectors. Fix the API issue first, then retry.

---

## Watchdog Not Running

**Symptoms**: Memory entries appear but are not refreshed; `memory_status.watchdog.status: stale`; new inbox entries are not indexed.

**What to do**:

1. **Check if the watchdog process is running**:
   ```powershell
   powershell -File shared-mcp/status-shared-mcp.ps1
   ```
   Look for `watchdog.running: true`.

2. **Start the watchdog**:
   ```powershell
   powershell -File shared-mcp/start-default-shared-mcp.ps1 -ForceRestart
   ```

3. **Run a one-shot sync** to process pending changes immediately:
   ```powershell
   powershell -File bus/memory-watchdog.ps1 -Once
   ```

4. **If the watchdog keeps stopping**, check the logs under `~/.ai-memory/shared-mcp/logs/`. The most common cause is a Python or Node.js crash during startup.

---

## Memory Not Appearing in Context

**Symptoms**: You wrote to inbox but `search_shared_memory` returns no results. Entries are not in GLOBAL-CONTEXT.md.

**What to do**:

1. **Force a full sync**:
   ```powershell
   powershell -File bus/memory-bus.ps1 -Action SyncAll
   ```

2. **Check if the entry was written to JSONL**:
   ```powershell
   # Find the structured JSONL files
   Get-ChildItem -Path "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured" -Filter "*.jsonl" | ForEach-Object {
       Select-String -Path $_.FullName -Pattern "your-search-term" -List
   }
   ```
   If the entry is in the JSONL, it was indexed. If not, the sync didn't pick it up.

3. **Check if embeddings were rebuilt**. Run:
   ```powershell
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```
   Then check:
   ```powershell
   (Get-ChildItem -Path "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\embeddings\index.jsonl").LastWriteTime
   ```
   The index timestamp should be newer than when you wrote the entry.

4. **Verify the entry's tier is embeddable** (Tier 3 or 4):
   ```powershell
   Select-String -Path "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured\shared-inbox.jsonl" `
       -Pattern "your-search-term" -List
   ```
   Check the `tier` field. Tier 1 and 2 are NOT embedded.

5. **If using `memory_wake_up`**, check that you are using enough `max_items`. Too few items may not surface your entry:
   ```powershell
   claude -p "$(cat <<'EOF'
   {"tools":[{"name":"memory_wake_up","input":{"max_items":8,"include_recent_activity":true}}]}
   EOF
   )"
   ```

---

## KG Extraction Failures

**Symptoms**: Entity extraction runs but no KG triples are stored. `knowledge-graph.js` produces errors. No entity relationships appear in retrieval results.

**What to do**:

1. **Check if the KG SQLite database exists and is writable**:
   ```powershell
   $kgPath = Join-Path $env:AI_MEMORY_OBSIDIAN_VAULT "00-System\ai-memory\kg\knowledge-graph.sqlite3"
   Test-Path $kgPath
   ```
   If the file does not exist, the KG initializes automatically on first run. If it exists but is not writable, check file permissions.

2. **Run entity extraction manually** to see errors:
   ```powershell
   node ops/entity-extractor.js extract-file "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured\shared-inbox.jsonl"
   ```
   Look for error output like `TypeError`, `SyntaxError`, or `ENOENT`.

3. **Check the KG schema** is compatible (requires Node.js 22.5+ for built-in `node:sqlite`):
   ```powershell
   node -e "const v = process.version; console.log('Node.js:', v); const hasSqlite = require('node:sqlite') !== undefined; console.log('node:sqlite:', hasSqlite);"
   ```
   If `node:sqlite` is not available, upgrade Node.js to 22.5+ or use the Python fallback.

4. **Verify KG query works**:
   ```powershell
   node ops/knowledge-graph.js stats
   ```
   Expected output shows entity count and triple count.

5. **Check entity extractor output** for your specific content:
   ```powershell
   node ops/entity-extractor.js extract "Alice works on the MemPalace project using Python"
   ```
   This should return extracted entities and facts.

---

## JSONL Corruption

**Symptoms**: `check-memory-integrity.js --strict` reports contract violations. Entries appear duplicated or truncated. Search results have garbled text.

**What to do**:

1. **Validate the memory contract**:
   ```powershell
   node ops/check-memory-integrity.js --strict
   ```
   This checks every JSONL file for parse errors, missing fields, and contract violations.

2. **Find corrupted lines**:
   ```powershell
   $path = "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured\shared-inbox.jsonl"
   $lines = Get-Content $path -Encoding UTF8
   $lineNum = 0
   foreach ($line in $lines) {
       $lineNum++
       try {
           $null = $line | ConvertFrom-Json -AsHashtable
       } catch {
           Write-Host "Corrupted line $lineNum`: $line" -ForegroundColor Red
       }
   }
   ```

3. **Isolate and repair**. If a single line is corrupted, you can either:
   - **Delete the line**: Remove the corrupted JSONL line
   - **Fix the line**: Correct the JSON manually
   - **Backup and rebuild**: Copy the file to `*.jsonl.bak`, then run:
     ```powershell
     powershell -File bus/memory-bus.ps1 -Action SyncAll
     ```
     This rebuilds all structured files from source.

4. **For a full rebuild from source** (nuclear option):
   ```powershell
   # Backup first
   Copy-Item "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured" `
       "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured.bak" -Recurse

   # Force full sync
   powershell -File bus/memory-watchdog.ps1 -Once
   ```

5. **If the embedding index is corrupted**, rebuild it:
   ```powershell
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```

---

## My Search Results Are Empty or Wrong

**Symptoms**: `search_shared_memory` returns zero results, or returns unrelated results.

**What to do**:

1. **Start with BM25-only** (works offline, zero API cost):
   ```powershell
   claude -p "$(cat <<'EOF'
   {"tools":[{"name":"search_shared_memory","input":{"query":"your search terms here","limit":5,"mode":"bm25"}}]}
   EOF
   )"
   ```
   If BM25 returns results but dense doesn't, the issue is with the embedding provider.

2. **Check if there are any records to search**:
   ```powershell
   (Get-Content "$env:AI_MEMORY_OBSIDIAN_VAULT\00-System\ai-memory\structured\shared-inbox.jsonl" -Encoding UTF8 | Measure-Object -Line).Lines
   ```
   Zero records means the sync never ran or failed silently.

3. **Force a full sync and rebuild**:
   ```powershell
   powershell -File bus/memory-bus.ps1 -Action SyncAll
   node $env:AI_MEMORY_ROOT\generate-embeddings.js
   ```

4. **For Chinese text search**, confirm `jieba` is installed:
   ```powershell
   node -e "const jieba = require('jieba'); console.log('jieba loaded:', !!jieba.tokenize);"
   ```
   If this fails, reinstall:
   ```powershell
   & $env:AI_MEMORY_PYTHON -m pip install jieba rank-bm25
   ```

---

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

## Node.js Console Windows Appear On Startup

Cause:
- The shared MCP proxy runs on Windows with console subsystem executables (cmd.exe, npx.cmd, uvx.cmd) that may create visible console windows when spawned through `cmd.exe /c`.
- `windowsHide: true` in Node.js `spawn()` only suppresses the immediate child process window -- grandchild processes can still create their own visible consoles.
- This was especially visible for `playwright-mcp.cmd`, `npx` fallback paths, and any batch-file shim that could not be parsed.

Fix (applied in the latest version):
- The singleton proxy now uses a temp-batch approach for all fallback cmd.exe launches: it writes a temporary `.bat` file and runs `cmd.exe /c batPath` which avoids console window allocation.
- Shim resolution has been expanded to detect three patterns (npm-style shims, exe+script pairs, bare script paths) so more commands bypass cmd.exe entirely.
- If you still see console windows, the relevant log file under `shared-mcp/logs/` will show the actual command being run.

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

## Windows Shows Node Console Windows Or An `Open With` Dialog

Cause:
- an older local install or legacy startup entry may still launch `.js`, `.mjs`, or `.cjs` files directly instead of invoking `node.exe`
- a stale Scheduled Task from older OpenClaw installs may still point to an old path such as `C:\Users\<old-user>\.openclaw\gateway.cmd`

Fix:
- reinstall the runtime so the current hidden-launch shims and proxy bootstrap guards are written to `~/.ai-memory`
- verify the shared stack is healthy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1 -Json
```

- ensure `.mjs` / `.cjs` resolve to `node.exe` for the current user if you have other legacy launchers on the machine:

```powershell
$progId = "AI.Memory.NodeModuleFile"
$nodeExe = "C:\path\to\node.exe"
reg add "HKCU\Software\Classes\$progId\shell\open\command" /ve /d "\"$nodeExe\" \"%1\" %*" /f
reg add "HKCU\Software\Classes\.mjs" /ve /d "$progId" /f
reg add "HKCU\Software\Classes\.cjs" /ve /d "$progId" /f
```

- if a legacy `OpenClaw Gateway` Scheduled Task still exists, remove or disable it from an elevated PowerShell session:

```powershell
schtasks /Delete /TN "OpenClaw Gateway" /F
```

```powershell
Disable-ScheduledTask -TaskName "OpenClaw Gateway"
```

Notes:
- the current `AI Memory Watchdog.vbs` startup entry should launch only hidden PowerShell hosts
- current installs also replace legacy `OpenClaw.lnk` Startup entries with a hidden `OpenClaw.vbs` launcher when `~/.openclaw/start-gateway.ps1` exists
- current installs now treat `OpenClaw Gateway` task actions that still call `\.openclaw\gateway.cmd` as repair-worthy, because the `.cmd` entrypoint itself can still flash a console window even when it points at the current profile
- current installs also try to disable a clearly stale per-user `OpenClaw Gateway` task automatically when it points at a missing `\.openclaw\gateway.cmd`, another profile's path, or a legacy `.cmd` entrypoint; older installs may need one reinstall before that cleanup runs
- when automatic disable hits `Access is denied`, current installs also write `~/.ai-memory/reports/repair-openclaw-gateway.admin.ps1` so one elevated PowerShell run can remove the stale task cleanly
- if Windows still refuses the disable/delete with `Access is denied`, current installs also drop a compatibility shim at the stale `\.openclaw\gateway.cmd` path when possible so the leftover task stops triggering `Open With` prompts for Node/NPM scripts
- if deletion or disable returns `Access is denied`, that specific task still requires an administrator shell even if the rest of the memory bus runs correctly
- on the affected Windows profile, that `Access is denied` case can happen even when the task says `Run As User = wang`; the task file can still be ACL-owned by `Administrators`, so the practical fix is one elevated disable/delete in Task Scheduler or an admin PowerShell session

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
