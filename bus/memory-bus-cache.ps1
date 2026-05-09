# Part of memory-bus.ps1 - extracted for size compliance
# Cache access, bus-wide locking, and profiling utilities

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Get-CacheEntry {
    param([Parameter(Mandatory = $true)][string]$Name)

    $path = Join-Path $Script:CacheRoot "$Name.json"
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $path -Encoding utf8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Set-CacheEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][object]$Value
    )

    Ensure-Directory -Path $Script:CacheRoot
    Write-Json -Path (Join-Path $Script:CacheRoot "$Name.json") -Value $Value
}

function With-BusLock {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [int]$TimeoutMs = $Script:BusLockTimeoutMs
    )

    $mutex = New-Object System.Threading.Mutex($false, "Global\AiMemoryBusV1")
    try {
        $lockAcquired = $false
        try {
            $lockAcquired = $mutex.WaitOne($TimeoutMs)
        } catch [System.Threading.AbandonedMutexException] {
            $lockAcquired = $true
        }

        if (-not $lockAcquired) {
            $msg = "Timed out waiting for AI memory bus lock after " + [int]($TimeoutMs / 1000) + "s. " +
                   "Another process is likely running SyncAll or Initialize. Wait for it to complete."
            Write-Error $msg
            throw "WATCHDOG_LOCK_FAILED: $msg"
        }

        & $ScriptBlock
    } finally {
        if ($lockAcquired) {
            try {
                [void]$mutex.ReleaseMutex()
            } catch {
            }
        }
        $mutex.Dispose()
    }
}

function Invoke-ProfiledStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock
    )

    if (-not $Script:ProfileSync) {
        & $ScriptBlock
        return
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $ScriptBlock
    } finally {
        $sw.Stop()
        [Console]::Error.WriteLine(("AI_MEMORY_PROFILE {0}: {1:N3}s" -f $Name, $sw.Elapsed.TotalSeconds))
    }
}