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

$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "../bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

$scriptPath = @(
    (Join-Path $PSScriptRoot "install-client-integrations.ps1"),
    (Join-Path $PSScriptRoot "../ops/install-client-integrations.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $scriptPath) {
    throw "install-client-integrations.ps1 was not found next to verify-integrations.ps1"
}

$argumentList = @()
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $argumentList += @("-WorkspaceRoot", $WorkspaceRoot) }
if (-not [string]::IsNullOrWhiteSpace($AiMemoryRoot)) { $argumentList += @("-AiMemoryRoot", $AiMemoryRoot) }
foreach ($client in @($Clients)) { $argumentList += @("-Clients", $client) }
if ($IncludeOptionalServers) { $argumentList += "-IncludeOptionalServers" }
if ($SkipPlaywright) { $argumentList += "-SkipPlaywright" }
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) { $argumentList += @("-ReportPath", $ReportPath) }
if ($SkipGenerate) { $argumentList += "-SkipGenerate" }
if ($SkipSkillSync) { $argumentList += "-SkipSkillSync" }
if ($SkipWorkspaceOverlays) { $argumentList += "-SkipWorkspaceOverlays" }
if ($Quiet) { $argumentList += "-Quiet" }

Invoke-SharedPowerShellFile -ScriptPath $scriptPath -ArgumentList $argumentList
