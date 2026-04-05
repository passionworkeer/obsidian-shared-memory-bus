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

$targetScript = Join-Path $PSScriptRoot "install-client-integrations.ps1"
if (-not (Test-Path -LiteralPath $targetScript -PathType Leaf)) {
    throw "Compatibility alias target is missing: $targetScript"
}

$forwardParams = @{}
foreach ($entry in $PSBoundParameters.GetEnumerator()) {
    $forwardParams[$entry.Key] = $entry.Value
}

& $targetScript @forwardParams
exit $LASTEXITCODE
