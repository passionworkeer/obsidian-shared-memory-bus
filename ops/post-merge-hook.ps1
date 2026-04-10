#Requires -Version 7
<#
.SYNOPSIS
    post-merge hook — trigger memory rebuild if layers changed + watchdog signal.
    Non-blocking: always exits 0.
.DESCRIPTION
    1. Checks if any structured JSONL files changed
    2. If changed, triggers run-memory-dream.ps1 -Writeback --SkipArchive
    3. Writes watchdog signal file for memory refresh
#>
param()

$ErrorActionPreference = 'SilentlyContinue'

# Resolve workspace root
$WorkspaceRoot = $PSScriptRoot | Split-Path -Parent
if (-not (Test-Path "$WorkspaceRoot\.git")) {
    $candidates = @("$PSScriptRoot","$PSScriptRoot\..","$PSScriptRoot\..\..")
    foreach ($c in $candidates) { if (Test-Path "$c\.git") { $WorkspaceRoot = $c; break } }
}

$vaultRoot = if ($env:AI_MEMORY_OBSIDIAN_VAULT) { $env:AI_MEMORY_OBSIDIAN_VAULT } elseif ($env:OBSIDIAN_VAULT_ROOT) { $env:OBSIDIAN_VAULT_ROOT } else { $null }
if (-not $vaultRoot) { exit 0 }

$structDir = Join-Path $vaultRoot "00-System\ai-memory\structured"
$watchdogSignalDir = Join-Path $vaultRoot "00-System\ai-memory\.watchdog"

# ── Step 1: Detect structured layer changes ─────────────────────────────
# Simple heuristic: check if any JSONL files were modified in the last 60 seconds
$recentChanges = $false
if (Test-Path $structDir) {
    $recentFiles = Get-ChildItem -Path $structDir -Filter "*.jsonl" -ErrorAction SilentlyContinue | Where-Object {
        ($_.LastWriteTimeUtc -gt (Get-Date).AddSeconds(-60).ToUniversalTime())
    }
    if ($recentFiles) { $recentChanges = $true }
}

# ── Step 2: Trigger dream consolidation if layers changed ───────────
if ($recentChanges) {
    $dreamScript = Join-Path $WorkspaceRoot "ops\run-memory-dream.ps1"
    if (Test-Path $dreamScript) {
        # Run as background job (non-blocking)
        $null = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$dreamScript,"-VaultRoot",$vaultRoot,"-Writeback","-SkipArchive" -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
    }
}

# ── Step 3: Write watchdog signal ─────────────────────────────────────
$null = New-Item -ItemType Directory -Force -Path $watchdogSignalDir -ErrorAction SilentlyContinue
$signalFile = Join-Path $watchdogSignalDir "signal-memory-refresh.txt"
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$signalContent = @"
# Written by post-merge hook at $timestamp
MERGE_TS=$timestamp
WORKSPACE=$WorkspaceRoot
"@
$signalContent | Out-File -FilePath $signalFile -Encoding UTF8 -ErrorAction SilentlyContinue

exit 0
