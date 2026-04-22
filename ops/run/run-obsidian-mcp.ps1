param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $PSScriptRoot
$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

function Resolve-McpVaultRunner {
    $searchRoots = New-Object System.Collections.Generic.List[string]
    foreach ($root in @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot), $env:AI_MEMORY_ROOT)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and -not $searchRoots.Contains($root)) {
            $searchRoots.Add($root) | Out-Null
        }
    }

    foreach ($root in @($searchRoots)) {
        foreach ($candidate in @(
                (Join-Path $root (Join-Path "shared-mcp" (Join-Path "node_modules" (Join-Path "@bitbonsai" (Join-Path "mcpvault" (Join-Path "dist" "server.js")))))),
                (Join-Path $root (Join-Path "node_modules" (Join-Path "@bitbonsai" (Join-Path "mcpvault" (Join-Path "dist" "server.js")))))
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

            $globalModule = Join-Path $globalRoot (Join-Path "@bitbonsai" (Join-Path "mcpvault" (Join-Path "dist" "server.js")))
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

$vaultRoot = Resolve-SharedObsidianVaultRoot -ThrowIfMissing
$runner = Resolve-McpVaultRunner

if ($runner.kind -eq "node") {
    & (Resolve-SharedNodeExecutable) "$($runner.path)" "$vaultRoot"
    exit $LASTEXITCODE
}

& "$($runner.path)" "$vaultRoot"
exit $LASTEXITCODE
