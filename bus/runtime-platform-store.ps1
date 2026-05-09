Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-store.ps1
# Store root path resolution (replaces Obsidian vault resolution).
# Depends on: runtime-platform-paths.ps1, runtime-platform-env.ps1
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"
. "$PSScriptRoot\runtime-platform-env.ps1"

function Get-SharedStoreCandidates {
    $userHome = Get-SharedUserHome
    return @(
        (Join-SharedPath @($userHome, ".ai-memory")),
        (Join-SharedPath @($userHome, "ai-memory"))
    ) | Select-Object -Unique
}

function Resolve-SharedStoreRoot {
    param(
        [AllowEmptyString()][string]$FallbackPath = "",
        [switch]$ThrowIfMissing
    )

    # Primary: AI_MEMORY_STORE env var
    foreach ($overridePath in @(
        (Get-SharedEnvValue -Name "AI_MEMORY_STORE"),
        (Get-SharedEnvValue -Name "AI_MEMORY_STORE_ROOT")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    # Fallback candidates
    foreach ($candidate in (@($FallbackPath) + @(Get-SharedStoreCandidates))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    if ($ThrowIfMissing) {
        $msg = "Cannot find memory store. Set AI_MEMORY_STORE or AI_MEMORY_STORE_ROOT env var. " +
               "Searched: " +
               ([string]::Join(", ", @($FallbackPath) + @(Get-SharedStoreCandidates)))
        Write-Error $msg
        throw "STORE_RESOLUTION_FAILED: $msg"
    }

    return $FallbackPath
}

# ---------------------------------------------------------------------------
# Obsidian vault resolution (DEPRECATED - kept for migration compatibility)
# ---------------------------------------------------------------------------

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

    # Migration: if AI_MEMORY_STORE is set, use it instead
    $storeRoot = Resolve-SharedStoreRoot -FallbackPath ""
    if (-not [string]::IsNullOrWhiteSpace($storeRoot)) {
        return $storeRoot
    }

    # Legacy: check Obsidian-specific env vars
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
        $msg = "Cannot find memory store. Set AI_MEMORY_STORE env var. " +
               "Searched: " +
               ([string]::Join(", ", @($FallbackPath) + @(Get-SharedStoreCandidates)))
        Write-Error $msg
        throw "STORE_RESOLUTION_FAILED: $msg"
    }

    return $FallbackPath
}
