param(
    [string]$TargetRoot = "$env:USERPROFILE\.ai-memory"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $bundleRoot "scripts\install.ps1"

if (Test-Path -LiteralPath (Join-Path $TargetRoot "agents.json")) {
    $backupPath = Join-Path $TargetRoot ("agents.backup-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    Copy-Item -LiteralPath (Join-Path $TargetRoot "agents.json") -Destination $backupPath -Force
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerPath -TargetRoot $TargetRoot -RegisterStartup
Write-Output ("Upgraded shared-memory bus at {0}" -f $TargetRoot)
