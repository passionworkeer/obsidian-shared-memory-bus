# ============================================================================
# Watchdog-Health.ps1 - Health checks and restart logic
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Test-ClaudeMemWorkerHealthy, Invoke-ClaudeMemWorkerRestart,
#            Invoke-ClaudeMemHealthCheck
# ============================================================================

function Test-ClaudeMemWorkerHealthy {
    param(
        [int]$MaxAgeMinutes = 10
    )

    $heartbeatPath = Join-Path $Global:AiMemoryRoot "claude-mem-heartbeat.txt"
    if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) {
        Write-WatchdogTrace -Step "health.heartbeat.missing"
        return $false
    }

    try {
        $content = Get-Content -LiteralPath $heartbeatPath -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($content)) {
            return $false
        }
        $timestamp = [datetime]::Parse($content.Trim())
        $age = (Get-Date) - $timestamp
        if ($age.TotalMinutes -gt $MaxAgeMinutes) {
            Write-WatchdogTrace -Step "health.heartbeat.stale" -Data @{ ageMinutes = [int]$age.TotalMinutes }
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Invoke-ClaudeMemWorkerRestart {
    param(
        [string]$Reason = "health-check-failed"
    )

    $script = Join-Path $Global:AiMemoryRoot "ops/run/run-claude-mem-worker.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Write-WatchdogTrace -Step "claude.restart.skipped" -Data @{ reason = "script not found" }
        return
    }

    $existingPids = Get-NodeScriptProcesses -ScriptName "claude-mem-worker"
    foreach ($pid in $existingPids) {
        try {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        } catch { }
    }

    Write-WatchdogTrace -Step "claude.restart.begin" -Data @{ reason = $Reason }

    $null = Start-DetachedPowerShellScript -ScriptPath $script -Name "claude-mem-worker-restart"

    Write-WatchdogTrace -Step "claude.restart.end" -Data @{ reason = $Reason }
}

function Invoke-ClaudeMemHealthCheck {
    param(
        [switch]$AutoRestart
    )

    $healthy = Test-ClaudeMemWorkerHealthy -MaxAgeMinutes 5
    if ($healthy) {
        Write-WatchdogTrace -Step "health.ok"
        return
    }

    Write-WatchdogTrace -Step "health.failed"
    if ($AutoRestart) {
        Invoke-ClaudeMemWorkerRestart -Reason "health-check"
    }
}
