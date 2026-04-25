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

# Resolve AI_MEMORY_STORE
$storeRoot = $env:AI_MEMORY_STORE
if (-not $storeRoot) {
    $storeRoot = $env:AI_MEMORY_STORE_ROOT
}
if (-not $storeRoot) {
    $storeRoot = "E:\desktop\.ai-memory"
}

$cacheDir = if ($CacheDir) { $CacheDir } else { Join-Path $storeRoot "cache" }

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$pythonExe = "python"
$warmScript = Join-Path $scriptRoot "retrieval\cache\warm-strategy.py"

if (-not (Test-Path $warmScript)) {
    Write-Error "warm-strategy.py not found at: $warmScript"
    exit 1
}

$pythonCmd = @(
    $pythonExe,
    $warmScript,
    "--mode", $Mode,
    "--timeout", $Timeout,
    "--max-queries", $MaxQueries
)

if ($CacheDir) {
    $pythonCmd += "--cache-dir", $CacheDir
}

Write-Host "[warm-cache] Starting warm (mode=$Mode, timeout=${Timeout}s, max=${MaxQueries})..." -ForegroundColor Cyan

if ($Mode -eq "manual") {
    # Read JSON objects from stdin, pass through pipeline
    $pythonCmd | Invoke-Expression
} else {
    & $pythonExe $warmScript --mode $Mode --timeout $Timeout --max-queries $MaxQueries
}

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Warning "warm-cache exited with code $exitCode"
    exit $exitCode
}

Write-Host "[warm-cache] Done." -ForegroundColor Green