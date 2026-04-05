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
$WorkerArguments = @("-Once", "-KeepRunningState")

function Test-WatchdogWorkerRunning {
    if (-not (Test-Path -LiteralPath $WatchdogScript -PathType Leaf)) {
        return $false
    }

    $scriptPath = (Get-Item -LiteralPath $WatchdogScript).FullName.ToLowerInvariant()
    return @(
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) {
                    return $false
                }

                $lowered = $commandLine.ToLowerInvariant()
                return $lowered.Contains("-file") -and $lowered.Contains($scriptPath)
            }
    ).Count -gt 0
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
    if (Test-Path -LiteralPath $WatchdogLockPath -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $WatchdogLockPath -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }

    Start-SharedBackgroundProcess `
        -FilePath (Resolve-SharedPowerShellExecutable) `
        -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $WatchdogScript -ArgumentList $WorkerArguments) `
        -WorkingDirectory $AiMemoryRoot | Out-Null
}

while ($true) {
    try {
        if (-not (Test-WatchdogWorkerRunning)) {
            $stateAgeSeconds = Get-WatchdogStateAgeSeconds
            if ($stateAgeSeconds -ge $FreshWindowSeconds) {
                Start-WatchdogWorker
            }
        }
    } catch {
    }

    Start-Sleep -Seconds $PollSeconds
}
