param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Resolve-ObsidianVaultRoot {
    foreach ($overridePath in @($env:AI_MEMORY_OBSIDIAN_VAULT, $env:OBSIDIAN_VAULT_ROOT)) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    $obsidianConfigPath = Join-Path $env:APPDATA "obsidian\obsidian.json"
    if (Test-Path -LiteralPath $obsidianConfigPath) {
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
                        ts = if ($null -ne $vault.ts) { [int64]$vault.ts } else { 0 }
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

    $desktopFallback = Join-Path ([Environment]::GetFolderPath("Desktop")) "Obsidian Vault"
    foreach ($fallback in @($desktopFallback, (Join-Path $env:USERPROFILE "Documents\Obsidian Vault"))) {
        if (Test-Path -LiteralPath $fallback -PathType Container) {
            return (Get-Item -LiteralPath $fallback).FullName
        }
    }

    throw "No Obsidian vault directory found."
}

function Resolve-McpVaultRunner {
    $searchRoots = New-Object System.Collections.Generic.List[string]
    foreach ($root in @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot), $env:AI_MEMORY_ROOT)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and -not $searchRoots.Contains($root)) {
            $searchRoots.Add($root) | Out-Null
        }
    }

    foreach ($root in @($searchRoots)) {
        foreach ($candidate in @(
            (Join-Path $root "shared-mcp\node_modules\@bitbonsai\mcpvault\dist\server.js"),
            (Join-Path $root "node_modules\@bitbonsai\mcpvault\dist\server.js")
        )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return @{
                    kind = "node"
                    path = $candidate
                }
            }
        }
    }

    foreach ($npmName in @("npm.cmd", "npm")) {
        $npmCommand = Get-Command $npmName -ErrorAction SilentlyContinue
        if (-not $npmCommand) {
            continue
        }

        try {
            $globalRoot = (& $npmCommand.Source root -g 2>$null | Select-Object -First 1).Trim()
            if ([string]::IsNullOrWhiteSpace($globalRoot)) {
                continue
            }

            $globalModule = Join-Path $globalRoot "@bitbonsai\mcpvault\dist\server.js"
            if (Test-Path -LiteralPath $globalModule -PathType Leaf) {
                return @{
                    kind = "node"
                    path = $globalModule
                }
            }
        } catch {
        }
    }

    foreach ($commandName in @("mcpvault.cmd", "mcpvault.ps1", "mcpvault")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command) {
            return @{
                kind = "command"
                path = $command.Source
            }
        }
    }

    throw "mcpvault was not found. Run scripts/install.ps1 or install @bitbonsai/mcpvault globally."
}

$vaultRoot = Resolve-ObsidianVaultRoot
$runner = Resolve-McpVaultRunner

if ($runner.kind -eq "node") {
    node "$($runner.path)" "$vaultRoot"
    exit $LASTEXITCODE
}

& "$($runner.path)" "$vaultRoot"
exit $LASTEXITCODE
