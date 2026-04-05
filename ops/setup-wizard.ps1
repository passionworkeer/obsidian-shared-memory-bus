param(
    [switch]$DryRun
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Continue"

$ESC = [char]27
$CLR_RESET = "${ESC}[0m"
$CLR_GREEN = "${ESC}[92m"
$CLR_RED = "${ESC}[91m"
$CLR_YELLOW = "${ESC}[93m"
$CLR_BOLD = "${ESC}[1m"

function Test-Prerequisite {
    param(
        [string]$Name,
        [scriptblock]$Test,
        [string]$Fix
    )

    try {
        $result = & $Test
        if ($result) {
            Write-Output "${CLR_GREEN}[PASS]${CLR_RESET} $Name"
            return $true
        } else {
            Write-Output "${CLR_RED}[FAIL]${CLR_RESET} $Name"
            if ($Fix) {
                Write-Output "       Fix: $Fix"
            }
            return $false
        }
    } catch {
        Write-Output "${CLR_RED}[FAIL]${CLR_RESET} $Name — error: $($_.Exception.Message)"
        if ($Fix) {
            Write-Output "       Fix: $Fix"
        }
        return $false
    }
}

function New-MissingDirectory {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        if ($DryRun) {
            Write-Output "[dry-run] would create directory: $Path"
            return $true
        }
        try {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
            return $true
        } catch {
            Write-Output "${CLR_RED}[FAIL]${CLR_RESET} Could not create $Path — $($_.Exception.Message)"
            return $false
        }
    }
    return $true
}

function New-MissingFile {
    param(
        [string]$Path,
        [string]$Content = ""
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($DryRun) {
            Write-Output "[dry-run] would create file: $Path"
            return $true
        }
        try {
            $dir = Split-Path -Parent $Path
            if ($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
            }
            Set-Content -Path $Path -Value $Content -Force
            return $true
        } catch {
            Write-Output "${CLR_RED}[FAIL]${CLR_RESET} Could not create $Path — $($_.Exception.Message)"
            return $false
        }
    }
    return $true
}

Write-Output ""
Write-Output "${CLR_BOLD}ai-memory Setup Wizard${CLR_RESET}"
Write-Output "============================"
Write-Output ""

$prereqsOk = $true

Write-Output "${CLR_BOLD}Checking prerequisites...${CLR_RESET}"
Write-Output ""

$nodeVersion = $null
try {
    $nodeVersion = (node --version 2>$null)
    if ($nodeVersion) {
        $nodeVersion = $nodeVersion.Trim()
        $nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
        $prereqsOk = $prereqsOk -and (Test-Prerequisite -Name "Node.js >= 18 (found $nodeVersion)" -Test { $nodeMajor -ge 18 } -Fix "Upgrade Node.js to 18 or later")
    } else {
        $prereqsOk = $prereqsOk -and (Test-Prerequisite -Name "Node.js >= 18" -Test { $false } -Fix "Install Node.js 18 or later")
    }
} catch {
    $prereqsOk = $prereqsOk -and (Test-Prerequisite -Name "Node.js >= 18" -Test { $false } -Fix "Install Node.js 18 or later")
}

try {
    $pythonVersion = python --version 2>$null
    if ($pythonVersion) {
        $pythonVersion = $pythonVersion.Trim()
        $pyMatch = [regex]::Match($pythonVersion, 'Python (\d+)\.(\d+)')
        if ($pyMatch) {
            $pyMajor = [int]$pyMatch.Groups[1].Value
            $pyMinor = [int]$pyMatch.Groups[2].Value
            $pyOk = $pyMajor -gt 3 -or ($pyMajor -eq 3 -and $pyMinor -ge 10)
            $prereqsOk = $prereqsOk -and (Test-Prerequisite -Name "Python >= 3.10 (found $pyMajor.$pyMinor)" -Test { $pyOk } -Fix "Install Python 3.10+ for full MCP support")
        } else {
            $prereqsOk = $prereqsOk -and (Test-Prerequisite -Name "Python detected" -Test { $true } -Fix "Install Python 3.10+ for full MCP support")
        }
    } else {
        Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} Python not found — some MCP servers may not work"
    }
} catch {
    Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} Python not found — some MCP servers may not work"
}

try {
    $pwshVersion = pwsh --version 2>$null
    if ($pwshVersion) {
        $pwshVersion = $pwshVersion.Trim()
        Write-Output "${CLR_GREEN}[PASS]${CLR_RESET} PowerShell Core (pwsh) $pwshVersion"
    } else {
        Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} PowerShell Core (pwsh) not found — PowerShell 7+ recommended"
    }
} catch {
    Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} PowerShell Core (pwsh) not found — PowerShell 7+ recommended"
}

Write-Output ""

if (-not $prereqsOk) {
    Write-Output "${CLR_RED}Prerequisites not met. Please fix the issues above before continuing.${CLR_RESET}"
    Write-Output "Run 'ai-memory doctor' for more details."
    exit 1
}

Write-Output "${CLR_BOLD}Detecting Obsidian vault...${CLR_RESET}"
Write-Output ""

$vaultRoot = $null

$envVault = $env:AI_MEMORY_OBSIDIAN_VAULT
if ($envVault -and (Test-Path -LiteralPath $envVault -PathType Container)) {
    $vaultRoot = $envVault
    Write-Output "Found vault via AI_MEMORY_OBSIDIAN_VAULT: $vaultRoot"
}

if (-not $vaultRoot) {
    $obsidianConfig = "$env:APPDATA\obsidian\obsidian.json"
    if (Test-Path -LiteralPath $obsidianConfig -PathType Leaf) {
        try {
            $config = Get-Content -Raw -LiteralPath $obsidianConfig | ConvertFrom-Json
            $vaults = @($config.vaults.PSObject.Properties)
            if ($vaults.Count -gt 0) {
                $sorted = $vaults | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Path = $_.Value.path; Open = $_.Value.open; Ts = $_.Value.ts } } | Sort-Object -Property Ts -Descending
                $open = $sorted | Where-Object { $_.Open -eq $true } | Select-Object -First 1
                $candidate = if ($open) { $open.Path } else { $sorted[0].Path }
                if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
                    $vaultRoot = $candidate
                    Write-Output "Found vault via Obsidian config: $vaultRoot"
                }
            }
        } catch {
        }
    }
}

if (-not $vaultRoot) {
    $homeVaultCandidates = @(
        (Join-Path $env:USERPROFILE "Obsidian Vault"),
        (Join-Path $env:USERPROFILE "Documents\Obsidian Vault"),
        (Join-Path $env:USERPROFILE "Desktop\Obsidian Vault")
    )
    foreach ($candidate in $homeVaultCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            $vaultRoot = $candidate
            Write-Output "Found vault at default location: $vaultRoot"
            break
        }
    }
}

if (-not $vaultRoot) {
    Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} No Obsidian vault detected automatically."
    Write-Output ""
    $manual = Read-Host "Enter the path to your Obsidian vault (or press Enter to skip vault setup)"
    if ($manual -and (Test-Path -LiteralPath $manual -PathType Container)) {
        $vaultRoot = $manual
        Write-Output "Using vault: $vaultRoot"
    } else {
        Write-Output "Skipping vault setup. Set AI_MEMORY_OBSIDIAN_VAULT manually later."
    }
}

Write-Output ""

if ($vaultRoot) {
    Write-Output "${CLR_BOLD}Creating vault directory structure...${CLR_RESET}"
    Write-Output ""

    $dirs = @(
        (Join-Path $vaultRoot "00-System\ai-memory\inbox"),
        (Join-Path $vaultRoot "00-System\ai-memory\generated"),
        (Join-Path $vaultRoot "00-System\ai-memory\archived"),
        (Join-Path $vaultRoot "02-KB"),
        (Join-Path $vaultRoot "02-KB\inbox"),
        (Join-Path $vaultRoot "02-Projects"),
        (Join-Path $vaultRoot "02-Projects\inbox"),
        (Join-Path $vaultRoot "02-Area"),
        (Join-Path $vaultRoot "02-Area\inbox"),
        (Join-Path $vaultRoot "03-Resources"),
        (Join-Path $vaultRoot "03-Resources\inbox"),
        (Join-Path $vaultRoot "04-Archives"),
        (Join-Path $vaultRoot "04-Archives\inbox")
    )

    $allDirsOk = $true
    foreach ($dir in $dirs) {
        if (-not (New-MissingDirectory -Path $dir)) {
            $allDirsOk = $false
        }
    }

    Write-Output ""

    Write-Output "${CLR_BOLD}Creating essential files...${CLR_RESET}"
    Write-Output ""

    $files = @{
        (Join-Path $vaultRoot "02-KB\OBSIDIAN.md") = @"
# Obsidian

This vault is the shared memory layer for AI tools on this machine.

## Quick Links

- [[MEMORY]] — Shared memory overview
- [[WORKING]] — Current project context
- [[INBOX]] — Unprocessed items
"@
        (Join-Path $vaultRoot "02-KB\MEMORY.md") = @"
# Memory

## Shared Memory Bus

This Obsidian vault serves as the shared memory layer for AI coding tools.

## Structure

- `00-System/ai-memory/` — AI memory system files
- `02-KB/` — Knowledge base
- `02-Projects/` — Project-specific memory
- `02-Area/` — Area-based memory organization
- `03-Resources/` — Resources and references
- `04-Archives/` — Archived memory

## Usage

AI tools write context, handoffs, and summaries here for other AI tools to read.
"@
        (Join-Path $vaultRoot "02-KB\WORKING.md") = @"
# Working

## Current Task

<!-- Active task description -->

## Context

<!-- Current working context -->

## Recent Handoffs

<!-- Recent handoff summaries -->
"@
        (Join-Path $vaultRoot "02-KB\INBOX.md") = @"
# Inbox

<!-- Unprocessed items go here -->
"@
    }

    $allFilesOk = $true
    foreach ($file in $files.Keys) {
        if (-not (New-MissingFile -Path $file -Content $files[$file])) {
            $allFilesOk = $false
        }
    }

    Write-Output ""

    Write-Output "${CLR_BOLD}Setting AI_MEMORY_OBSIDIAN_VAULT...${CLR_RESET}"
    Write-Output ""

    $setEnvScript = @"
# ai-memory: Obsidian Vault
`$env:AI_MEMORY_OBSIDIAN_VAULT = "$vaultRoot"
"@

    $env:AI_MEMORY_OBSIDIAN_VAULT = $vaultRoot

    $profilePath = $PROFILE
    if ($profilePath) {
        $profileDir = Split-Path -Parent $profilePath
        if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
            New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        }
        $envLine = "`$env:AI_MEMORY_OBSIDIAN_VAULT = `"$vaultRoot`""
        if (-not (Select-String -Path $profilePath -Pattern "AI_MEMORY_OBSIDIAN_VAULT" -Quiet)) {
            if ($DryRun) {
                Write-Output "[dry-run] would add to `$PROFILE: $envLine"
            } else {
                Add-Content -Path $profilePath -Value "`n$envLine"
                Write-Output "${CLR_GREEN}[OK]${CLR_RESET} Added AI_MEMORY_OBSIDIAN_VAULT to `$PROFILE"
            }
        } else {
            Write-Output "${CLR_GREEN}[OK]${CLR_RESET} AI_MEMORY_OBSIDIAN_VAULT already in `$PROFILE"
        }
    } else {
        Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} Could not detect `$PROFILE. Set AI_MEMORY_OBSIDIAN_VAULT manually."
    }
}

Write-Output ""
Write-Output "${CLR_BOLD}Basic health check...${CLR_RESET}"
Write-Output ""

try {
    $nodeCheck = node --version 2>$null
    if ($nodeCheck) {
        Write-Output "${CLR_GREEN}[PASS]${CLR_RESET} Node.js is working"
    }
} catch {
    Write-Output "${CLR_RED}[FAIL]${CLR_RESET} Node.js check failed"
}

$aiMemoryRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (Test-Path (Join-Path $aiMemoryRoot "bus\memory-bus.ps1")) {
    Write-Output "${CLR_GREEN}[PASS]${CLR_RESET} ai-memory installation found"
} else {
    Write-Output "${CLR_YELLOW}[WARN]${CLR_RESET} Could not verify ai-memory installation"
}

Write-Output ""
Write-Output "=========================================="
Write-Output "${CLR_GREEN}Setup complete!${CLR_RESET}"
Write-Output ""
Write-Output "Run 'ai-memory mcp:start' to start the shared memory bus."
Write-Output ""

exit 0
