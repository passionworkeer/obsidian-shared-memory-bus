# ============================================================================
# memory-watchdog.ps1 - Main watchdog orchestrator
# ============================================================================
# Split into modules for maintainability:
#   - watchdog/Watchdog-Core.ps1      : Core utilities, locking, state
#   - watchdog/Watchdog-Process.ps1    : Process management
#   - watchdog/Watchdog-FileWatch.ps1 : File monitoring, signatures
#   - watchdog/Watchdog-Sync.ps1       : Synchronization business logic
#   - watchdog/Watchdog-Health.ps1     : Health checks, restarts
#   - watchdog/Watchdog-Tasks.ps1      : Background task orchestration
# ============================================================================

param(
    [switch]$Daemon,
    [switch]$Once,
    [switch]$KeepRunningState,
    [int]$PollSeconds = 60,  # 轻量化：默认 60 秒，Daemon 模式下使用
    [int]$StaleMinutes = 5
)

# ============================================================================
# Bootstrap: Environment checks and setup
# ============================================================================

$EventDrivenMode = -not $Daemon -and -not $Once

$watchdogEnabled = [Environment]::GetEnvironmentVariable("AI_MEMORY_WATCHDOG_ENABLED")
if ($null -ne $watchdogEnabled -and $watchdogEnabled -in @("0", "false", "no", "off")) {
    Write-Output "[watchdog] disabled via AI_MEMORY_WATCHDOG_ENABLED=0"
    exit 0
}

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

# --- Register engine event so Release-WatchdogLock fires on ANY exit path ---
$script:WatchdogLockStream = $null
try {
    $null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
        if ($script:WatchdogLockStream) {
            try { $script:WatchdogLockStream.Dispose() } catch { }
        }
        try {
            if ((Test-Path -LiteralPath $LockPath -PathType Leaf)) {
                Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
} catch {
}

# ============================================================================
# Load dependencies
# ============================================================================

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

# ============================================================================
# Load watchdog modules
# ============================================================================

$moduleRoot = Join-Path $PSScriptRoot "watchdog"
$modules = @(
    "Watchdog-Core.ps1",
    "Watchdog-Process.ps1",
    "Watchdog-FileWatch.ps1",
    "Watchdog-Sync.ps1",
    "Watchdog-Health.ps1",
    "Watchdog-Tasks.ps1"
)

foreach ($module in $modules) {
    $modulePath = Join-Path $moduleRoot $module
    if (Test-Path -LiteralPath $modulePath -PathType Leaf) {
        . $modulePath
    }
}

# ============================================================================
# Global constants (used by modules)
# ============================================================================

$UserHome = Get-SharedUserHome
$AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { $PSScriptRoot }
$BusScript = Resolve-BusPath -Candidates @("memory-bus.ps1", "bus/memory-bus.ps1")
$LockPath = Join-Path $AiMemoryRoot "watchdog.lock"
$StatePath = Join-Path $AiMemoryRoot "watchdog-state.json"
$ErrorLogPath = Join-Path $AiMemoryRoot "watchdog-error.log"
$TraceLogPath = Join-Path $AiMemoryRoot "watchdog-trace.log"
$SharedMcpRoot = Join-Path $AiMemoryRoot "shared-mcp"
$SharedMcpStartScript = Join-Path $SharedMcpRoot "start-default-shared-mcp.ps1"
$SharedMcpStatusScript = Join-Path $SharedMcpRoot "status-shared-mcp.ps1"
$VaultRoot = Resolve-SharedStoreRoot -FallbackPath (Join-SharedPath @($UserHome, "Documents", "Obsidian Vault"))
$GeneratedRoot = Join-SharedPath @($VaultRoot, "generated")
$GlobalContextPath = Join-SharedPath @($GeneratedRoot, "GLOBAL-CONTEXT.md")
$MemoryLayersJsonPath = Join-SharedPath @($GeneratedRoot, "MEMORY-LAYERS.json")
$HandoffPackJsonPath = Join-SharedPath @($GeneratedRoot, "HANDOFF.json")
$AutoDreamJsonPath = Join-SharedPath @($GeneratedRoot, "AUTO-DREAM.json")
$StructuredRoot = Join-SharedPath @($VaultRoot, "structured")
$BlackboardDaemonScript = Resolve-BusPath -Candidates @("obsidian-blackboard-daemon.js", "ops/daemon/obsidian-blackboard-daemon.js")
$MD_PATH = Join-Path $VaultRoot "02-KB\WORKING.md"
$OpenClawSyncScript = Resolve-BusPath -Candidates @("sync-openclaw-to-obsidian.js", "ops/sync/sync-openclaw-to-obsidian.js")
# 上方脚本当前未实现 — Resolve-BusPath 会返回 $null,Invoke-OpenClawStructuredSync 会记录 openclaw.skipped 等待脚本落地 (见 docs/PROJECT_AUDIT_*.md §I-HIGH-2)
$BuildHandoffPackScript = Resolve-BusPath -Candidates @("build-handoff-pack.js", "ops/build/build-handoff-pack.js")

# ============================================================================
# Watch specs definition
# ============================================================================

$script:lastHeavySyncAt = Get-Date
$script:lastHeavySyncSignature = ""

$WatchSpecs = @(
    @{ Name = "shared-inbox";       Path = (Join-SharedPath @($StructuredRoot, "shared-inbox.jsonl"));    pollSeconds = 30;  maxFiles = 200; extensions = @("*.jsonl") },
    @{ Name = "session-memory";     Path = (Join-SharedPath @($StructuredRoot, "session-memory.jsonl"));  pollSeconds = 60;  maxFiles = 200; extensions = @("*.jsonl") },
    @{ Name = "shared-events";      Path = (Join-SharedPath @($StructuredRoot, "shared-events.jsonl")); pollSeconds = 120; maxFiles = 100; extensions = @("*.jsonl") },
    @{ Name = "task-memory";        Path = (Join-SharedPath @($StructuredRoot, "task-memory.jsonl"));   pollSeconds = 60;  maxFiles = 100; extensions = @("*.jsonl") },
    @{ Name = "claude-code";        Path = (Join-SharedPath @($StructuredRoot, "claude-code.jsonl"));    pollSeconds = 30;  maxFiles = 200; extensions = @("*.jsonl") },
    @{ Name = "openclaw";           Path = (Join-SharedPath @($StructuredRoot, "openclaw.jsonl"));      pollSeconds = 120; maxFiles = 50;  extensions = @("*.jsonl") },
    @{ Name = "openclaw-blackboard";Path = (Join-SharedPath @($StructuredRoot, "openclaw-blackboard.jsonl")); pollSeconds = 30; maxFiles = 50; extensions = @("*.jsonl") },
    @{ Name = "openclaw-runs";      Path = (Join-SharedPath @($StructuredRoot, "openclaw-runs.jsonl")); pollSeconds = 60;  maxFiles = 100; extensions = @("*.jsonl") },
    @{ Name = "openclaw-jobs";      Path = (Join-SharedPath @($StructuredRoot, "openclaw-jobs.jsonl"));  pollSeconds = 60;  maxFiles = 50;  extensions = @("*.jsonl") },
    @{ Name = "openclaw-journal";   Path = (Join-SharedPath @($StructuredRoot, "openclaw-journal.jsonl")); pollSeconds = 60; maxFiles = 100; extensions = @("*.jsonl") },
    @{ Name = "vault-workspace";    Path = $VaultRoot;                                                pollSeconds = 300; maxFiles = 500; extensions = @("*.md", "*.json", "*.jsonl") },
    @{ Name = "memory-layers";      Path = $MemoryLayersJsonPath;                                    pollSeconds = 300; },
    @{ Name = "handoff-pack";       Path = $HandoffPackJsonPath;                                      pollSeconds = 300; },
    @{ Name = "auto-dream";         Path = $AutoDreamJsonPath;                                        pollSeconds = 600; }
)

$OpenClawWatchSpecNames = @("openclaw", "openclaw-blackboard", "openclaw-runs", "openclaw-jobs", "openclaw-journal")

# ============================================================================
# Main watchdog loop
# ============================================================================

try {
    if (-not (Acquire-WatchdogLock)) {
        Write-Output "[watchdog] failed to acquire lock at $LockPath"
        exit 1
    }

    Write-WatchdogTrace -Step "watchdog.start" -Data @{
        daemon = [bool]$Daemon
        once = [bool]$Once
        pollSeconds = $PollSeconds
        staleMinutes = $StaleMinutes
        aiMemoryRoot = $AiMemoryRoot
    }

    # Bootstrap: ensure initial state
    if (-not $KeepRunningState) {
        Write-State -Running $true -LastReason "watchdog-start" -ChangedSpecs @()
    }

    $structuredSignatureBefore = Get-StructuredDataSignature
    $lastSyncAt = [datetime]::MinValue

    if ($structuredSignatureBefore) {
        $lastSyncAt = Invoke-BusSync -Reason "watchdog-bootstrap"
        if ($lastSyncAt -ne [datetime]::MinValue) {
            $script:lastHeavySyncSignature = Get-StructuredDataSignature
            $script:lastHeavySyncAt = Get-Date
        }
    }

    # One-shot mode: single scan and exit
    if ($Once) {
        Write-WatchdogTrace -Step "watchdog.once.begin"
        $stamps = @{}
        $changed = New-Object System.Collections.Generic.List[string]
        foreach ($spec in $WatchSpecs) {
            $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
        }
        $scanNow = Get-Date
        foreach ($spec in $WatchSpecs) {
            $currentStamp = Get-WatchStamp -Spec $spec
            if ($stamps[$spec.Name] -cne $currentStamp) {
                [void]$changed.Add($spec.Name)
            }
        }
        if ($changed.Count -gt 0) {
            $reason = "watchdog-change:" + ([string]::Join(",", $changed))
            $lastSyncAt = Invoke-BusSync -Reason $reason
            Write-WatchdogTrace -Step "watchdog.once.changed" -Data @{ changed = @($changed.ToArray()) }
        } else {
            Write-WatchdogTrace -Step "watchdog.once.idle"
        }
        Write-State -Running $false -LastReason "watchdog-once" -ChangedSpecs $changed.ToArray() -LastSyncAt $lastSyncAt
        Release-WatchdogLock
        exit 0
    }

    # Daemon mode: continuous monitoring loop
    $stamps = @{}
    foreach ($spec in $WatchSpecs) {
        $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
    }
    $nextStampRefresh = @{}
    foreach ($spec in $WatchSpecs) {
        $nextStampRefresh[$spec.Name] = [datetime]::MinValue
    }
    $claudeMemReason = $null
    $claudeMemHealthy = Test-ClaudeMemWorkerHealthy

    if (-not $claudeMemHealthy) {
        $claudeMemReason = "claude-mem-unhealthy"
    }
    if (-not [string]::IsNullOrWhiteSpace($claudeMemReason)) {
        Write-State -Running $true -LastReason $claudeMemReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
    }

    while ($true) {
        $stamps = @{}
        $nextStampRefresh = @{}
        foreach ($spec in $WatchSpecs) {
            $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
            $nextStampRefresh[$spec.Name] = [datetime]::MinValue
        }
        if (-not [string]::IsNullOrWhiteSpace($claudeMemReason)) {
            Write-State -Running $true -LastReason $claudeMemReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        }
        $changed = New-Object System.Collections.Generic.List[string]
        Write-WatchdogTrace -Step "loop.scan.begin"
        foreach ($spec in $WatchSpecs) {
            $scanNow = Get-Date
            if ($nextStampRefresh.ContainsKey($spec.Name) -and ([datetime]$nextStampRefresh[$spec.Name]) -gt $scanNow) {
                continue
            }

            $currentStamp = Get-WatchStamp -Spec $spec
            $nextStampRefresh[$spec.Name] = $scanNow.AddSeconds((Get-WatchSpecPollSeconds -Spec $spec))
            if ($stamps[$spec.Name] -cne $currentStamp) {
                $stamps[$spec.Name] = $currentStamp
                [void]$changed.Add($spec.Name)
            }
        }
        Write-WatchdogTrace -Step "loop.scan.end" -Data @{ changed = @($changed.ToArray()) }

        $needsStaleRefresh = $false
        if (Test-Path -LiteralPath $GlobalContextPath) {
            $age = (Get-Date) - (Get-Item -LiteralPath $GlobalContextPath).LastWriteTime
            if ($age.TotalMinutes -ge $StaleMinutes) {
                $needsStaleRefresh = $true
            }
        } else {
            $needsStaleRefresh = $true
        }

        if ($changed.Count -gt 0) {
            Write-WatchdogTrace -Step "loop.changed.begin" -Data @{ changed = @($changed.ToArray()) }
            $structuredSignatureBefore = Get-StructuredDataSignature
            $openClawChanged = @($changed | Where-Object { $OpenClawWatchSpecNames -contains $_ }).Count -gt 0
            if ($openClawChanged) {
                Write-WatchdogTrace -Step "loop.changed.openclaw.begin" -Data @{ changed = @($changed.ToArray()) }
                [void](Invoke-OpenClawStructuredSync -Reason ("watchdog-change:" + ([string]::Join(",", $changed))))
                Write-WatchdogTrace -Step "loop.changed.openclaw.end" -Data @{ changed = @($changed.ToArray()) }
            }
            $reason = "watchdog-change:" + ([string]::Join(",", $changed))
            Write-WatchdogTrace -Step "loop.changed.bussync.begin" -Data @{ reason = $reason }
            $lastSyncAt = Invoke-BusSync -Reason $reason
            Write-WatchdogTrace -Step "loop.changed.bussync.end" -Data @{ reason = $reason; lastSyncAt = if ($lastSyncAt -gt [datetime]::MinValue) { $lastSyncAt.ToString("o") } else { $null } }
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged) {
                $script:lastHeavySyncSignature = $structuredSignatureAfter
                $script:lastHeavySyncAt = Get-Date
            }
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Write-WatchdogTrace -Step "loop.changed.refresh.begin" -Data @{ reason = $reason; structuredChanged = [bool]$structuredChanged }
                Invoke-StructuredRefreshPipeline -Reason $reason -StructuredChanged:$structuredChanged
                Write-WatchdogTrace -Step "loop.changed.refresh.end" -Data @{ reason = $reason }
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason ($reason + "-index-check"))
            }
            Write-State -Running $true -LastReason $reason -ChangedSpecs $changed.ToArray() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        if (Test-StructuredArtifactsNeedRefresh) {
            $lastSyncAt = Invoke-ArtifactCatchup -Reason "watchdog-artifact-refresh"
            Write-State -Running $true -LastReason "watchdog-artifact-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        if ($needsStaleRefresh) {
            $structuredSignatureBefore = Get-StructuredDataSignature
            $lastSyncAt = Invoke-BusSync -Reason "watchdog-stale-refresh"
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged) {
                $script:lastHeavySyncSignature = $structuredSignatureAfter
                $script:lastHeavySyncAt = Get-Date
            }
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Invoke-StructuredRefreshPipeline -Reason "watchdog-stale-refresh" -StructuredChanged:$structuredChanged
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason "watchdog-stale-refresh-index-check")
            }
            Write-State -Running $true -LastReason "watchdog-stale-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt

        if (-not $Daemon) {
            break
        }

        Start-Sleep -Seconds $PollSeconds
    }
} catch {
    Write-WatchdogTrace -Step "watchdog.catch" -Data @{
        message = $_.Exception.Message
        type = if ($null -ne $_.Exception) { $_.Exception.GetType().FullName } else { "" }
    }
    Write-WatchdogErrorLog -ErrorRecord $_ -Context "top-level"
    throw
} finally {
    Write-WatchdogTrace -Step "watchdog.finally"
    try {
        if (-not $KeepRunningState) {
            Write-State -Running $false -LastReason "watchdog-exit" -ChangedSpecs @()
        }
    } finally {
        Release-WatchdogLock
    }
}
