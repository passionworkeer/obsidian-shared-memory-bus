# ============================================================================
# Watchdog-Sync.ps1 - Synchronization business logic
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Invoke-BusSync, Invoke-RefreshGeneratedArtifacts,
#            Get-BlackboardDaemonProcesses, Test-NodeScriptRunning,
#            Ensure-ObsidianBlackboardDaemon, Invoke-OpenClawStructuredSync,
#            Invoke-BuildMemoryLayers, Invoke-BuildHandoffPack,
#            Invoke-GenerateHygieneReport, Invoke-MemoryArchival,
#            Invoke-MemoryDream
# ============================================================================

function Invoke-BusSync {
    param(
        [string]$Reason = "manual",
        [switch]$SkipRefresh,
        [int]$TimeoutSeconds = 300
    )

    Write-WatchdogTrace -Step "bussync.begin" -Data @{ reason = $Reason }

    if (-not (Test-Path -LiteralPath $Global:BusScript -PathType Leaf)) {
        Write-WatchdogTrace -Step "bussync.skipped" -Data @{ reason = "script not found" }
        return [datetime]::MinValue
    }

    $outputPath = Join-Path $Global:AiMemoryRoot "bus-sync-output.json"
    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
    }

    $lastSyncAt = Get-LastKnownSyncAt
    $result = Invoke-PowerShellFileWithTimeout -FilePath $Global:BusScript -TimeoutSeconds $TimeoutSeconds -ArgumentList @(
        "-OutputPath", "`"$outputPath`"",
        "-SyncReason", $Reason
    )

    if ($result -and $result.syncTimestamp) {
        try {
            $lastSyncAt = [datetime]::Parse($result.syncTimestamp)
        } catch {
            $lastSyncAt = Get-Date
        }
    } else {
        $lastSyncAt = Get-Date
    }

    Write-WatchdogTrace -Step "bussync.end" -Data @{
        reason = $Reason
        lastSyncAt = $lastSyncAt.ToString("o")
        timestamp = (Get-Date).ToString("o")
    }

    return $lastSyncAt
}

function Invoke-RefreshGeneratedArtifacts {
    param(
        [string]$Reason = "watchdog-refresh"
    )

    $script = $Global:BuildHandoffPackScript
    if (-not $script -or -not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Write-WatchdogTrace -Step "refresh.skipped" -Data @{ reason = "script not found" }
        return
    }

    Write-WatchdogTrace -Step "refresh.begin" -Data @{ reason = $Reason }

    try {
        $output = Start-NodeProcess -ScriptPath $script -Name "build-handoff-pack" -ArgumentList @($Reason) -WaitForExit -TimeoutSeconds 60
        Write-WatchdogTrace -Step "refresh.end" -Data @{ reason = $Reason; exitCode = $output.ExitCode }
    } catch {
        Write-WatchdogTrace -Step "refresh.error" -Data @{ reason = $Reason; error = $_.Exception.Message }
    }
}

function Get-BlackboardDaemonProcesses {
    return Get-NodeScriptProcesses -ScriptName "obsidian-blackboard-daemon"
}

function Test-NodeScriptRunning {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName
    )

    $pids = Get-NodeScriptProcesses -ScriptName $ScriptName
    return $pids.Count -gt 0
}

function Ensure-ObsidianBlackboardDaemon {
    $daemonScript = $Global:BlackboardDaemonScript
    if (-not $daemonScript -or -not (Test-Path -LiteralPath $daemonScript -PathType Leaf)) {
        Write-WatchdogTrace -Step "blackboard.skipped" -Data @{ reason = "script not found" }
        return
    }

    if (Test-NodeScriptRunning -ScriptName "obsidian-blackboard-daemon") {
        Write-WatchdogTrace -Step "blackboard.running"
        return
    }

    Write-WatchdogTrace -Step "blackboard.start"
    $null = Start-NodeProcess -ScriptPath $daemonScript -Name "obsidian-blackboard-daemon"
}

function Invoke-OpenClawStructuredSync {
    param(
        [string]$Reason = ""
    )

    $script = $Global:OpenClawSyncScript
    if (-not $script -or -not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Write-WatchdogTrace -Step "openclaw.skipped" -Data @{ reason = "script not found" }
        return
    }

    Write-WatchdogTrace -Step "openclaw.begin" -Data @{ reason = $Reason }

    try {
        $output = Start-NodeProcess -ScriptPath $script -Name "sync-openclaw" -ArgumentList @($Reason) -WaitForExit -TimeoutSeconds 60
        Write-WatchdogTrace -Step "openclaw.end" -Data @{ reason = $Reason; exitCode = $output.ExitCode }
    } catch {
        Write-WatchdogTrace -Step "openclaw.error" -Data @{ reason = $Reason; error = $_.Exception.Message }
    }
}

function Invoke-BuildMemoryLayers {
    param(
        [string]$Reason = "watchdog"
    )

    if (-not $Global:MemoryLayersJsonPath) { return }
    $script = Join-Path $Global:AiMemoryRoot "ops/build/build-memory-layers.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "layers.build.begin" -Data @{ reason = $Reason }

    $output = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 120 -ArgumentList @(
        "-OutputPath", "`"$($Global:MemoryLayersJsonPath)`"",
        "-Reason", $Reason
    )

    Write-WatchdogTrace -Step "layers.build.end" -Data @{ reason = $Reason }
}

function Invoke-BuildHandoffPack {
    param(
        [string]$Reason = "watchdog"
    )

    if (-not $Global:HandoffPackJsonPath) { return }
    $script = Join-Path $Global:AiMemoryRoot "ops/build/build-handoff-pack.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "handoff.build.begin" -Data @{ reason = $Reason }

    $output = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 120 -ArgumentList @(
        "-OutputPath", "`"$($Global:HandoffPackJsonPath)`"",
        "-Reason", $Reason
    )

    Write-WatchdogTrace -Step "handoff.build.end" -Data @{ reason = $Reason }
}

function Invoke-GenerateHygieneReport {
    param(
        [string]$Reason = "watchdog"
    )

    $script = Join-Path $Global:AiMemoryRoot "ops/verify/verify-memory-hygiene.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "hygiene.begin" -Data @{ reason = $Reason }

    $null = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 60

    Write-WatchdogTrace -Step "hygiene.end" -Data @{ reason = $Reason }
}

function Invoke-MemoryArchival {
    param(
        [string]$Reason = "watchdog"
    )

    $script = Join-Path $Global:AiMemoryRoot "ops/cleanup/archive-memory.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "archival.begin" -Data @{ reason = $Reason }

    $null = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 180

    Write-WatchdogTrace -Step "archival.end" -Data @{ reason = $Reason }
}

function Invoke-MemoryDream {
    param(
        [string]$Reason = "watchdog"
    )

    $script = Join-Path $Global:AiMemoryRoot "ops/run/run-memory-dream.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "dream.begin" -Data @{ reason = $Reason }

    $output = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 300

    Write-WatchdogTrace -Step "dream.end" -Data @{ reason = $Reason }
}
