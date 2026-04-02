param(
    [string]$TargetRoot = ""
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $bundleRoot (Join-Path "scripts" "install.ps1")
$platformHelperPath = Join-Path $bundleRoot (Join-Path "bus" "runtime-platform.ps1")
. $platformHelperPath

if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    $TargetRoot = Get-SharedDefaultAiMemoryRoot
}

if (Test-Path -LiteralPath (Join-Path $TargetRoot "agents.json")) {
    $backupPath = Join-Path $TargetRoot ("agents.backup-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    Copy-Item -LiteralPath (Join-Path $TargetRoot "agents.json") -Destination $backupPath -Force
}

Invoke-SharedPowerShellFile -ScriptPath $installerPath -ArgumentList @("-TargetRoot", $TargetRoot, "-RegisterStartup", "true")
Write-Output ("Upgraded shared-memory bus at {0}" -f $TargetRoot)
