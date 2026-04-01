param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Get-EnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "User")
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Machine")
    }
    return [string]$value
}

function Resolve-MiniMaxRunner {
    $customCommand = Get-EnvValue -Name "MINIMAX_MCP_COMMAND"
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

$apiKey = Get-EnvValue -Name "MINIMAX_API_KEY"
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "MINIMAX_API_KEY is not set."
}

$apiHost = Get-EnvValue -Name "MINIMAX_API_HOST"
if ([string]::IsNullOrWhiteSpace($apiHost)) {
    $apiHost = "https://api.minimax.chat"
}

$env:MINIMAX_API_KEY = $apiKey
$env:MINIMAX_API_HOST = $apiHost

$runner = Resolve-MiniMaxRunner
if ($runner.kind -eq "shell") {
    & cmd.exe /d /c $runner.path
    exit $LASTEXITCODE
}

& "$($runner.path)"
exit $LASTEXITCODE
