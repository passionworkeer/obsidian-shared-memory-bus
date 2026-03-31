param(
    [Parameter(Mandatory = $true)][string]$AgentName,
    [string]$Preset = "generic"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$busRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Join-Path $env:USERPROFILE ".ai-memory" }
$busScript = Join-Path $busRoot "memory-bus.ps1"
if (-not (Test-Path -LiteralPath $busScript)) {
    throw "Shared memory bus not found at $busScript"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $busScript -Action RegisterAgent -AgentName $AgentName -Preset $Preset
