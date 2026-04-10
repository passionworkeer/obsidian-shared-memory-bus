# Migration Guide

This guide covers every upgrade path for the obsidian-shared-memory-bus. Read the section that matches your situation before running any upgrade command.

---

## Version Contract

This project uses semantic versioning (semver). The version contract guarantees:

- **Patch** (x.y.Z): Bug fixes, no API changes
- **Minor** (x.Y.z): New features, backward compatible
- **Major** (X.y.z): Breaking changes — this guide documents every migration step

---

## Breaking Changes

### v2.x to v3.0.0

| Change | Impact |
|---|---|
| `memory-bus.ps1` now writes structured JSONL instead of ad-hoc text files | Records from v2 are not automatically readable by v3 tools |
| Embeddings index schema v1 -> v2 | Must run `generate-embeddings` after upgrade |
| MCP server requires Node.js 18+ | Older Node versions are no longer supported |
| Record schema version 1 -> **2** | Existing `.jsonl` records fail validation until rebuilt |
| Memory contract version 1 -> **2** | Generated artifacts (`MEMORY-LAYERS.json`, `HANDOFF.json`, `AUTO-DREAM.json`) carry new `contractVersion` / `recordSchemaVersion` fields |

---

## Before You Migrate

### Prerequisites

- Node.js 18 or later (`node --version`)
- PowerShell 5.1+ (Windows) or PowerShell Core / pwsh (macOS/Linux)
- Python 3.10+ (for shared MCP fetch/time servers; optional otherwise)

### Check Your Current Version

```powershell
# PowerShell
node --version
python --version  # optional
```

```bash
# bash
node --version
python3 --version  # optional
```

### Stop All Running Services

```powershell
# PowerShell — stop the watchdog and all shared MCP listeners
$aiRoot = $env:AI_MEMORY_ROOT  # usually ~/.ai-memory or $env:USERPROFILE\.ai-memory
node "$aiRoot\ops\stop-services.js" 2>$null
# Or kill manually:
Get-Process powershell,pwsh -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*memory-bus*" -or $_.CommandLine -like "*shared-mcp*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
```

```bash
# bash — stop the watchdog and all shared MCP listeners
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
node "$ai_root/ops/stop-services.js" 2>/dev/null ||
    pkill -f "memory-bus\|shared-mcp" 2>/dev/null || true
```

---

## Preserving Memory Data

Back up everything under `structured/` and the vault memory directory before touching anything. Do not skip this step.

```powershell
# PowerShell
$aiRoot = $env:AI_MEMORY_ROOT
$backupDir = Join-Path $env:TEMP "ai-memory-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# Copy structured records
$structuredSrc = Join-Path $aiRoot "structured"
if (Test-Path $structuredSrc) {
    Copy-Item -Path $structuredSrc -Destination (Join-Path $backupDir "structured") -Recurse
}

# Copy generated artifacts (includes memory layers, handoff pack, auto-dream)
$generatedSrc = Join-Path $aiRoot "generated"
if (Test-Path $generatedSrc) {
    Copy-Item -Path $generatedSrc -Destination (Join-Path $backupDir "generated") -Recurse
}

# Copy vault memory notes (if vault is alongside the runtime)
$vaultRoot = node "$aiRoot/ops/resolve-vault-root.js"
$vaultMemSrc = Join-Path $vaultRoot "00-System\ai-memory"
if (Test-Path $vaultMemSrc) {
    Copy-Item -Path $vaultMemSrc -Destination (Join-Path $backupDir "ai-memory") -Recurse
}

Write-Output "Backup written to: $backupDir"
```

```bash
# bash
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
backup_dir="/tmp/ai-memory-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"

# Copy structured records
if [ -d "$ai_root/structured" ]; then
    cp -r "$ai_root/structured" "$backup_dir/structured"
fi

# Copy generated artifacts
if [ -d "$ai_root/generated" ]; then
    cp -r "$ai_root/generated" "$backup_dir/generated"
fi

# Copy vault memory notes
vault_root="$(node "$ai_root/ops/resolve-vault-root.js" 2>/dev/null)"
if [ -n "$vault_root" ] && [ -d "$vault_root/00-System/ai-memory" ]; then
    mkdir -p "$backup_dir/ai-memory"
    cp -r "$vault_root/00-System/ai-memory"/* "$backup_dir/ai-memory/" 2>/dev/null || true
fi

echo "Backup written to: $backup_dir"
```

### What Gets Preserved

| Path | What it contains |
|---|---|
| `structured/*.jsonl` | All structured memory records (session, inbox, events, tasks, etc.) |
| `generated/MEMORY-LAYERS.json` | Derived memory-layer index |
| `generated/HANDOFF.json` | Handoff context pack |
| `generated/AUTO-DREAM.json` | Auto-dream consolidation summaries |
| `00-System/ai-memory/` | Source-of-truth Obsidian notes that feed the structured layer |

---

## Clean Reinstall

### Option A: Guided Installer (Recommended on Windows)

The `scripts/install.ps1` guided installer handles everything in one command: it resolves Python, installs dependencies, registers startup hooks, generates the initial memory layers, and optionally wires up Claude Code / OpenClaw client integrations.

```powershell
# PowerShell — run from the project root
.\scripts\install.ps1 `
    -TargetRoot "$env:USERPROFILE\.ai-memory" `
    -WorkspaceRoot "E:\desktop\Obsidian Vault" `
    -RegisterStartup $true `
    -PersistUserEnvironment $true `
    -InstallPythonDeps $true `
    -ApplyClientIntegrations $true
```

```bash
# bash — on Windows, invoke PowerShell for the installer
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
vault_root="${OBSIDIAN_VAULT:-$HOME/Obsidian Vault}"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/install.ps1 \
    -TargetRoot "$ai_root" \
    -WorkspaceRoot "$vault_root" \
    -RegisterStartup `
    -PersistUserEnvironment `
    -InstallPythonDeps `
    -ApplyClientIntegrations
```

#### Installer Parameter Reference

| Parameter | Default | Effect |
|---|---|---|
| `-TargetRoot` | `~/.ai-memory` | Where the runtime files are installed |
| `-WorkspaceRoot` | *(required)* | Path to your Obsidian vault |
| `-RegisterStartup` | `$true` | Register watchdog/supervisor in Startup (Windows) / LaunchAgents (macOS) / systemd (Linux) |
| `-PersistUserEnvironment` | `$true` | Write `AI_MEMORY_ROOT` to your user environment |
| `-InstallPythonDeps` | `$true` | Install retrieval dependencies (BM25, jieba) and shared-MCP Python packages |
| `-ApplyClientIntegrations` | `$true` | Wire this installation into Claude Code / OpenClaw config files |
| `-DryRun` | *(absent)* | Print what would be done without doing it |
| `-IncludeOptionalClientServers` | `$false` | Also register optional servers (Playwright MCP, MiniMax) |

### Option B: Manual Install

If you prefer to install files by hand, copy the flat runtime bundle to `~/.ai-memory/` and run each step individually.

```powershell
# PowerShell
$aiRoot = "$env:USERPROFILE\.ai-memory"
$bundle = "E:\desktop\obsidian-shared-memory-bus"

# 1. Copy flat runtime files
Copy-Item -Path "$bundle\*.ps1" -Destination $aiRoot -Force
Copy-Item -Path "$bundle\bus\*.ps1" -Destination $aiRoot -Force
Copy-Item -Path "$bundle\ops\*.js" -Destination "$aiRoot\ops" -Force
Copy-Item -Path "$bundle\shared-mcp" -Destination "$aiRoot\shared-mcp" -Recurse -Force

# 2. Install Node dependencies for shared MCP
Push-Location "$aiRoot\shared-mcp"
npm install --omit=dev
Pop-Location

# 3. Install Python dependencies
python -m pip install --user rank-bm25 jieba
python -m pip install --user mcp-server-fetch mcp-server-time

# 4. Generate initial memory layers
& "$aiRoot\memory-bus.ps1" -Action Generate
```

```bash
# bash
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
bundle="/path/to/obsidian-shared-memory-bus"  # adjust

# 1. Copy flat runtime files
mkdir -p "$ai_root/ops" "$ai_root/shared-mcp"
cp "$bundle"/*.ps1 "$ai_root/" 2>/dev/null || true
cp "$bundle"/bus/*.ps1 "$ai_root/" 2>/dev/null || true
cp "$bundle"/ops/*.js "$ai_root/ops/"
cp -r "$bundle"/shared-mcp/* "$ai_root/shared-mcp/

# 2. Install Node dependencies
cd "$ai_root/shared-mcp" && npm install --omit=dev

# 3. Install Python dependencies
python3 -m pip install --user rank-bm25 jieba
python3 -m pip install --user mcp-server-fetch mcp-server-time

# 4. Generate initial memory layers
pwsh -NoProfile -File "$ai_root/memory-bus.ps1" -Action Generate
```

---

## After Reinstall

### Step 1: Rebuild the Embeddings Index

Schema v1 -> v2 requires a fresh embedding pass. Run this from the installed runtime directory.

```powershell
# PowerShell
$aiRoot = $env:AI_MEMORY_ROOT
node "$aiRoot\ops\generate-embeddings.js"
```

```bash
# bash
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
node "$ai_root/ops/generate-embeddings.js"
```

### Step 2: Rebuild Memory Layers

Memory layers are derived summaries that must be refreshed after a schema upgrade.

```powershell
# PowerShell
node "$aiRoot\ops\build-memory-layers.js"
```

```bash
# bash
node "$ai_root/ops/build-memory-layers.js"
```

### Step 3: Verify Memory Contract Integrity

The integrity checker validates every structured record against the current schema and contract versions, flags unknown `scope` values, checks `content_hash` SHA-256 fingerprints, and detects stale generated artifacts.

```powershell
# PowerShell — human-readable output
node "$aiRoot\ops\check-memory-integrity.js"

# PowerShell — structured JSON output
node "$aiRoot\ops\check-memory-integrity.js" --json

# PowerShell — fail the process exit code if anything is wrong
node "$aiRoot\ops\check-memory-integrity.js" --strict
```

```bash
# bash — human-readable output
node "$ai_root/ops/check-memory-integrity.js"

# bash — structured JSON output
node "$ai_root/ops/check-memory-integrity.js" --json

# bash — fail the process exit code if anything is wrong
node "$ai_root/ops/check-memory-integrity.js" --strict
```

A healthy system returns `status: ok`. A warning is returned when generated artifacts are stale (outdated relative to new structured records). An error status means records failed schema validation or the contract version is mismatched.

### Step 4: Start the Watchdog Supervisor (Windows)

On Windows, the supervisor (`memory-watchdog-supervisor.ps1`) continuously monitors the watchdog process and restarts it if it crashes or if the version has drifted. On Unix-like systems, use `systemd --user` or the watchdog's own `-Daemon` flag instead.

```powershell
# PowerShell — start the supervisor (normally auto-started via Startup menu)
$aiRoot = $env:AI_MEMORY_ROOT
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$aiRoot\memory-watchdog-supervisor.ps1"
```

```bash
# bash — start watchdog in daemon mode (systemd handles restarts on Unix)
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
pwsh -NoProfile -File "$ai_root/memory-watchdog.ps1" -Daemon -PollSeconds 15
```

The supervisor polls every **5 seconds** by default (`-PollSeconds`) and restarts the worker if no heartbeat state file has been written in **45 seconds** (`-FreshWindowSeconds`). Both values are configurable.

### Step 5: Verify the Memory Bus Is Running

```powershell
# PowerShell
$aiRoot = $env:AI_MEMORY_ROOT
node "$aiRoot\ops\memory-status.js"
```

```bash
# bash
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
node "$ai_root/ops/memory-status.js"
```

Expected output includes watchdog state, contract version, record schema version, and a summary of structured layers and generated artifacts.

---

## Memory Layers and Generated Artifacts

After reinstall, the following derived files are generated automatically (or via the explicit rebuild steps above):

| Artifact | File | Description |
|---|---|---|
| Memory layers index | `generated/MEMORY-LAYERS.json` | Maps every structured `.jsonl` layer to its record count, latest timestamp, and schema-valid flag |
| Handoff pack | `generated/HANDOFF.json` | Compact bootstrap context: anchors, next steps, blockers, and recent threads |
| Auto dream | `generated/AUTO-DREAM.json` | LLM-consolidated summaries from session/durable/event/task layers |

All three carry `contractVersion` and `recordSchemaVersion` fields. If these do not match the current expected values (`2` for both), the integrity checker flags them as stale.

---

## Structured Record Schema v2

Every record in `structured/*.jsonl` now requires these fields:

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `2` (integer) | Record schema version — must be `2` |
| `id` | string | Unique record identifier (UUID recommended) |
| `tool` | string | Tool that produced this record |
| `type` | string | Semantic type label (e.g. `observation`, `decision`, `task`) |
| `title` | string | Short human-readable title |
| `source` | string | Origin identifier (e.g. `claude-code`, `openclaw`) |
| `scope` | string | One of the allowed scope values (see below) |
| `memory_level` | string | One of `durable`, `session`, `event`, `task` |

### Allowed Scope Values

| Scope | Description |
|---|---|
| `user` | User-provided facts, preferences, and long-term context |
| `feedback` | Explicit user corrections and signals |
| `project` | Per-project working context |
| `reference` | Documentation, docs, and reference material |
| `summary` | Derived consolidation summaries |
| `task` | Per-task state and outcome |
| `run` | Per-run (agent invocation) observations |

Records with an unknown `scope` value are flagged by `check-memory-integrity.js` but are not silently accepted — they appear in the `issues` list under `unknown-scope`.

---

## Inbox Deduplication

New records written to `structured/shared-inbox.jsonl` are deduplicated against existing records by `id`. Additionally, records arriving within **30 seconds** of each other with identical `tool` + `scope` + `content_hash` are treated as duplicates (the newer entry is dropped). This prevents burst writes (e.g. from rapid tool calls during startup) from creating duplicate records.

To force a record through the deduplication gate, give it a unique `id` — UUIDs are the recommended approach.

---

## Upgrading from v1.x Records

If you have legacy `.jsonl` files from v1 (schema version 1 or missing the required v2 fields), migrate them before or after reinstall:

```powershell
# PowerShell — preview which records would be flagged
$aiRoot = $env:AI_MEMORY_ROOT
node "$aiRoot\ops\check-memory-integrity.js" --json |
    ConvertFrom-Json |
    Select-Object -ExpandProperty structuredLayers |
    ForEach-Object { $_ | ConvertTo-Json -Depth 3 }
```

```bash
# bash — preview which records would be flagged
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
node "$ai_root/ops/check-memory-integrity.js" --json | \
    python3 -c "import json,sys; d=json.load(sys.stdin); [print(k, v) for k,v in d.get('structuredLayers',{}).items()]"
```

To upgrade legacy records in place, use `ops/migrate-records.js` if present, or filter and rewrite the `.jsonl` files:

```powershell
# PowerShell — rewrite legacy records with a v2 header
$aiRoot = $env:AI_MEMORY_ROOT
$legacyFile = Join-Path $aiRoot "structured\session-memory.jsonl"
$tmp = [System.IO.Path]::GetTempFileName()
Get-Content $legacyFile | ForEach-Object {
    $rec = $_ | ConvertFrom-Json
    # Add missing v2 fields
    $rec.schemaVersion = 2
    if (-not $rec.id) { $rec.id = [guid]::NewGuid().ToString() }
    if (-not $rec.memory_level) { $rec.memory_level = "session" }
    $rec | ConvertTo-Json -Compress
} | Set-Content $tmp -Encoding UTF8
Move-Item $tmp $legacyFile -Force
```

```bash
# bash — rewrite legacy records with a v2 header
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
legacy_file="$ai_root/structured/session-memory.jsonl"
tmp=$(mktemp)
< "$legacy_file" python3 -c "
import sys, json, uuid
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    rec = json.loads(line)
    rec['schemaVersion'] = 2
    if 'id' not in rec or not rec['id']:
        rec['id'] = str(uuid.uuid4())
    if 'memory_level' not in rec or not rec['memory_level']:
        rec['memory_level'] = 'session'
    print(json.dumps(rec, separators=(',',':')))
" > "$tmp" && mv "$tmp" "$legacy_file"
```

After migration, re-run the integrity checker and rebuild the embeddings index.

---

## Verifying Your Installation

```powershell
# PowerShell
node "$env:AI_MEMORY_ROOT\ops\memory-status.js"
```

```bash
# bash
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
node "$ai_root/ops/memory-status.js"
```

A passing installation shows:

- `watchdog_state`: running (with PID)
- `contract_version`: `2`
- `record_schema_version`: `2`
- `structuredLayers`: all expected files exist with record counts
- `generatedArtifacts`: `MEMORY-LAYERS.json`, `HANDOFF.json`, `AUTO-DREAM.json` all present and aligned

If you see `contract_version: 1` or `record_schema_version: 1`, the system is still running v1 code — re-run the install and verify the `ops/memory-contract.js` file has been updated to `MEMORY_INTEGRITY_CONTRACT_VERSION = 2` and `MEMORY_RECORD_SCHEMA_VERSION = 2`.

---

## Rollback

If the upgrade fails or the integrity checker reports persistent errors:

1. Stop all services (see "Stop All Running Services" above)
2. Restore the backup created in "Preserving Memory Data"
3. Re-run `install.ps1` with `--DryRun` to compare what changed
4. Restore structured records and generated artifacts from the backup

```powershell
# PowerShell — restore from backup
$backupDir = "E:\tmp\ai-memory-backup-YYYYMMDD-HHMMSS"  # your actual backup path
$aiRoot = $env:AI_MEMORY_ROOT
Copy-Item -Path "$backupDir\structured" -Destination $aiRoot -Recurse -Force
Copy-Item -Path "$backupDir\generated" -Destination $aiRoot -Recurse -Force
```

```bash
# bash — restore from backup
backup_dir="/tmp/ai-memory-backup-YYYYMMDD-HHMMSS"  # your actual backup path
ai_root="${AI_MEMORY_ROOT:-$HOME/.ai-memory}"
cp -r "$backup_dir/structured" "$ai_root/"
cp -r "$backup_dir/generated" "$ai_root/"
```
