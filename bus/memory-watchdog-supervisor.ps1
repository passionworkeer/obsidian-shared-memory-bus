param(
    [int]$PollSeconds = 5,
    [int]$FreshWindowSeconds = 45
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

$sourceRoot = Split-Path -Parent $PSScriptRoot
$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "bus/runtime-platform.ps1"),
    (Join-Path $sourceRoot "bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

$AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) {
    $env:AI_MEMORY_ROOT
} else {
    $PSScriptRoot
}

$WatchdogScript = Join-Path $AiMemoryRoot "memory-watchdog.ps1"
$WatchdogLockPath = Join-Path $AiMemoryRoot "watchdog.lock"
$WatchdogStatePath = Join-Path $AiMemoryRoot "watchdog-state.json"
$WatchdogVersionPath = Join-Path $AiMemoryRoot "watchdog.version"
$WorkerArguments = @("-Once", "-KeepRunningState")

# Script version — bump this to trigger a supervised restart
$CurrentWatchdogVersion = "4"

function Get-WatchdogWorkerPids {
    if (-not (Test-Path -LiteralPath $WatchdogScript -PathType Leaf)) {
        return @()
    }
    $scriptPath = (Get-Item -LiteralPath $WatchdogScript).FullName.ToLowerInvariant()
    return @(
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
                $lowered = $commandLine.ToLowerInvariant()
                return $lowered.Contains("-file") -and $lowered.Contains($scriptPath)
            } | Select-Object -ExpandProperty ProcessId
    )
}

function Test-WatchdogWorkerRunning {
    return (Get-WatchdogWorkerPids).Count -gt 0
}

function Stop-WatchdogWorker {
    foreach ($pid in (Get-WatchdogWorkerPids)) {
        try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 500
    # Clear stale lock from dead process
    try { Remove-Item -LiteralPath $WatchdogLockPath -Force -ErrorAction SilentlyContinue } catch { }
}

function Get-WatchdogStateAgeSeconds {
    if (-not (Test-Path -LiteralPath $WatchdogStatePath -PathType Leaf)) {
        return [int]::MaxValue
    }

    try {
        return [int][Math]::Max(0, [Math]::Floor(((Get-Date) - (Get-Item -LiteralPath $WatchdogStatePath).LastWriteTime).TotalSeconds))
    } catch {
        return [int]::MaxValue
    }
}

function Start-WatchdogWorker {
    try { Remove-Item -LiteralPath $WatchdogLockPath -Force -ErrorAction SilentlyContinue } catch { }
    # Write version so we know what is running
    [System.IO.File]::WriteAllText($WatchdogVersionPath, $CurrentWatchdogVersion, [System.Text.UTF8Encoding]::new($false))
    Start-SharedBackgroundProcess `
        -FilePath (Resolve-SharedPowerShellExecutable) `
        -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $WatchdogScript -ArgumentList $WorkerArguments) `
        -WorkingDirectory $AiMemoryRoot | Out-Null
}

while ($true) {
    try {
        $needsRestart = $false
        $runningPids = @(Get-WatchdogWorkerPids)

        # Check 1: not running → restart
        if ($runningPids.Count -eq 0) {
            $stateAgeSeconds = Get-WatchdogStateAgeSeconds
            if ($stateAgeSeconds -ge $FreshWindowSeconds) {
                $needsRestart = $true
            }
        }

        # Check 2: version drift → kill + restart
        if ((Test-Path -LiteralPath $WatchdogVersionPath -PathType Leaf) -and $runningPids.Count -gt 0) {
            try {
                $runningVersion = (Get-Content -Raw -LiteralPath $WatchdogVersionPath -Encoding UTF8).Trim()
                if ($runningVersion -cne $CurrentWatchdogVersion) {
                    $needsRestart = $true
                }
            } catch { }
        }

        if ($needsRestart) {
            Stop-WatchdogWorker
            Start-WatchdogWorker
        }
    } catch {
    }

    Start-Sleep -Seconds $PollSeconds
}
