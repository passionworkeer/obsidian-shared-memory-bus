<#
.SYNOPSIS
    Detects the current PowerShell version and prints a recommendation.

.DESCRIPTION
    PowerShell 7+ (pwsh) is the recommended runtime for the ai-memory bus
    startup chain. Windows PowerShell 5.1 (the OS-bundled default) is
    compatible but has limitations:
      - No ternary operator
      - No null-coalescing operator
      - Slower .NET interop (.NET Framework vs .NET Core)
      - Some cmdlet parameter differences (e.g. ConvertFrom-Json -Depth)

    Exit codes: 0 = recommended (PS 7+); 1 = compatible but limited;
    2 = unsupported.

.EXAMPLE
    .\scripts\check-ps-version.ps1
#>

[CmdletBinding()]
param()

$version = $PSVersionTable.PSVersion
$edition = $PSVersionTable.PSEdition
$major = [int]$version.Major

$pwshAvailable = $false
$pwshSource = ""
try {
    $pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($null -ne $pwshCommand -and -not [string]::IsNullOrWhiteSpace([string]$pwshCommand.Source)) {
        $pwshAvailable = $true
        $pwshSource = [string]$pwshCommand.Source
    }
} catch {
}

Write-Host ""
Write-Host "=== PowerShell Runtime Check ==="
Write-Host "Current version : $version"
Write-Host "Edition         : $edition"
Write-Host "OS              : $($PSVersionTable.OS)"
Write-Host "Platform        : $($PSVersionTable.Platform)"
Write-Host ""

if ($major -ge 7) {
    Write-Host "[OK] PowerShell $major is the recommended runtime." -ForegroundColor Green
    Write-Host "     All ai-memory bus features are fully supported."
    Write-Host ""
    exit 0
}

if ($major -eq 5 -or $major -eq 6) {
    if ($major -eq 5) {
        Write-Host "[WARN] Windows PowerShell 5.1 is compatible but has limitations." -ForegroundColor Yellow
    } else {
        Write-Host "[WARN] PowerShell 6 is end-of-life; upgrade to PowerShell 7+." -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Known limitations on this version:"
    Write-Host "  - Slower startup (.NET Framework vs .NET Core)"
    Write-Host "  - Some cmdlet parameters may differ (ConvertFrom-Json -Depth, etc.)"
    Write-Host "  - No ternary / null-coalescing operators"
    Write-Host ""

    if ($pwshAvailable) {
        Write-Host "[TIP] PowerShell 7 (pwsh) is installed on this machine." -ForegroundColor Cyan
        Write-Host "      Re-run with:  pwsh -File scripts\check-ps-version.ps1" -ForegroundColor Cyan
        Write-Host "      Or set AI_MEMORY_PWSH so the bus uses pwsh:"
        Write-Host "        [Environment]::SetEnvironmentVariable('AI_MEMORY_PWSH', '$pwshSource', 'User')"
    } else {
        Write-Host "[TIP] Install PowerShell 7 for the best experience:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Option A - winget (Windows 10 1709+):"
        Write-Host "    winget install Microsoft.PowerShell"
        Write-Host ""
        Write-Host "  Option B - MSI installer:"
        Write-Host "    https://github.com/PowerShell/PowerShell/releases/latest"
        Write-Host ""
        Write-Host "  Option C - Microsoft Store:"
        Write-Host "    Search for 'PowerShell' in the Microsoft Store app."
        Write-Host ""
        Write-Host "  After install, set AI_MEMORY_PWSH:"
        Write-Host "    [Environment]::SetEnvironmentVariable('AI_MEMORY_PWSH', 'pwsh', 'User')"
    }
    Write-Host ""
    exit 1
}

Write-Host "[ERROR] PowerShell $major is not supported. Use PowerShell 5.1 or 7+." -ForegroundColor Red
Write-Host ""
exit 2