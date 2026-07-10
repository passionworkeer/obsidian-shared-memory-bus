# scripts/start-all.ps1
# One-click start for all AI Memory Bus services
# Usage: .\start-all.ps1 [-SkipMcp] [-SkipWatchdog] [-Verify]

param(
    [switch]$SkipMcp,
    [switch]$SkipWatchdog,
    [switch]$Verify,
    [switch]$SkipInstall
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Continue"

# Color helpers
function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

# Detect script location
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

# Set AI_MEMORY_ROOT if not set
if ([string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) {
    $env:AI_MEMORY_ROOT = $ProjectRoot
}

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  AI Memory Bus - One-Click Start" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "AI_MEMORY_ROOT: $env:AI_MEMORY_ROOT"

# ========================================
# 1. Prerequisite checks
# ========================================
Write-Step "Checking prerequisites..."

$checks = @()

# Node.js
$nodeVersion = & node --version 2>$null
if ($nodeVersion) {
    $checks += @{ name = "Node.js"; ok = $true; detail = $nodeVersion }
} else {
    $checks += @{ name = "Node.js"; ok = $false; detail = "not found" }
}

# Python - prefer configured runtime, then PATH-resolved commands
$pythonCmd = $null
$pythonVersion = $null
$pythonCandidates = New-Object System.Collections.Generic.List[object]
foreach ($envName in @("AI_MEMORY_PYTHON", "PYTHON_EXE", "PYTHON")) {
    $value = [Environment]::GetEnvironmentVariable($envName)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $pythonCandidates.Add([pscustomobject]@{ Command = $value; Args = @() }) | Out-Null
    }
}
$pythonCandidates.Add([pscustomobject]@{ Command = "python"; Args = @() }) | Out-Null
$pythonCandidates.Add([pscustomobject]@{ Command = "python3"; Args = @() }) | Out-Null
if ($IsWindows -or $env:OS -eq "Windows_NT") {
    $pythonCandidates.Add([pscustomobject]@{ Command = "py"; Args = @("-3") }) | Out-Null
    $pythonCandidates.Add([pscustomobject]@{ Command = "py"; Args = @() }) | Out-Null
}
foreach ($candidate in $pythonCandidates) {
    try {
        $v = & $candidate.Command @($candidate.Args + @("--version")) 2>$null
        if ($v) {
            $pythonCmd = ([string[]]@($candidate.Command) + [string[]]$candidate.Args) -join " "
            $pythonVersion = $v
            break
        }
    } catch {}
}
if ($pythonVersion) {
    $checks += @{ name = "Python"; ok = $true; detail = "$pythonVersion ($pythonCmd)" }
} else {
    $checks += @{ name = "Python"; ok = $false; detail = "not found" }
}

# npm - use --version flag
$npmVersion = & npm --version 2>$null
if ($LASTEXITCODE -eq 0 -and $npmVersion) {
    $checks += @{ name = "npm"; ok = $true; detail = "v$npmVersion" }
} else {
    $checks += @{ name = "npm"; ok = $false; detail = "not found" }
}

# AI Memory Store - try multiple paths
$storePaths = @(
    $env:AI_MEMORY_STORE,
    $env:AI_MEMORY_STORE_ROOT,
    "$env:USERPROFILE\.ai-memory",
    "$env:USERPROFILE\ai-memory"
)

$foundStore = $null
foreach ($sp in $storePaths) {
    if ($sp -and (Test-Path -LiteralPath $sp -PathType Container)) {
        $foundStore = $sp
        break
    }
}

if ($foundStore) {
    $checks += @{ name = "AI Memory Store"; ok = $true; detail = $foundStore }
    $env:AI_MEMORY_STORE = $foundStore
} else {
    $defaultStore = Join-Path $env:USERPROFILE ".ai-memory"
    try {
        New-Item -ItemType Directory -Path $defaultStore -Force | Out-Null
        $env:AI_MEMORY_STORE = $defaultStore
        $checks += @{ name = "AI Memory Store"; ok = $true; detail = "$defaultStore (created)" }
    } catch {
        $checks += @{ name = "AI Memory Store"; ok = $false; detail = "not found and could not create $defaultStore" }
    }
}

# Display results
foreach ($check in $checks) {
    if ($check.ok) {
        Write-Success "$($check.name) $($check.detail)"
    } else {
        Write-Fail "$($check.name): $($check.detail)"
    }
}

# Critical checks
$criticalMissing = @($checks | Where-Object { -not $_.ok -and $_.name -in @("Node.js", "Python") })
if ($criticalMissing.Count -gt 0) {
    Write-Fail "Missing critical dependencies. Please install Node.js and Python first."
    exit 1
}

# ========================================
# 2. Install dependencies
# ========================================
if (-not $SkipInstall) {
    Write-Step "Checking/Installing dependencies..."

    # npm dependencies
    $npmCheck = Test-Path "$ProjectRoot\shared-mcp\node_modules" -PathType Container
    if (-not $npmCheck) {
        Write-Host "  Installing shared-mcp npm dependencies..."
        Push-Location "$ProjectRoot\shared-mcp"
        npm install 2>&1 | Out-Null
        Pop-Location
        Write-Success "npm dependencies installed"
    } else {
        Write-Success "npm dependencies already exist"
    }

    # Python MCP packages
    if ($pythonCmd) {
        Write-Host "  Checking Python MCP packages..."
        $mcpPkgs = @("mcp-server-fetch", "mcp-server-time")
        foreach ($pkg in $mcpPkgs) {
            $installed = & $pythonCmd -m pip show $pkg 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  Installing $pkg..."
                & $pythonCmd -m pip install $pkg 2>&1 | Out-Null
                Write-Success "$pkg installed"
            } else {
                Write-Success "$pkg already installed"
            }
        }
    }
}

# ========================================
# 3. Start MCP servers
# ========================================
if (-not $SkipMcp) {
    Write-Step "Starting MCP servers..."

    # Check if already running
    try {
        $tcpConnection = Test-NetConnection -ComputerName 127.0.0.1 -Port 9338 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        if ($tcpConnection.TcpTestSucceeded) {
            Write-Success "MCP servers already running (port 9338)"
        } else {
            # Start MCP servers
            $startScript = Join-Path $ProjectRoot "shared-mcp\start-default-shared-mcp.ps1"
            if (Test-Path -LiteralPath $startScript) {
                Write-Host "  Starting shared MCP servers..."
                & $startScript -ForceRestart
                Write-Success "MCP servers started"
            } else {
                Write-Fail "start-default-shared-mcp.ps1 not found"
            }
        }
    } catch {
        # Fallback: try to start anyway
        $startScript = Join-Path $ProjectRoot "shared-mcp\start-default-shared-mcp.ps1"
        if (Test-Path -LiteralPath $startScript) {
            & $startScript -ForceRestart
            Write-Success "MCP servers started"
        }
    }

    # Wait for services
    Write-Host "  Waiting for services (5s)..."
    Start-Sleep -Seconds 5
}

# ========================================
# 4. Start Watchdog (optional)
# ========================================
if (-not $SkipWatchdog) {
    Write-Step "Starting Watchdog..."

    $watchdogScript = Join-Path $ProjectRoot "memory-watchdog.ps1"
    if (-not (Test-Path -LiteralPath $watchdogScript)) {
        $watchdogScript = Join-Path $ProjectRoot "bus\memory-watchdog.ps1"
    }

    if (Test-Path -LiteralPath $watchdogScript) {
        $watchdogJob = Start-Job -ScriptBlock {
            param($script)
            & $script -Daemon
        } -ArgumentList $watchdogScript

        Write-Success "Watchdog started (background)"
    } else {
        Write-Warn "memory-watchdog.ps1 not found, skipping"
    }
}

# ========================================
# 5. Verify status
# ========================================
if ($Verify -or (-not $SkipMcp)) {
    Write-Step "Verifying service status..."

    $ports = @{
        "9331" = "context7"
        "9332" = "fetch"
        "9333" = "time"
        "9334" = "sequential-thinking"
        "9335" = "memory"
        "9336" = "MiniMax (optional)"
        "9337" = "playwright (optional)"
        "9338" = "memory"
    }

    $anyUp = $false
    foreach ($port in $ports.Keys) {
        try {
            $result = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
            if ($result.TcpTestSucceeded) {
                Write-Success "$($ports[$port]) (port $port)"
                $anyUp = $true
            }
        } catch {}
    }

    if (-not $anyUp) {
        Write-Warn "No MCP servers detected"
        Write-Host "Run manually: .\shared-mcp\start-default-shared-mcp.ps1" -ForegroundColor Yellow
    }
}

# ========================================
# Complete
# ========================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  Start Complete!" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

Write-Host "`nNext steps:" -ForegroundColor White
Write-Host "  1. Configure Claude Code hooks (optional):"
Write-Host "     Run as admin: .\scripts\setup-hooks.ps1"
Write-Host ""
Write-Host "  2. Check service status:"
Write-Host "     .\shared-mcp\status-shared-mcp.ps1"
Write-Host ""
Write-Host "  3. Verify integrations:"
Write-Host "     .\ops\verify\verify-integrations.ps1"

# Check if VS Code is configured
$vscodeMcpPath = "$ProjectRoot\.vscode\mcp.json"
if (Test-Path -LiteralPath $vscodeMcpPath) {
    Write-Host ""
    Write-Host "  4. VS Code already configured with shared MCP" -ForegroundColor Green
}
