param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $PSScriptRoot
$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

function Resolve-MiniMaxRunner {
    $customCommand = Get-SharedEnvValue -Name "MINIMAX_MCP_COMMAND"
    if (-not [string]::IsNullOrWhiteSpace($customCommand)) {
        return @{
            kind = "shell"
            path = $customCommand
        }
    }

    foreach ($candidate in @("minimax-coding-plan-mcp.exe", "minimax-coding-plan-mcp")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return @{
                kind = "command"
                path = $command.Source
            }
        }
    }

    throw "MiniMax MCP executable was not found. Install minimax-coding-plan-mcp or set MINIMAX_MCP_COMMAND."
}

$apiKey = Get-SharedEnvValue -Name "MINIMAX_API_KEY"
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "MINIMAX_API_KEY is not set."
}

$apiHost = Get-SharedEnvValue -Name "MINIMAX_API_HOST"
if ([string]::IsNullOrWhiteSpace($apiHost)) {
    $apiHost = "https://api.minimax.chat"
}

$env:MINIMAX_API_KEY = $apiKey
$env:MINIMAX_API_HOST = $apiHost

$runner = Resolve-MiniMaxRunner
if ($runner.kind -eq "shell") {
    Invoke-SharedShellCommand -Command $runner.path
    exit $LASTEXITCODE
}

& "$($runner.path)"
exit $LASTEXITCODE
