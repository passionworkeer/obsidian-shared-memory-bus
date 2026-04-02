param(
    [Parameter(Mandatory = $true)][string]$AgentName,
    [string]$Preset = "generic"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

$busRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Get-SharedDefaultAiMemoryRoot }
$busScript = Join-SharedPath @($busRoot, "memory-bus.ps1")
if (-not (Test-Path -LiteralPath $busScript)) {
    throw "Shared memory bus not found at $busScript"
}

Invoke-SharedPowerShellFile -ScriptPath $busScript -ArgumentList @(
    "-Action", "RegisterAgent",
    "-AgentName", $AgentName,
    "-Preset", $Preset
)
