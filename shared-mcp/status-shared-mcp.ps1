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

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$state = @{}
if (Test-Path -LiteralPath $statePath) {
    try {
        $parsed = Get-Content -Raw -LiteralPath $statePath -Encoding utf8 | ConvertFrom-Json
        foreach ($property in @($parsed.PSObject.Properties)) {
            $entry = @{}
            foreach ($child in @($property.Value.PSObject.Properties)) {
                $entry[$child.Name] = $child.Value
            }
            $state[$property.Name] = $entry
        }
    } catch {
        $state = @{}
    }
}

$results = New-Object System.Collections.Generic.List[object]
foreach ($server in @($manifest.servers)) {
    $id = [string]$server.id
    $record = $state[$id]
    $procId = 0
    $alive = $false

    if ($record -and $record.ContainsKey("pid")) {
        $procId = [int]$record["pid"]
        $alive = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
    }

    $url = if ($record -and $record.ContainsKey("url")) { [string]$record["url"] } else { $null }
    $healthUrl = if ($record -and $record.ContainsKey("healthUrl")) { [string]$record["healthUrl"] } else { $null }
    if ($server.PSObject.Properties.Name -contains "port") {
        if (-not $url) {
            $url = Get-ServerUrl -Server $server
        }
        if (-not $healthUrl) {
            $healthUrl = Get-ServerHealthUrl -Server $server
        }
        if (-not $alive) {
            $listenerPid = Get-SharedListeningProcessId -Port ([int]$server.port)
            if ($listenerPid -gt 0) {
                $procId = $listenerPid
                $alive = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
            }
        }
        if ($alive -and $healthUrl) {
            $alive = Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl
        }
    }

    $results.Add([pscustomobject]@{
        id = $id
        mode = [string]$server.mode
        running = $alive
        pid = $procId
        url = $url
        healthUrl = $healthUrl
        notes = [string]$server.notes
    }) | Out-Null
}

$results | ConvertTo-Json -Depth 6
