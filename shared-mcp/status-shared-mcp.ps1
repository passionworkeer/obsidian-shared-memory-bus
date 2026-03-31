Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root "manifest.json"
$statePath = Join-Path $root "state.json"

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
            $url = "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$server.port, $manifest.defaults.path
        }
        if (-not $healthUrl) {
            $healthUrl = "http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$server.port, $manifest.defaults.healthPath
        }
        if (-not $alive) {
            $listenerPid = Get-ListenerProcessId -Port ([int]$server.port)
            if ($listenerPid -gt 0) {
                $procId = $listenerPid
                $alive = $null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue)
            }
        }
        if ($alive -and $healthUrl) {
            $alive = Test-Health -Url $healthUrl
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
