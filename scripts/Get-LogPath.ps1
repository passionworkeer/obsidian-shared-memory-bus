<#
.SYNOPSIS
    Centralized log path resolution for the ai-memory bus.

.DESCRIPTION
    Standalone helper module (no external dependencies). Dot-source this file
    from any PowerShell script to get consistent log paths under
    ~/.ai-memory/logs/ (or $AI_MEMORY_STORE/logs when the env var is set).

    Priority for the store root:
      1. AI_MEMORY_STORE        (preferred)
      2. AI_MEMORY_STORE_ROOT   (legacy alias)
      3. Platform default       ($env:USERPROFILE\.ai-memory on Windows,
                                  $HOME/.ai-memory on macOS/Linux)

    Exports:
      - Get-LogRoot              Returns the logs directory, creating it if missing.
      - Get-DailyLogPath         Returns a per-day log path (e.g. start-2026-06-18.log).
      - Get-CrashLogPath         Returns a timestamped crash log path.
      - Write-LogEntry           Appends a timestamped line to a daily log.

.EXAMPLE
    . .\scripts\Get-LogPath.ps1
    $logRoot = Get-LogRoot
    $startLog = Get-DailyLogPath -Prefix "start"
    Write-LogEntry -Path $startLog -Message "shared-mcp startup begin"
#>

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Get-LogHome {
    <#
        Returns the user home directory in a cross-platform way.
        Windows: $env:USERPROFILE
        macOS / Linux: $env:HOME
    #>
    foreach ($candidate in @(
        [string]$env:USERPROFILE,
        [string]$env:HOME,
        [Environment]::GetFolderPath("UserProfile")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            return $candidate
        }
    }
    throw "Unable to resolve the current user's home directory."
}

function Get-LogStoreRoot {
    <#
        Returns the .ai-memory store root, honoring env overrides.
        Does NOT throw if the directory is missing — callers (Get-LogRoot)
        create the logs subdirectory on demand.
    #>
    foreach ($envName in @("AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT")) {
        $override = [Environment]::GetEnvironmentVariable($envName)
        if (-not [string]::IsNullOrWhiteSpace($override)) {
            return $override
        }
    }
    return (Join-Path (Get-LogHome) ".ai-memory")
}

function Get-LogRoot {
    <#
        Returns ~/.ai-memory/logs/ (or $AI_MEMORY_STORE/logs/), creating it
        if it does not exist. Always returns an absolute path.
    #>
    $storeRoot = Get-LogStoreRoot
    $logRoot = Join-Path $storeRoot "logs"
    if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $logRoot -Force)
    }
    return $logRoot
}

function Get-DailyLogPath {
    <#
        Returns a per-day log path under the central logs directory.

        -Prefix examples: "install", "start", "runtime".
        -Error switch appends ".err" to produce the stderr variant
        (e.g. start-2026-06-18.log.err).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [switch]$Error
    )

    $logRoot = Get-LogRoot
    $dateStamp = (Get-Date).ToString("yyyy-MM-dd")
    $fileName = if ($Error) {
        "{0}-{1}.log.err" -f $Prefix, $dateStamp
    } else {
        "{0}-{1}.log" -f $Prefix, $dateStamp
    }
    return (Join-Path $logRoot $fileName)
}

function Get-CrashLogPath {
    <#
        Returns a crash log path with a full timestamp (ISO-ish, filesystem-safe).
        Example: crash-2026-06-18T18-30-12.log
    #>
    $logRoot = Get-LogRoot
    $timeStamp = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss")
    return (Join-Path $logRoot ("crash-{0}.log" -f $timeStamp))
}

function Write-LogEntry {
    <#
        Appends a single timestamped line to the given log path.
        Silently ignores write failures so logging never crashes the caller.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Level = "INFO"
    )

    try {
        $parent = Split-Path -Parent $Path
        if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $parent -Force)
        }
        $line = "[{0}] [{1}] {2}" -f (Get-Date).ToString("o"), $Level, $Message
        Add-Content -Path $Path -Value $line -Encoding UTF8
    } catch {
        # Logging must never crash the caller.
    }
}
