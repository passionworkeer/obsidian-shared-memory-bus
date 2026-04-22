# ============================================================================
# Watchdog-FileWatch.ps1 - File monitoring and signature functions
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Get-WatchSpecPollSeconds, Write-WatchdogScanHeartbeat,
#            Get-DirectoryWatchStamp, Get-WatchStamp, Get-FileContentHash,
#            Get-StructuredDataSignature, Test-StructuredArtifactsNeedRefresh
# ============================================================================

function Get-WatchSpecPollSeconds {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Spec
    )

    $pollSeconds = $Spec.pollSeconds
    if ($pollSeconds -lt 5) { $pollSeconds = 5 }
    if ($pollSeconds -gt 3600) { $pollSeconds = 3600 }
    return $pollSeconds
}

function Write-WatchdogScanHeartbeat {
    param(
        [string]$ScanName = "scan"
    )

    $heartbeatPath = Join-Path $Global:AiMemoryRoot "watchdog-heartbeat.txt"
    try {
        Ensure-Directory -Path $heartbeatPath
        [System.IO.File]::WriteAllText($heartbeatPath, (Get-Date).ToString("o"), [System.Text.Encoding]::UTF8)
    } catch { }
}

function Get-DirectoryWatchStamp {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [string[]]$IncludeExtensions = @("*.md", "*.json", "*.jsonl"),
        [int]$MaxFiles = 50
    )

    $files = @(Get-ChildItem -LiteralPath $Directory -Include $IncludeExtensions -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First $MaxFiles |
        Sort-Object LastWriteTime -Descending)

    if ($files.Count -eq 0) {
        return "empty-$((Get-Date).ToString('yyyyMMdd'))"
    }

    $totalSize = ($files | Measure-Object -Property Length -Sum).Sum
    $newestTime = $files[0].LastWriteTime.ToString("yyyyMMdd-HHmmss")
    $oldestTime = $files[$files.Count - 1].LastWriteTime.ToString("yyyyMMdd-HHmmss")
    $fileCount = $files.Count

    return "v2-$fileCount-$totalSize-$newestTime-$oldestTime"
}

function Get-WatchStamp {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Spec
    )

    $path = $Spec.path
    if (-not (Test-Path -LiteralPath $path)) {
        return "missing"
    }

    $pathType = if (Test-Path -LiteralPath $path -PathType Container) { "dir" } else { "file" }

    if ($pathType -eq "dir") {
        $extensions = if ($Spec.extensions) { $Spec.extensions } else { @("*.md", "*.json", "*.jsonl") }
        return Get-DirectoryWatchStamp -Directory $path -IncludeExtensions $extensions -MaxFiles ($Spec.maxFiles -or 50)
    }

    try {
        $item = Get-Item -LiteralPath $path
        $size = $item.Length
        $mtime = $item.LastWriteTime.ToString("yyyyMMdd-HHmmss")
        $hash = (Get-FileContentHash -Path $path -Algorithm MD5)
        return "v2-$size-$mtime-$($hash.Hash.Substring(0, 8))"
    } catch {
        return "error-$($_.Exception.Message)"
    }
}

function Get-FileContentHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Algorithm = "MD5"
    )

    try {
        $hash = Get-FileHash -LiteralPath $Path -Algorithm $Algorithm -ErrorAction Stop
        return $hash
    } catch {
        return @{ Hash = "00000000"; Algorithm = $Algorithm }
    }
}

function Get-StructuredDataSignature {
    param(
        [string[]]$WatchSpecNames = @("shared-inbox", "session-memory", "shared-events", "task-memory", "claude-code")
    )

    $global:WatchSpecs = $global:WatchSpecs
    if (-not $global:WatchSpecs) { return "" }

    $signatures = @()
    foreach ($specName in $WatchSpecNames) {
        $spec = $global:WatchSpecs | Where-Object { $_.Name -eq $specName } | Select-Object -First 1
        if ($spec) {
            $stamp = Get-WatchStamp -Spec $spec
            $signatures += "$($specName):$stamp"
        }
    }

    return ($signatures -join "|")
}

function Test-StructuredArtifactsNeedRefresh {
    param(
        [int]$MaxAgeMinutes = 30
    )

    if (-not $Global:MemoryLayersJsonPath) { return $false }
    if (-not (Test-Path -LiteralPath $Global:MemoryLayersJsonPath -PathType Leaf)) { return $true }

    try {
        $age = (Get-Date) - (Get-Item -LiteralPath $Global:MemoryLayersJsonPath).LastWriteTime
        return $age.TotalMinutes -gt $MaxAgeMinutes
    } catch {
        return $true
    }
}
