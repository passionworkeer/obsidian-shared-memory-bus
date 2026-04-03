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

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
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
        $backup = "$statePath.corrupt.$(Get-Date -Format 'yyyyMMddHHmmss')"
        try { Move-Item -LiteralPath $statePath -Destination $backup -Force } catch {}
        Write-Warning "[shared-mcp] state.json was corrupt, backed up to $backup"
        return @{}
    }
}

function Write-State {
    param([Parameter(Mandatory = $true)][hashtable]$State)

    Ensure-Directory -Path (Split-Path -Parent $statePath)
    $tempPath = "$statePath.tmp"
    $json = $State | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempPath -Destination $statePath -Force
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
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

        if ($server.PSObject.Properties.Name -contains "port") {
            $portCleared = $false
            for ($attempt = 0; $attempt -lt 10; $attempt++) {
                $remainingListeners = @(Get-SharedListeningProcessIds -Port ([int]$server.port))
                if ($remainingListeners.Count -eq 0) {
                    $portCleared = $true
                    break
                }
                Start-Sleep -Milliseconds 250
            }

            if (-not $portCleared) {
                $remaining[$id] = $record
                $results.Add([pscustomobject]@{
                    id = $id
                    status = "stop-pending"
                    pid = (@(Get-SharedListeningProcessIds -Port ([int]$server.port)) | Select-Object -First 1)
                }) | Out-Null
                continue
            }
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
    Write-State -State $remaining
    $results | ConvertTo-Json -Depth 5
} finally {
    if ($mutexAcquired) {
        try {
            [void]$mutex.ReleaseMutex()
        } catch {
        }
    }
    $mutex.Dispose()
}
