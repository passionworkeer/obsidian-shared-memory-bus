param(
    [string[]]$Only
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root "manifest.json"
$statePath = Join-Path $root "state.json"

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

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return @{}
    }

    try {
        $parsed = Get-Content -Raw -LiteralPath $statePath -Encoding utf8 | ConvertFrom-Json
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

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$mutex = New-Object System.Threading.Mutex($false, "Global\WangSharedMcpStateV1")
[void]$mutex.WaitOne()

try {
    $state = Read-State
    $requested = @(Normalize-RequestedIds -Ids $Only)

    $remaining = @{}
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($server in @($manifest.servers)) {
        if ($server.mode -eq "isolated") {
            continue
        }

        $id = [string]$server.id
        $record = $state[$id]
        if ($requested.Count -gt 0 -and $requested -notcontains $id) {
            $remaining[$id] = $record
            continue
        }

        $candidatePids = New-Object System.Collections.Generic.List[int]
        if ($record -and $record.ContainsKey("pid")) {
            $candidatePids.Add([int]$record["pid"]) | Out-Null
        }
        if ($server.PSObject.Properties.Name -contains "port") {
            $listenerPid = Get-ListenerProcessId -Port ([int]$server.port)
            if ($listenerPid -gt 0) {
                $candidatePids.Add($listenerPid) | Out-Null
            }
        }

        $uniquePids = @($candidatePids | Select-Object -Unique | Where-Object { $_ -gt 0 })
        if ($uniquePids.Count -eq 0) {
            $results.Add([pscustomobject]@{
                id = $id
                status = "not-running"
                pid = 0
            }) | Out-Null
            continue
        }

        foreach ($procId in $uniquePids) {
            $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($process) {
                Stop-ProcessTree -ProcessId $procId
            }
            $results.Add([pscustomobject]@{
                id = $id
                status = "stopped"
                pid = $procId
            }) | Out-Null
        }
    }

    foreach ($entry in $state.GetEnumerator()) {
        if ($remaining.ContainsKey($entry.Key)) {
            continue
        }
        if ($requested.Count -eq 0 -or $requested -contains [string]$entry.Key) {
            continue
        }
        $remaining[[string]$entry.Key] = $entry.Value
    }

    $json = $remaining | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $results | ConvertTo-Json -Depth 5
} finally {
    try {
        [void]$mutex.ReleaseMutex()
    } catch {
    }
    $mutex.Dispose()
}
