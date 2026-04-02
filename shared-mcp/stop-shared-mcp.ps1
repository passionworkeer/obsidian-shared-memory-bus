param(
    [string[]]$Only
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
$stateMutexName = Get-SharedMutexName -BaseName "WangSharedMcpStateV1"

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

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
$mutex = New-Object System.Threading.Mutex($false, $stateMutexName)
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
            foreach ($listenerPid in @(Get-SharedListeningProcessIds -Port ([int]$server.port))) {
                if ([int]$listenerPid -gt 0) {
                    $candidatePids.Add([int]$listenerPid) | Out-Null
                }
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
            if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
                Stop-SharedProcessTree -ProcessId $procId
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
