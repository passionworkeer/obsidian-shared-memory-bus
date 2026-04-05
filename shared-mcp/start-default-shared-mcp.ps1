param(
    [switch]$IncludeMiniMax,
    [switch]$IncludeOptional,
    [switch]$ForceRestart
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$envBasePort = [int]([Environment]::GetEnvironmentVariable("AI_MEMORY_BASE_PORT") ?? "")
$manifestPath = Join-Path $root "manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$manifestBasePort = $manifest.defaults.basePort
$env:AI_MEMORY_BASE_PORT = ($envBasePort -gt 0 ? $envBasePort : $manifestBasePort).ToString()

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

& (Join-Path $root "start-shared-mcp.ps1") -Only $defaultServers -IncludeOptional:$IncludeOptional -ForceRestart:$ForceRestart
