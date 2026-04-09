param(
    [switch]$IncludeMiniMax,
    [switch]$IncludeOptional,
    [switch]$ForceRestart
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Split-Path -Parent $root
$helperPath = @(
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $root"
}

. $helperPath

$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$envBasePortRaw = [Environment]::GetEnvironmentVariable("AI_MEMORY_BASE_PORT")
$envBasePort = 0
if (-not [string]::IsNullOrWhiteSpace($envBasePortRaw)) {
    $envBasePort = [int]$envBasePortRaw
}
$manifestBasePort = $manifest.defaults.basePort
if ($envBasePort -gt 0) {
    $env:AI_MEMORY_BASE_PORT = $envBasePort.ToString()
} else {
    $env:AI_MEMORY_BASE_PORT = $manifestBasePort.ToString()
}

$bootstrapMutexName = Get-SharedMutexName -BaseName "AiSharedMcpBootstrapV1"
$bootstrapMutex = New-Object System.Threading.Mutex($false, $bootstrapMutexName)
$bootstrapMutexAcquired = $false
try {
    $bootstrapMutexAcquired = $bootstrapMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $bootstrapMutexAcquired = $true
}

if (-not $bootstrapMutexAcquired) {
    [pscustomobject]@{
        id = "shared-mcp"
        status = "bootstrap-already-running"
    } | ConvertTo-Json -Depth 4
    exit 0
}

$defaultServers = @(
    "context7",
    "fetch",
    "time",
    "sequential-thinking",
    "obsidian",
    "memory",
    "playwright"
)

$minimaxApiKey = $env:MINIMAX_API_KEY
if ([string]::IsNullOrWhiteSpace($minimaxApiKey)) {
    $minimaxApiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")
}
if ([string]::IsNullOrWhiteSpace($minimaxApiKey)) {
    $minimaxApiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "Machine")
}

if ($IncludeMiniMax -or -not [string]::IsNullOrWhiteSpace($minimaxApiKey)) {
    $defaultServers += "MiniMax"
}

try {
    & (Join-Path $root "start-shared-mcp.ps1") -Only $defaultServers -IncludeOptional:$IncludeOptional -ForceRestart:$ForceRestart
} finally {
    if ($bootstrapMutexAcquired) {
        try {
            [void]$bootstrapMutex.ReleaseMutex()
        } catch {
        }
    }
    $bootstrapMutex.Dispose()
}
