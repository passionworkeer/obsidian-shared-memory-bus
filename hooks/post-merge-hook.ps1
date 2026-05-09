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

$storeRoot = if ($env:AI_MEMORY_STORE) { $env:AI_MEMORY_STORE } elseif ($env:AI_MEMORY_OBSIDIAN_VAULT) { $env:AI_MEMORY_OBSIDIAN_VAULT } else { $null }
if (-not $storeRoot) { exit 0 }

$structDir = Join-Path $storeRoot "structured"
$watchdogSignalDir = Join-Path $storeRoot ".watchdog"

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
        $null = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$dreamScript,"-StoreRoot",$storeRoot,"-Writeback","-SkipArchive" -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
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
