param(
    [string[]]$Only,
    [switch]$Json,
    [switch]$Human
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
$statePath = Join-Path $root "state.json"
$stateMutexName = Get-SharedMutexName -BaseName "AiMcpStateV1"

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return @{}
    }

    try {
        $content = Get-Content -Raw -LiteralPath $statePath -Encoding utf8
        $parsed = $content | ConvertFrom-Json
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
        return @{}
    }
}

function Test-Health {
    param([string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Test-McpInitialize {
    param([string]$Url)

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
                roots = @{ listChanged = $true }
                sampling = @{}
            }
            clientInfo = @{
                name = "shared-mcp-health"
                version = "1.0.0"
            }
        }
    } | ConvertTo-Json -Depth 8 -Compress

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -TimeoutSec 3 -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body $payload -UseBasicParsing
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
        [string]$HealthUrl
    )

    $probeType = if ($Server.PSObject.Properties.Name -contains "probeType") {
        [string]$Server.probeType
    } else {
        "http-get"
    }

    switch ($probeType) {
        "mcp-initialize" {
            return Test-McpInitialize -Url $Url
        }
        default {
            return Test-Health -Url $HealthUrl
        }
    }
}

function Get-Uptime {
    param([string]$StartedAt)

    if ([string]::IsNullOrWhiteSpace($StartedAt)) {
        return "unknown"
    }

    try {
        $start = [DateTime]::Parse($StartedAt)
        $elapsed = (Get-Date) - $start
        if ($elapsed.TotalSeconds -lt 0) {
            return "unknown"
        }
        if ($elapsed.TotalDays -ge 1) {
            return "{0}d {1}h" -f [int]$elapsed.TotalDays, [int]($elapsed.Hours)
        }
        if ($elapsed.TotalHours -ge 1) {
            return "{0}h {1}m" -f [int]$elapsed.TotalHours, [int]$elapsed.Minutes
        }
        return "{0}m {1}s" -f [int]$elapsed.TotalMinutes, [int]$elapsed.Seconds
    } catch {
        return "unknown"
    }
}

# ANSI colour codes — compatible with Windows Terminal, modern shells.
$ESC = [char]27
$CLR_RESET   = "${ESC}[0m"
$CLR_RED     = "${ESC}[91m"
$CLR_GREEN   = "${ESC}[92m"
$CLR_YELLOW  = "${ESC}[93m"
$CLR_DIM     = "${ESC}[2m"
$CLR_HEADER  = "${ESC}[1m"   # bold header
$CLR_BOLD    = "${ESC}[1m"

# Normalise a $WhatIf-style boolean to a human label.
function Get-ProbedStatus {
    param(
        [bool]$Alive,
        [bool]$Healthy,
        [string]$RecordedStatus
    )

    if ($RecordedStatus -eq "dead") {
        return "dead", $CLR_RED
    }
    if (-not $Alive) {
        return "pid-dead", $CLR_RED
    }
    if ($Healthy) {
        return "healthy", $CLR_GREEN
    }
    return "unhealthy", $CLR_YELLOW
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$state = @{}

if (Test-Path -LiteralPath $statePath) {
    $mutex = New-Object System.Threading.Mutex($false, $stateMutexName)
    $mutexAcquired = $false
    try {
        [void]$mutex.WaitOne()
        $mutexAcquired = $true
    } catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    try {
        $state = Read-State
    } finally {
        if ($mutexAcquired) {
            try { [void]$mutex.ReleaseMutex() } catch { }
        }
        $mutex.Dispose()
    }
}

$requested = @($Only | ForEach-Object { ([string]$_).Split(",").Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$rows = New-Object System.Collections.Generic.List[object]
$allHealthy = $true

foreach ($server in @($manifest.servers)) {
    if ($server.mode -eq "isolated") {
        continue
    }

    $id = [string]$server.id
    if ($requested.Count -gt 0 -and $requested -notcontains $id) {
        continue
    }

    $record    = $state[$id]
    $port      = if ($server.PSObject.Properties.Name -contains "port") { [int]$server.port } else { 0 }
    $url       = $null
    $healthUrl = $null

    if ($port -gt 0) {
        if ($record -and $record.ContainsKey("url")) {
            $url = [string]$record["url"]
        }
        if (-not $url) {
            $url = Get-ServerUrl -Server $server
        }
        if ($record -and $record.ContainsKey("healthUrl")) {
            $healthUrl = [string]$record["healthUrl"]
        }
        if (-not $healthUrl) {
            $healthUrl = Get-ServerHealthUrl -Server $server
        }
    }

    # Probe by PID first, then by port.
    $procId  = 0
    $alive   = $false
    $healthy = $false

    if ($record -and $record.ContainsKey("pid")) {
        $procId = [int]$record["pid"]
        $alive  = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
    }

    if ($port -gt 0) {
        $listenerPid = Get-SharedListeningProcessId -Port $port
        if ($listenerPid -gt 0) {
            $procId = $listenerPid
            $alive  = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
        } elseif ($procId -eq 0) {
            $procId  = 0
            $alive   = $false
        }
    }

    if ($alive -and $url) {
        $healthy = Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl
    }

    $recordedStatus = if ($record -and $record.ContainsKey("status")) { [string]$record["status"] } else { $null }
    $startedAt      = if ($record -and $record.ContainsKey("startedAt")) { [string]$record["startedAt"] } else { $null }
    $uptime         = Get-Uptime -StartedAt $startedAt

    $statusLabel = if ($port -eq 0 -or $procId -eq 0) {
        "not-running"
    } else {
        $s = if (-not $alive) {
            if ($recordedStatus -eq "dead") { "dead" } else { "pid-dead" }
        } elseif ($healthy) {
            "healthy"
        } else {
            "unhealthy"
        }
        $s
    }

    $statusColor = if ($statusLabel -eq "healthy") {
        $CLR_GREEN
    } elseif ($statusLabel -eq "dead" -or $statusLabel -eq "pid-dead") {
        $CLR_RED
    } elseif ($statusLabel -eq "unhealthy") {
        $CLR_YELLOW
    } else {
        $CLR_DIM
    }

    if ($statusLabel -ne "healthy") {
        $allHealthy = $false
    }

    $rows.Add([pscustomobject]@{
        Server = $id
        Mode   = [string]$server.mode
        Port   = if ($port -gt 0) { [string]$port } else { "-" }
        PID    = if ($procId -gt 0) { [string]$procId } else { "-" }
        Status = $statusLabel
        Uptime = if ($statusLabel -eq "healthy") { $uptime } else { "-" }
        Running = [bool]($statusLabel -ne "not-running" -and $statusLabel -ne "pid-dead" -and $statusLabel -ne "dead")
        Healthy = [bool]$healthy
        Url = $url
        HealthUrl = $healthUrl
        StartedAt = $startedAt
        Notes = if ($record -and $record.ContainsKey("notes")) { [string]$record["notes"] } else { [string]$server.notes }
        _color = $statusColor
        _recStatus = $recordedStatus
    }) | Out-Null
}

if ($Json) {
    @($rows | ForEach-Object {
            [pscustomobject]@{
                id = $_.Server
                mode = $_.Mode
                port = if ($_.Port -ne "-") { [int]$_.Port } else { $null }
                pid = if ($_.PID -ne "-") { [int]$_.PID } else { $null }
                status = $_.Status
                running = [bool]$_.Running
                healthy = [bool]$_.Healthy
                uptime = if ($_.Uptime -ne "-") { $_.Uptime } else { "" }
                url = $_.Url
                healthUrl = $_.HealthUrl
                startedAt = $_.StartedAt
                notes = $_.Notes
            }
        }) | ConvertTo-Json -Depth 6

    if ($allHealthy) {
        exit 0
    } else {
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Human-readable output
# ---------------------------------------------------------------------------
if ($Human) {
    Write-Output ""

    $serviceLabels = @{
        "context7" = "Context7"
        "fetch" = "Fetch"
        "time" = "Time"
        "sequential-thinking" = "Sequential Thinking"
        "obsidian" = "Obsidian MCP"
        "memory" = "Memory Bus"
        "MiniMax" = "MiniMax (optional)"
        "playwright" = "Playwright (optional)"
    }

    foreach ($row in $rows) {
        $label = if ($serviceLabels[$row.Server]) { $serviceLabels[$row.Server] } else { $row.Server }
        $port = if ($row.Port -ne "-") { $row.Port } else { $null }
        $pid = if ($row.PID -ne "-") { $row.PID } else { $null }

        if ($row.Status -eq "healthy") {
            $pidText = if ($pid) { " (PID $pid)" } else { "" }
            Write-Output "${CLR_GREEN}${label}:${CLR_RESET} running$pidText"
        } elseif ($row.Status -eq "not-running") {
            if ($row.Mode -eq "optional") {
                Write-Output "${CLR_YELLOW}${label}:${CLR_RESET} not configured (optional)${CLR_RESET}"
            } else {
                Write-Output "${CLR_YELLOW}${label}:${CLR_RESET} not running${CLR_RESET}"
            }
        } elseif ($row.Status -eq "dead" -or $row.Status -eq "pid-dead") {
            Write-Output "${CLR_RED}${label}:${CLR_RESET} dead${CLR_RESET}"
        } else {
            Write-Output "${CLR_YELLOW}${label}:${CLR_RESET} unhealthy${CLR_RESET}"
        }
    }

    Write-Output ""
    if ($allHealthy) {
        Write-Output "${CLR_GREEN}All services healthy${CLR_RESET}"
    } else {
        $unhealthyCount = @($rows | Where-Object { $_.Status -ne "healthy" }).Count
        Write-Output "${CLR_YELLOW}${unhealthyCount} service(s) need attention${CLR_RESET}"
    }
    Write-Output ""

    if ($allHealthy) {
        exit 0
    } else {
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Print formatted table
# ---------------------------------------------------------------------------
$colServer = 15
$colPort   = 6
$colPid    = 8
$colStatus = 12
$colUptime = 14

$sep = "+" + ("-" * ($colServer + 2)) + "+" + ("-" * ($colPort + 2)) + "+" + ("-" * ($colPid + 2)) + "+" + ("-" * ($colStatus + 2)) + "+" + ("-" * ($colUptime + 2)) + "+"

Write-Output ""
Write-Output "${CLR_BOLD}Shared MCP Status${CLR_RESET}"
Write-Output $sep
Write-Output ("${CLR_BOLD}| {0,-$colServer} | {1,-$colPort} | {2,-$colPid} | {3,-$colStatus} | {4,-$colUptime} |${CLR_RESET}" -f "Server", "Port", "PID", "Status", "Uptime")
Write-Output $sep

if ($rows.Count -eq 0) {
    Write-Output "${CLR_DIM}| ${CLR_RESET}${"No servers found",-($colServer)}${CLR_RESET} |${CLR_DIM}${"-" * ($colPort)}${CLR_RESET} |${CLR_DIM}${"-" * ($colPid)}${CLR_RESET} |${CLR_DIM}${"-" * ($colStatus)}${CLR_RESET} |${CLR_DIM}${"-" * ($colUptime)}${CLR_RESET} |"
} else {
    foreach ($row in $rows) {
        $server   = $row.Server.PadRight($colServer)
        $port     = $row.Port.PadLeft($colPort)
        $pidText  = $row.PID.PadLeft($colPid)
        $status   = $row.Status.PadRight($colStatus)
        $uptime   = $row.Uptime.PadRight($colUptime)
        $color    = $row._color

        Write-Output "${color}| ${server} | ${port} | ${pidText} | ${status} | ${uptime} |${CLR_RESET}"
    }
}

Write-Output $sep

$summary = if ($allHealthy) {
    "${CLR_GREEN}All servers healthy${CLR_RESET}"
} else {
    $unhealthyCount = @($rows | Where-Object { $_.Status -ne "healthy" }).Count
    "${CLR_YELLOW}${unhealthyCount} server(s) not healthy — see table above${CLR_RESET}"
}
Write-Output "  $summary"
Write-Output ""

if ($allHealthy) {
    exit 0
} else {
    exit 1
}
