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

function Get-EffectiveServerPort {
    param($Server)

    if ($null -eq $Server -or -not ($Server.PSObject.Properties.Name -contains "port")) {
        return 0
    }

    $configuredPort = [int]$Server.port
    if ($configuredPort -le 0) {
        return 0
    }

    $manifestBasePort = [int]$manifest.defaults.basePort
    if ($manifestBasePort -le 0) {
        return $configuredPort
    }

    $envBasePort = 0
    $envBasePortRaw = [Environment]::GetEnvironmentVariable("AI_MEMORY_BASE_PORT")
    if (-not [string]::IsNullOrWhiteSpace($envBasePortRaw)) {
        $envBasePort = [int]$envBasePortRaw
    }

    if ($envBasePort -le 0 -or $envBasePort -eq $manifestBasePort) {
        return $configuredPort
    }

    return [int]($envBasePort + ($configuredPort - $manifestBasePort))
}

function Get-ServerUrl {
    param($Server)

    return "http://{0}:{1}{2}" -f $manifest.defaults.host, (Get-EffectiveServerPort -Server $Server), $manifest.defaults.path
}

$defaultSharedServers = @($manifest.servers | Where-Object {
    $_.mode -eq "shared" -or [string]$_.id -eq "playwright"
})
$optionalSharedServers = @($manifest.servers | Where-Object {
    [string]$_.id -eq "MiniMax"
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
        $lines.Add(('url = "{0}"' -f (Get-ServerUrl -Server $server))) | Out-Null
        $lines.Add("startup_timeout_sec = 60") | Out-Null
    }
    return (($lines -join "`n").Trim() + "`n")
}

function New-CursorPayload {
    param([object[]]$Servers)

    $payload = [ordered]@{ mcpServers = [ordered]@{} }
    foreach ($server in @($Servers)) {
        $url = Get-ServerUrl -Server $server
        $payload.mcpServers[[string]$server.id] = [ordered]@{ url = $url }
    }
    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

function New-CopilotPayload {
    param([object[]]$Servers)

    $payload = [ordered]@{ servers = [ordered]@{} }
    foreach ($server in @($Servers)) {
        $url = Get-ServerUrl -Server $server
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
