# ============================================================================
# Watchdog-Tasks.ps1 - Background task orchestration
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Invoke-BackgroundExtraction, Invoke-StructuredRefreshPipeline,
#            Invoke-ArtifactCatchup, Invoke-EmbeddingsRefresh,
#            Get-ExpectedSharedMcpIds, Get-ExpectedSharedMcpPorts,
#            Test-SharedMcpBootstrapRunning, Ensure-SharedMcp
# ============================================================================

function Invoke-BackgroundExtraction {
    param(
        [string]$Reason = "watchdog"
    )

    $script = Join-Path $Global:AiMemoryRoot "scripts/extraction-session-start.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { return }

    Write-WatchdogTrace -Step "extraction.begin" -Data @{ reason = $Reason }

    $null = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 60

    Write-WatchdogTrace -Step "extraction.end" -Data @{ reason = $Reason }
}

function Invoke-StructuredRefreshPipeline {
    param(
        [string]$Reason = "watchdog",
        [switch]$StructuredChanged
    )

    Write-WatchdogTrace -Step "pipeline.begin" -Data @{ reason = $Reason; structuredChanged = [bool]$StructuredChanged }

    Invoke-BuildMemoryLayers -Reason $Reason
    Invoke-BuildHandoffPack -Reason $Reason

    if ($Global:AutoDreamJsonPath) {
        Invoke-MemoryDream -Reason $Reason
    }

    Invoke-RefreshGeneratedArtifacts -Reason $Reason
    Invoke-GenerateHygieneReport -Reason $Reason

    Write-WatchdogTrace -Step "pipeline.end" -Data @{ reason = $Reason }
}

function Invoke-ArtifactCatchup {
    param(
        [string]$Reason = "watchdog"
    )

    Write-WatchdogTrace -Step "catchup.begin" -Data @{ reason = $Reason }

    $lastSyncAt = Invoke-BusSync -Reason $Reason -SkipRefresh -TimeoutSeconds 180

    if (-not $StructuredChanged) {
        Invoke-BuildMemoryLayers -Reason $Reason
        Invoke-RefreshGeneratedArtifacts -Reason $Reason
    }

    Write-WatchdogTrace -Step "catchup.end" -Data @{ reason = $Reason }
    return $lastSyncAt
}

function Invoke-EmbeddingsRefresh {
    param(
        [string]$Reason = "watchdog"
    )

    $script = Join-Path $Global:AiMemoryRoot "scripts/generate-embeddings.ps1"
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Write-WatchdogTrace -Step "embeddings.skipped" -Data @{ reason = "script not found" }
        return
    }

    Write-WatchdogTrace -Step "embeddings.begin" -Data @{ reason = $Reason }

    $null = Invoke-PowerShellFileWithTimeout -FilePath $script -TimeoutSeconds 300

    Write-WatchdogTrace -Step "embeddings.end" -Data @{ reason = $Reason }
}

function Get-ExpectedSharedMcpIds {
    $env:CLAUDE_MCP_SERVER_IDS -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() }
}

function Get-ExpectedSharedMcpPorts {
    $env:CLAUDE_MCP_SERVER_PORTS -split "," | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [int]$_.Trim() }
}

function Test-SharedMcpBootstrapRunning {
    param(
        [string[]]$ExpectedIds = @(),
        [int[]]$ExpectedPorts = @()
    )

    if (-not $Global:SharedMcpStatusScript -or -not (Test-Path -LiteralPath $Global:SharedMcpStatusScript -PathType Leaf)) {
        return $true
    }

    try {
        $result = & $Global:SharedMcpStatusScript 2>&1 | Out-String
        $lines = $result -split "`n" | Where-Object { $_ -match "^\d+:" }
        $runningCount = @($lines).Count

        if ($ExpectedIds.Count -gt 0) {
            return $runningCount -ge $ExpectedIds.Count
        }
        return $runningCount -gt 0
    } catch {
        return $true
    }
}

function Ensure-SharedMcp {
    param(
        [switch]$ForceRestart
    )

    if (-not $Global:SharedMcpStartScript -or -not (Test-Path -LiteralPath $Global:SharedMcpStartScript -PathType Leaf)) {
        Write-WatchdogTrace -Step "sharedmcp.skipped" -Data @{ reason = "script not found" }
        return
    }

    $expectedIds = @(Get-ExpectedSharedMcpIds)
    $expectedPorts = @(Get-ExpectedSharedMcpPorts)
    $isRunning = Test-SharedMcpBootstrapRunning -ExpectedIds $expectedIds -ExpectedPorts $expectedPorts

    if ($isRunning -and -not $ForceRestart) {
        Write-WatchdogTrace -Step "sharedmcp.running"
        return
    }

    Write-WatchdogTrace -Step "sharedmcp.start" -Data @{
        expectedIds = $expectedIds
        forceRestart = [bool]$ForceRestart
    }

    $null = Start-DetachedPowerShellScript -ScriptPath $Global:SharedMcpStartScript -Name "shared-mcp"

    Write-WatchdogTrace -Step "sharedmcp.started"
}
