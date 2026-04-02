param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = "",
    [string[]]$Clients = @(),
    [switch]$IncludeOptionalServers,
    [switch]$SkipPlaywright,
    [string]$ReportPath = "",
    [switch]$SkipGenerate,
    [switch]$SkipSkillSync,
    [switch]$SkipWorkspaceOverlays,
    [switch]$Quiet
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$helperPath = Join-Path (Split-Path -Parent $PSScriptRoot) "bus\runtime-platform.ps1"
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "ops\install-client-integrations.ps1"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Unable to locate ops/install-client-integrations.ps1 from $PSScriptRoot"
}

$argumentList = @()
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $argumentList += @("-WorkspaceRoot", $WorkspaceRoot) }
if (-not [string]::IsNullOrWhiteSpace($AiMemoryRoot)) { $argumentList += @("-AiMemoryRoot", $AiMemoryRoot) }
if (@($Clients).Count -gt 0) { $argumentList += @("-Clients") + @($Clients) }
if ($IncludeOptionalServers) { $argumentList += "-IncludeOptionalServers" }
if ($SkipPlaywright) { $argumentList += "-SkipPlaywright" }
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) { $argumentList += @("-ReportPath", $ReportPath) }
if ($SkipGenerate) { $argumentList += "-SkipGenerate" }
if ($SkipSkillSync) { $argumentList += "-SkipSkillSync" }
if ($SkipWorkspaceOverlays) { $argumentList += "-SkipWorkspaceOverlays" }
if ($Quiet) { $argumentList += "-Quiet" }

Invoke-SharedPowerShellFile -ScriptPath $scriptPath -ArgumentList $argumentList
