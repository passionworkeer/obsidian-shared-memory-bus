Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-vault.ps1
# Obsidian vault path resolution.
# Depends on: runtime-platform-paths.ps1, runtime-platform-env.ps1
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"
. "$PSScriptRoot\runtime-platform-env.ps1"

function Get-SharedObsidianConfigCandidates {
    $configHome = Get-SharedConfigHome
    return @(
        (Join-SharedPath @($configHome, "obsidian", "obsidian.json"))
    ) | Select-Object -Unique
}

function Get-SharedDefaultObsidianVaultCandidates {
    $userHome = Get-SharedUserHome
    return @(
        (Join-SharedPath @($userHome, "Obsidian Vault")),
        (Join-SharedPath @($userHome, "Documents", "Obsidian Vault")),
        (Join-SharedPath @($userHome, "Desktop", "Obsidian Vault"))
    ) | Select-Object -Unique
}

function Resolve-SharedObsidianVaultRoot {
    param(
        [AllowEmptyString()][string]$FallbackPath = "",
        [switch]$ThrowIfMissing
    )

    foreach ($overridePath in @(
        (Get-SharedEnvValue -Name "AI_MEMORY_OBSIDIAN_VAULT"),
        (Get-SharedEnvValue -Name "OBSIDIAN_VAULT_ROOT")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    foreach ($obsidianConfigPath in @(Get-SharedObsidianConfigCandidates)) {
        if (-not (Test-Path -LiteralPath $obsidianConfigPath -PathType Leaf)) {
            continue
        }

        try {
            $config = Get-Content -Raw -LiteralPath $obsidianConfigPath -Encoding utf8 | ConvertFrom-Json
            $records = New-Object System.Collections.Generic.List[object]
            if ($config.vaults) {
                foreach ($property in $config.vaults.PSObject.Properties) {
                    $vault = $property.Value
                    $path = [string]$vault.path
                    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) {
                        continue
                    }

                    $records.Add([pscustomobject]@{
                        path = (Get-Item -LiteralPath $path).FullName
                        open = [bool]$vault.open
                        ts   = if ($null -ne $vault.ts) { [int64]$vault.ts } else { 0 }
                    }) | Out-Null
                }
            }

            $openVault = @($records | Where-Object { $_.open } | Sort-Object ts -Descending | Select-Object -First 1)
            if ($openVault.Count -gt 0) {
                return $openVault[0].path
            }

            $recentVault = @($records | Sort-Object ts -Descending | Select-Object -First 1)
            if ($recentVault.Count -gt 0) {
                return $recentVault[0].path
            }
        } catch {
        }
    }

    foreach ($candidate in (@($FallbackPath) + @(Get-SharedDefaultObsidianVaultCandidates))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    if ($ThrowIfMissing) {
        $msg = "Cannot find Obsidian vault. Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT env var, " +
               "or open a vault in the Obsidian app. Searched: " +
               ([string]::Join(", ", @($FallbackPath) + @(Get-SharedDefaultObsidianVaultCandidates)))
        Write-Error $msg
        throw "VAULT_RESOLUTION_FAILED: $msg"
    }

    return $FallbackPath
}
