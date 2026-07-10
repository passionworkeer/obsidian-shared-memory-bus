Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-env.ps1
# Environment variable read access.
# Depends on: runtime-platform-paths.ps1 (Test-SharedIsWindows)
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"

function Get-SharedEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return [string]$value
    }

    if (Test-SharedIsWindows) {
        foreach ($scope in @("User", "Machine")) {
            $value = [Environment]::GetEnvironmentVariable($Name, $scope)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                return [string]$value
            }
        }
    }

    return ""
}
