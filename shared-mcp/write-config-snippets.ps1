Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root "manifest.json"
$outputRoot = Join-Path $root "generated"

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

Ensure-Directory -Path $outputRoot
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json

$defaultSharedServers = @($manifest.servers | Where-Object {
    $_.mode -eq "shared" -and [string]$_.id -ne "MiniMax"
})
$optionalSharedServers = @($manifest.servers | Where-Object {
    [string]$_.id -eq "MiniMax" -or $_.mode -eq "optional"
})

function New-CodexSnippet {
    param(
        [string]$Title,
        [object[]]$Servers
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($Title) | Out-Null
    foreach ($server in @($Servers)) {
        $lines.Add("") | Out-Null
        $lines.Add(("[mcp_servers.{0}]" -f $server.id)) | Out-Null
        $lines.Add(('url = "http://{0}:{1}{2}"' -f $manifest.defaults.host, [int]$server.port, $manifest.defaults.path)) | Out-Null
        $lines.Add("startup_timeout_sec = 60") | Out-Null
    }
    return (($lines -join "`n").Trim() + "`n")
}

function New-CursorPayload {
    param([object[]]$Servers)

    $payload = [ordered]@{ mcpServers = [ordered]@{} }
    foreach ($server in @($Servers)) {
        $url = "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$server.port, $manifest.defaults.path
        $payload.mcpServers[[string]$server.id] = [ordered]@{ url = $url }
    }
    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

function New-CopilotPayload {
    param([object[]]$Servers)

    $payload = [ordered]@{ servers = [ordered]@{} }
    foreach ($server in @($Servers)) {
        $url = "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$server.port, $manifest.defaults.path
        $payload.servers[[string]$server.id] = [ordered]@{
            type = "http"
            url = $url
        }
    }
    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

[System.IO.File]::WriteAllText((Join-Path $outputRoot "codex.shared-mcp.toml"), (New-CodexSnippet -Title "# Shared MCP HTTP snippets for Codex (safe default set)" -Servers $defaultSharedServers), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $outputRoot "cursor.shared-mcp.json"), (New-CursorPayload -Servers $defaultSharedServers), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $outputRoot "copilot.shared-mcp.json"), (New-CopilotPayload -Servers $defaultSharedServers), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $outputRoot "codex.shared-mcp.optional.toml"), (New-CodexSnippet -Title "# Optional shared MCP HTTP snippets for Codex (requires secrets or looser isolation)" -Servers $optionalSharedServers), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $outputRoot "cursor.shared-mcp.optional.json"), (New-CursorPayload -Servers $optionalSharedServers), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $outputRoot "copilot.shared-mcp.optional.json"), (New-CopilotPayload -Servers $optionalSharedServers), (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("Generated shared MCP snippets in {0}" -f $outputRoot)
