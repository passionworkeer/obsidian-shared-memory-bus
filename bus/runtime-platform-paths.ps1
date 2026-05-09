Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-paths.ps1
# Base path-joining, platform detection, and XDG-style directory resolution.
# No external dependencies.
# ---------------------------------------------------------------------------

function Join-SharedPath {
    param([Parameter(Mandatory = $true)][string[]]$Segments)

    $parts = @($Segments | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) {
        return ""
    }

    $current = [string]$parts[0]
    foreach ($segment in @($parts | Select-Object -Skip 1)) {
        $current = [System.IO.Path]::Combine($current, [string]$segment)
    }

    return $current
}

function Get-SharedPlatformInfo {
    $isWin = $false
    $isMac = $false
    $isLin = $false

    try {
        $runtimeInfo = [System.Runtime.InteropServices.RuntimeInformation]
        $isWin = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
        $isMac = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)
        $isLin = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)
    } catch {
        $platform = [Environment]::OSVersion.Platform
        $isWin = $platform -eq [System.PlatformID]::Win32NT
    }

    [pscustomobject]@{
        IsWindows = [bool]$isWin
        IsMacOS   = [bool]$isMac
        IsLinux   = [bool]$isLin
    }
}

$Script:SharedPlatformInfo = Get-SharedPlatformInfo

function Test-SharedIsWindows {
    return [bool]$Script:SharedPlatformInfo.IsWindows
}

function Test-SharedIsMacOS {
    return [bool]$Script:SharedPlatformInfo.IsMacOS
}

function Test-SharedIsLinux {
    return [bool]$Script:SharedPlatformInfo.IsLinux
}

function Get-SharedUserHome {
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

function Get-SharedConfigHome {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
            return $env:APPDATA
        }
        return (Join-SharedPath @($userHome, "AppData", "Roaming"))
    }
    if (Test-SharedIsMacOS) {
        return Join-SharedPath @($userHome, "Library", "Application Support")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) {
        return $env:XDG_CONFIG_HOME
    }
    return (Join-SharedPath @($userHome, ".config"))
}

function Get-SharedDataHome {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            return $env:LOCALAPPDATA
        }
        return (Join-SharedPath @($userHome, "AppData", "Local"))
    }
    if (Test-SharedIsMacOS) {
        return Join-SharedPath @($userHome, "Library", "Application Support")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_DATA_HOME)) {
        return $env:XDG_DATA_HOME
    }
    return (Join-SharedPath @($userHome, ".local", "share"))
}

function Get-SharedDefaultAiMemoryRoot {
    return (Join-SharedPath @((Get-SharedUserHome), ".ai-memory"))
}
