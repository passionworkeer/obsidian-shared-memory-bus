param(
    [string[]]$Only,
    [switch]$IncludeOptional,
    [switch]$ForceRestart
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root "manifest.json"
$statePath = Join-Path $root "state.json"
$logRoot = Join-Path $root "logs"
$proxyScriptPath = Join-Path $root "singleton-stdio-mcp-proxy.mjs"

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return @{}
    }

    try {
        $content = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8
        $parsed = [System.Text.Json.JsonSerializer]::Parse($content)
        $map = @{}
        foreach ($property in @($parsed.PSObject.Properties)) {
            $entry = @{}
            foreach ($child in @($property.Value.PSObject.Properties)) {
                $entry[$child.Name] = $child.Value
            }
            $map[$property.Name] = $entry
        }
        return $map
    } catch {
        # Backup corrupted state and return empty so the script starts fresh
        # instead of silently skipping servers and allowing duplicate MCP servers
        $backup = "$statePath.corrupt.$(Get-Date -Format 'yyyyMMddHHmmss')"
        try { Move-Item -LiteralPath $statePath -Destination $backup -Force } catch {}
        Write-Warning "[shared-mcp] state.json was corrupt, backed up to $backup"
        return @{}
    }
}

function Write-State {
    param([Parameter(Mandatory = $true)][hashtable]$State)
    # Atomic write: write to temp file first, then rename.
    # Prevents corruption if the script crashes mid-write.
    $tempPath = "$statePath.tmp"
    $json = $State | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempPath -Destination $statePath -Force
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) {
        return $false
    }

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return
    }

    try {
        $null = cmd.exe /d /c "taskkill /PID $ProcessId /T /F" 2>$null
    } catch {
        try {
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Normalize-RequestedIds {
    param([string[]]$Ids)

    $normalized = New-Object System.Collections.Generic.List[string]
    foreach ($raw in @($Ids)) {
        if ($null -eq $raw) {
            continue
        }
        foreach ($part in ([string]$raw).Split(",")) {
            $clean = $part.Trim()
            if (-not [string]::IsNullOrWhiteSpace($clean)) {
                $normalized.Add($clean) | Out-Null
            }
        }
    }

    return @($normalized | Select-Object -Unique)
}

function Get-ListenerProcessId {
    param([int]$Port)

    if ($Port -le 0) {
        return 0
    }

    try {
        $tcp = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
        if ($tcp -and $tcp.OwningProcess) {
            return [int]$tcp.OwningProcess
        }
    } catch {
    }

    try {
        $pattern = ":{0}\s+.*LISTENING\s+(\d+)\s*$" -f $Port
        $line = netstat -ano -p tcp | Select-String -Pattern $pattern | Select-Object -First 1
        if ($line -and ([string]$line.Line -match "LISTENING\s+(\d+)\s*$")) {
            return [int]$Matches[1]
        }
    } catch {
    }

    return 0
}

function Test-Health {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 5
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

# MCP protocol version: "2024-11-05"
# Hardcoded in 3 places: manifest.json, start-shared-mcp.ps1 (here + line ~400), singleton-stdio-mcp-proxy.mjs.
# Must update all 4 files together when the MCP protocol version changes.
function Test-McpInitialize {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 5
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    $payload = @{
        jsonrpc = "2.0"
        id = "health-check"
        method = "initialize"
        params = @{
            protocolVersion = "2024-11-05"
            capabilities = @{
                roots = @{
                    listChanged = $true
                }
                sampling = @{}
            }
            clientInfo = @{
                name = "shared-mcp-health"
                version = "1.0.0"
            }
        }
    } | ConvertTo-Json -Depth 8 -Compress

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body $payload -UseBasicParsing
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Get-ServerUrl {
    param($Server)

    $path = if ($Server.PSObject.Properties.Name -contains "path" -and -not [string]::IsNullOrWhiteSpace([string]$Server.path)) {
        [string]$Server.path
    } else {
        [string]$manifest.defaults.path
    }

    return "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$Server.port, $path
}

function Get-ServerHealthUrl {
    param($Server)

    $path = if ($Server.PSObject.Properties.Name -contains "healthPath" -and -not [string]::IsNullOrWhiteSpace([string]$Server.healthPath)) {
        [string]$Server.healthPath
    } else {
        [string]$manifest.defaults.healthPath
    }

    return "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$Server.port, $path
}

function Test-ServerReady {
    param(
        $Server,
        [string]$Url,
        [string]$HealthUrl,
        [int]$TimeoutSeconds = 5
    )

    $probeType = if ($Server.PSObject.Properties.Name -contains "probeType") {
        [string]$Server.probeType
    } else {
        "http-get"
    }

    switch ($probeType) {
        "mcp-initialize" {
            return Test-McpInitialize -Url $Url -TimeoutSeconds $TimeoutSeconds
        }
        default {
            return Test-Health -Url $HealthUrl -TimeoutSeconds $TimeoutSeconds
        }
    }
}

function Resolve-StdioCommand {
    param($Server)

    $resolved = [string]$Server.stdioCommand
    return $resolved
}

function Resolve-StdioEnvironment {
    param($Server)

    $envMap = @{}
    if ([string]$Server.id -eq "MiniMax") {
        $apiHost = $env:MINIMAX_API_HOST
        if ([string]::IsNullOrWhiteSpace($apiHost)) {
            $apiHost = [Environment]::GetEnvironmentVariable("MINIMAX_API_HOST", "User")
        }
        if ([string]::IsNullOrWhiteSpace($apiHost)) {
            $apiHost = [Environment]::GetEnvironmentVariable("MINIMAX_API_HOST", "Machine")
        }

        $apiKey = $env:MINIMAX_API_KEY
        if ([string]::IsNullOrWhiteSpace($apiKey)) {
            $apiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")
        }
        if ([string]::IsNullOrWhiteSpace($apiKey)) {
            $apiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "Machine")
        }

        if (-not [string]::IsNullOrWhiteSpace($apiHost)) {
            $envMap["MINIMAX_API_HOST"] = $apiHost
        }
        if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
            $envMap["MINIMAX_API_KEY"] = $apiKey
        }
    }

    return $envMap
}

function Resolve-NodeExecutable {
    foreach ($candidate in @("node.exe", "node")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "Unable to find node.exe in PATH."
}

function Start-ManagedHttpProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][string]$StderrPath
    )

    return Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/s", "/c", $Command) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutPath `
        -RedirectStandardError $StderrPath `
        -PassThru
}

Ensure-Directory -Path $logRoot
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$nodeExecutable = Resolve-NodeExecutable
$mutex = New-Object System.Threading.Mutex($false, "Global\WangSharedMcpStateV1")
[void]$mutex.WaitOne()

try {
    $state = Read-State

    $requested = @(Normalize-RequestedIds -Ids $Only)

    $results = New-Object System.Collections.Generic.List[object]

    foreach ($server in @($manifest.servers)) {
        if ($server.mode -eq "isolated") {
            continue
        }
        $isExplicitlyRequested = $requested.Count -gt 0 -and $requested -contains [string]$server.id
        if ($server.mode -eq "optional" -and -not $IncludeOptional -and -not $isExplicitlyRequested) {
            continue
        }
        if ($requested.Count -gt 0 -and -not $isExplicitlyRequested) {
            continue
        }

        $port = [int]$server.port
        $url = Get-ServerUrl -Server $server
        $healthUrl = Get-ServerHealthUrl -Server $server
        $existing = $state[[string]$server.id]
        $existingPid = 0
        if ($existing -and $existing.ContainsKey("pid")) {
            $existingPid = [int]$existing["pid"]
        }

        $listenerPid = Get-ListenerProcessId -Port $port

        if ($ForceRestart) {
            foreach ($pidToStop in @($existingPid, $listenerPid) | Select-Object -Unique) {
                if ([int]$pidToStop -gt 0) {
                    Stop-ProcessTree -ProcessId ([int]$pidToStop)
                }
            }
            Start-Sleep -Milliseconds 750
            $listenerPid = Get-ListenerProcessId -Port $port
        }

        if ($existing -and -not $ForceRestart) {
            if ((Test-ProcessAlive -ProcessId $existingPid) -and (Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl)) {
                $results.Add([pscustomobject]@{
                    id = [string]$server.id
                    status = "already-running"
                    pid = $existingPid
                    url = $url
                }) | Out-Null
                continue
            }
        }

        if ($listenerPid -gt 0 -and (Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl)) {
            $state[[string]$server.id] = @{
                id = [string]$server.id
                pid = $listenerPid
                port = $port
                url = $url
                healthUrl = $healthUrl
                stdoutPath = if ($existing) { [string]$existing["stdoutPath"] } else { $null }
                stderrPath = if ($existing) { [string]$existing["stderrPath"] } else { $null }
                startedAt = if ($existing -and $existing.ContainsKey("startedAt")) { [string]$existing["startedAt"] } else { (Get-Date).ToString("o") }
                mode = [string]$server.mode
                notes = [string]$server.notes
            }
            $results.Add([pscustomobject]@{
                id = [string]$server.id
                status = "adopted"
                pid = $listenerPid
                url = $url
            }) | Out-Null
            continue
        }

        $stdoutPath = Join-Path $logRoot ("{0}.out.log" -f $server.id)
        $stderrPath = Join-Path $logRoot ("{0}.err.log" -f $server.id)
        $process = $null

        if ($server.PSObject.Properties.Name -contains "launchCommand" -and -not [string]::IsNullOrWhiteSpace([string]$server.launchCommand)) {
            $process = Start-ManagedHttpProcess -Command ([string]$server.launchCommand) -StdoutPath $stdoutPath -StderrPath $stderrPath
        } else {
            $resolvedCommand = Resolve-StdioCommand -Server $server
            $resolvedEnv = Resolve-StdioEnvironment -Server $server
            if ([string]$server.id -eq "MiniMax" -and (-not $resolvedEnv.ContainsKey("MINIMAX_API_HOST") -or -not $resolvedEnv.ContainsKey("MINIMAX_API_KEY"))) {
                $results.Add([pscustomobject]@{
                    id = [string]$server.id
                    status = "skipped"
                    reason = "Set MINIMAX_API_HOST and MINIMAX_API_KEY in your user or machine environment before starting this server."
                }) | Out-Null
                continue
            }

            $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($resolvedCommand))
            $encodedEnv = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((($resolvedEnv | ConvertTo-Json -Compress).Trim())))
            # MCP protocol version — see comment above Test-McpInitialize for the full list of hardcoded locations.
            $argumentList = @(
                $proxyScriptPath,
                "--server-id", [string]$server.id,
                "--port", [string]$port,
                "--path", [string]$manifest.defaults.path,
                "--health-path", [string]$manifest.defaults.healthPath,
                "--protocol-version", "2024-11-05",
                "--stdio-command-b64", $encodedCommand,
                "--env-json-b64", $encodedEnv
            )

            $process = Start-Process -FilePath $nodeExecutable `
                -ArgumentList $argumentList `
                -WindowStyle Hidden `
                -RedirectStandardOutput $stdoutPath `
                -RedirectStandardError $stderrPath `
                -PassThru
        }

        $healthy = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Seconds 1
            if (Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl -TimeoutSeconds 3) {
                $healthy = $true
                break
            }
        }

        $listenerPid = Get-ListenerProcessId -Port $port
        $recordPid = if ($listenerPid -gt 0) { $listenerPid } else { $process.Id }

        $state[[string]$server.id] = @{
            id = [string]$server.id
            pid = $recordPid
            port = $port
            url = $url
            healthUrl = $healthUrl
            stdoutPath = $stdoutPath
            stderrPath = $stderrPath
            startedAt = (Get-Date).ToString("o")
            mode = [string]$server.mode
            notes = [string]$server.notes
        }

        $results.Add([pscustomobject]@{
            id = [string]$server.id
            status = if ($healthy) { "started" } else { "started-unhealthy" }
            pid = $recordPid
            url = $url
            stdoutPath = $stdoutPath
            stderrPath = $stderrPath
        }) | Out-Null
    }

    Write-State -State $state
    $results | ConvertTo-Json -Depth 6
} finally {
    try {
        [void]$mutex.ReleaseMutex()
    } catch {
    }
    $mutex.Dispose()
}
