# Part of memory-bus.ps1 - extracted for size compliance
# Artifact age detection, source timestamps, and staleness checking

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Get-BusArtifactAgeSeconds {
    if (-not (Test-Path -LiteralPath $Script:GlobalContextPath)) {
        return [double]::PositiveInfinity
    }

    $age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $Script:GlobalContextPath).LastWriteTimeUtc).TotalSeconds
    if ($age -lt 0) {
        return 0.0
    }

    return $age
}

function Get-BusSourceNewestTimestampUtc {
    $newest = [datetime]::MinValue
    $paths = @(
        $Script:CanonicalObsidian,
        $Script:CanonicalMemory,
        $Script:CanonicalWorking,
        $Script:VaultAgents,
        $Script:SharedSkillsGuidePath,
        $Script:AgentRegistryPath
    )

    foreach ($path in @($paths)) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            $stamp = (Get-Item -LiteralPath $path).LastWriteTimeUtc
            if ($stamp -gt $newest) {
                $newest = $stamp
            }
        }
    }

    foreach ($root in @($Script:ImportedRoot, $Script:InboxRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path -LiteralPath $root)) {
            foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
                if ($item.LastWriteTimeUtc -gt $newest) {
                    $newest = $item.LastWriteTimeUtc
                }
            }
        }
    }

    return $newest
}

function Get-OptimizationSourceTimestampString {
    $newest = [datetime]::MinValue
    foreach ($root in @($Script:ImportedRoot, $Script:InboxRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path -LiteralPath $root)) {
            foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
                if ($item.LastWriteTimeUtc -gt $newest) {
                    $newest = $item.LastWriteTimeUtc
                }
            }
        }
    }

    if ($newest -eq [datetime]::MinValue) {
        return (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }

    return $newest.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
}

function Test-BusArtifactsStale {
    param([int]$MaxAgeSeconds = $Script:StaleSyncSeconds)

    if ((Get-BusArtifactAgeSeconds) -ge [double]$MaxAgeSeconds) {
        return $true
    }

    if (-not (Test-Path -LiteralPath $Script:GlobalContextPath)) {
        return $true
    }

    $artifactStamp = (Get-Item -LiteralPath $Script:GlobalContextPath).LastWriteTimeUtc
    $sourceStamp = Get-BusSourceNewestTimestampUtc
    if ($sourceStamp -gt $artifactStamp.AddSeconds(1)) {
        return $true
    }

    return $false
}

function Sync-AllSourcesIfStale {
    param(
        [string]$ProjectPath,
        [int]$MaxAgeSeconds = $Script:StaleSyncSeconds
    )

    if (Test-BusArtifactsStale -MaxAgeSeconds $MaxAgeSeconds) {
        Sync-AllSources -ProjectPath $ProjectPath
        return $true
    }

    return $false
}