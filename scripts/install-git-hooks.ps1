#Requires -Version 7
<#
.SYNOPSIS
    Installs git hooks and their shims into the repository's .git/hooks/ directory.
    Called automatically by scripts/install.ps1. Can be run standalone.
.DESCRIPTION
    Installs:
      .git/hooks/pre-commit            (POSIX shim)
      .git/hooks/post-checkout         (POSIX shim)
      .git/hooks/post-merge            (POSIX shim)
      .git/hooks/pre-commit-hook.ps1   (PowerShell script)
      .git/hooks/post-checkout-hook.ps1 (PowerShell script)
      .git/hooks/post-merge-hook.ps1   (PowerShell script)
.PARAMETER WorkspaceRoot
    Path to the repository root. Defaults to the current directory.
.PARAMETER Force
    Overwrite existing hook files.
.PARAMETER DryRun
    Show what would be installed without actually installing.
#>
param(
    [string]$WorkspaceRoot = ".",
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot | Split-Path -Parent  # default: repo root from script location
if ($WorkspaceRoot -and $WorkspaceRoot -ne ".") {
    if (Test-Path $WorkspaceRoot) { $repoRoot = $WorkspaceRoot }
}

$hooksDir = Join-Path $repoRoot ".git\hooks"
$opsDir   = Join-Path $repoRoot "ops"

# Verify .git directory exists
if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
    Write-Error "Not a git repository: $repoRoot"
    exit 1
}

Write-Host "Installing git hooks into: $hooksDir" -ForegroundColor Cyan

# ── Files to install ─────────────────────────────────────────────────
$hooks = @(
    @{
        Name = "pre-commit"
        Shims = @("$repoRoot\.git\hooks\pre-commit",    "$repoRoot\.git\hooks\post-checkout", "$repoRoot\.git\hooks\post-merge")
        PS1Sources = @(
            @{ Src = "$opsDir\pre-commit-hook.ps1";     Dst = "$hooksDir\pre-commit-hook.ps1" },
            @{ Src = "$opsDir\post-checkout-hook.ps1";  Dst = "$hooksDir\post-checkout-hook.ps1" },
            @{ Src = "$opsDir\post-merge-hook.ps1";     Dst = "$hooksDir\post-merge-hook.ps1" }
        )
    }
)

# ── Check source files exist ─────────────────────────────────────────
$missing = $opsDir
foreach ($src in @("$opsDir\pre-commit-hook.ps1","$opsDir\post-checkout-hook.ps1","$opsDir\post-merge-hook.ps1")) {
    if (-not (Test-Path $src)) {
        Write-Error "Missing source hook script: $src"
        exit 1
    }
}

# ── Ensure hooks directory exists ─────────────────────────────────────
if (-not (Test-Path $hooksDir)) {
    if ($DryRun) {
        Write-Host "[DryRun] Would create hooks directory: $hooksDir" -ForegroundColor Yellow
    } else {
        New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
    }
}

# ── Install shims and PS1 scripts ───────────────────────────────────
$shimContents = @{
    "pre-commit"    = @'
#!/bin/sh
# pre-commit hook shim
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POWERSHELL_SCRIPT="$SCRIPT_DIR/pre-commit-hook.ps1"
if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$@" 2>/dev/null
elif command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$@" 2>/dev/null
fi
exit 0
'@
    "post-checkout" = @'
#!/bin/sh
# post-checkout hook shim
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POWERSHELL_SCRIPT="$SCRIPT_DIR/post-checkout-hook.ps1"
PREV_HEAD="$1"; NEW_HEAD="$2"; CHECKOUT_FLAG="$3"
if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$PREV_HEAD" "$NEW_HEAD" "$CHECKOUT_FLAG" 2>/dev/null
elif command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$PREV_HEAD" "$NEW_HEAD" "$CHECKOUT_FLAG" 2>/dev/null
fi
exit 0
'@
    "post-merge" = @'
#!/bin/sh
# post-merge hook shim
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POWERSHELL_SCRIPT="$SCRIPT_DIR/post-merge-hook.ps1"
if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$@" 2>/dev/null
elif command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "$POWERSHELL_SCRIPT" "$@" 2>/dev/null
fi
exit 0
'@
}

$shimNames = @("pre-commit", "post-checkout", "post-merge")
$ps1Names  = @("pre-commit-hook.ps1", "post-checkout-hook.ps1", "post-merge-hook.ps1")

foreach ($name in $shimNames) {
    $shimFile = Join-Path $hooksDir $name
    $srcFile  = Join-Path $opsDir "$name-hook.ps1"

    if ($DryRun) {
        Write-Host "[DryRun] Would install shim: $shimFile" -ForegroundColor Yellow
        Write-Host "[DryRun] Would install PS1:  $(Join-Path $hooksDir "$name-hook.ps1")" -ForegroundColor Yellow
        continue
    }

    if ((Test-Path $shimFile) -and -not $Force) {
        Write-Warning "Skipping existing hook (use -Force to overwrite): $shimFile"
    } else {
        # Write shim
        $shimContents[$name] -replace "`r`n", "`n" -replace "`n", "`r`n" | Out-File -FilePath $shimFile -Encoding ASCII -ErrorAction Stop
        # On Unix-like systems, the file needs to be executable
        if ($env:OSTYPE -ne "win32" -and (Get-Command chmod -ErrorAction SilentlyContinue)) {
            chmod +x $shimFile
        }
        Write-Host "  Installed shim: $name" -ForegroundColor Green
    }

    $ps1Dst = Join-Path $hooksDir "$name-hook.ps1"
    if ((Test-Path $ps1Dst) -and -not $Force) {
        Write-Warning "Skipping existing PS1 (use -Force to overwrite): $ps1Dst"
    } else {
        Copy-Item -Path $srcFile -Destination $ps1Dst -Force -ErrorAction Stop
        Write-Host "  Installed PS1:  $name-hook.ps1" -ForegroundColor Green
    }
}

# ── Install the shim files from the repo .git/hooks/ directory ───────
# These files are already written to .git/hooks/ by Write operations above
# We just need to ensure they are also copyable from the source tree
$sourceShims = @(
    @{ Src = "$repoRoot\.git\hooks\pre-commit";     Name = "pre-commit" }
    @{ Src = "$repoRoot\.git\hooks\post-checkout";   Name = "post-checkout" }
    @{ Src = "$repoRoot\.git\hooks\post-merge";      Name = "post-merge" }
)

foreach ($s in $sourceShims) {
    if ((Test-Path $s.Src) -and -not $Force) {
        # Already written by Write operations
    }
}

if (-not $DryRun) {
    Write-Host ""
    Write-Host "Git hooks installed successfully." -ForegroundColor Green
    Write-Host "Non-blocking: all hooks always exit 0 and never block git operations." -ForegroundColor Gray
    Write-Host "To uninstall: remove .git/hooks/pre-commit, post-checkout, post-merge and their .ps1 counterparts." -ForegroundColor Gray
}
