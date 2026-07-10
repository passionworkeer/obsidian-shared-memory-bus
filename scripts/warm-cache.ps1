#!/usr/bin/env pwsh
# warm-cache.ps1 — Manually warm the SQLite search result cache
#
# Usage:
#   .\warm-cache.ps1                      # auto mode: uses recent queries from cache
#   .\warm-cache.ps1 -Mode manual         # manual mode: read {query,route} dicts from stdin
#   .\warm-cache.ps1 -Timeout 60          # override timeout (default: 30s)
#   .\warm-cache.ps1 -MaxQueries 50       # override max queries (default: 20)

param(
    [ValidateSet("auto", "manual")]
    [string]$Mode = "auto",

    [ValidateRange(1, 300)]
    [int]$Timeout = 30,

    [ValidateRange(1, 100)]
    [int]$MaxQueries = 20,

    [string]$CacheDir = $null
)

$ErrorActionPreference = "Stop"

# Resolve store root: env vars → user home default
$storeRoot = $env:AI_MEMORY_STORE
if (-not $storeRoot) { $storeRoot = $env:AI_MEMORY_STORE_ROOT }
if (-not $storeRoot) { $storeRoot = $env:AI_MEMORY_ROOT }
if (-not $storeRoot) {
    $storeRoot = Join-Path $env:USERPROFILE ".ai-memory"
}

$cacheDir = if ($CacheDir) { $CacheDir } else { Join-Path $storeRoot "cache" }

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$pythonExe = if ($env:AI_MEMORY_PYTHON) { $env:AI_MEMORY_PYTHON } else { "python" }
$repoRoot = Split-Path -Parent $scriptRoot
$warmScript = Join-Path $repoRoot "retrieval" "cache" "warm_strategy.py"

if (-not (Test-Path $warmScript)) {
    Write-Error "warm_strategy.py not found at: $warmScript"
    exit 1
}

$pythonArgs = @(
    $warmScript,
    "--mode", $Mode,
    "--timeout", $Timeout,
    "--max-queries", $MaxQueries,
    "--cache-dir", $cacheDir
)

Write-Host "[warm-cache] Starting warm (mode=$Mode, timeout=${Timeout}s, max=${MaxQueries})..." -ForegroundColor Cyan

if ($Mode -eq "manual") {
    $stdinContent = @($input) -join [Environment]::NewLine
    if ([string]::IsNullOrWhiteSpace($stdinContent)) {
        Write-Host "No queries provided via stdin."
        exit 0
    }
    $stdinContent | & $pythonExe @pythonArgs
} else {
    & $pythonExe @pythonArgs
}

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Warning "warm-cache exited with code $exitCode"
    exit $exitCode
}

Write-Host "[warm-cache] Done." -ForegroundColor Green
