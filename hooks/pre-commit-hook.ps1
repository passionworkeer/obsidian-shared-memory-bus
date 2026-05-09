#Requires -Version 7
<#
.SYNOPSIS
    pre-commit hook — agent registration + fast inbox cleanup.
    Non-blocking: always exits 0. Failures never block git commits.
.DESCRIPTION
    1. Detects active agent from environment variables and process tree
    2. Appends timestamped registration to structured/agent-registrations.jsonl
    3. Runs cleanup-inbox.ps1 --smoke (fast, 30d+ only)
#>
param(
    [string]$WorkspaceRoot = $PSScriptRoot | Split-Path -Parent  # default: repo root from hook location
)

$ErrorActionPreference = 'SilentlyContinue'
$PSDefaultParameterValues['*:ErrorAction'] = 'SilentlyContinue'

# Resolve workspace root
if (-not (Test-Path "$WorkspaceRoot\.git")) {
    # Try parent dirs
    $candidates = @(
        "$PSScriptRoot",
        "$PSScriptRoot\..",
        "$PSScriptRoot\..\.."
    )
    foreach ($c in $candidates) {
        if (Test-Path "$c\.git") { $WorkspaceRoot = $c; break }
    }
}

$storeRoot = if ($env:AI_MEMORY_STORE) { $env:AI_MEMORY_STORE } elseif ($env:AI_MEMORY_OBSIDIAN_VAULT) { $env:AI_MEMORY_OBSIDIAN_VAULT } else { $null }
if (-not $storeRoot) { exit 0 }  # no store, skip silently

$structDir = Join-Path $storeRoot "structured"

# ── Step 1: Detect active agent ────────────────────────────────────────────
function Get-ActiveAgent {
    if ($env:AGENT_NAME) { return $env:AGENT_NAME }
    if ($env:CLAUDE_CODE) { return "claude-code" }
    if ($env:CODEX_AGENT) { return "codex" }
    if ($env:OPENCLAW_AGENT) { return "openclaw" }
    if ($env:TRAE_SESSION) { return "trae" }
    if ($env:CURSOR_SESSION) { return "cursor" }
    if ($env:COPILOT_SESSION) { return "copilot" }
    # Check process tree for known agent processes
    $procs = Get-Process | Select-Object -ExpandProperty ProcessName
    if ($procs -contains "claude") { return "claude-code" }
    if ($procs -contains "codex") { return "codex" }
    if ($procs -contains "openclaw") { return "openclaw" }
    return "unknown"
}

$agent = Get-ActiveAgent
if ($agent -eq "unknown") {
    # Try to detect from git config
    $userName = git config user.name 2>$null
    if ($userName) { $agent = $userName.ToLower().replace(' ', '-') }
    else { $agent = "git-user" }
}

# ── Step 2: Register agent ─────────────────────────────────────────────
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$registration = @{
    agent   = $agent
    event   = "pre-commit"
    repo    = $WorkspaceRoot
    t       = $timestamp
} | ConvertTo-Json -Compress

$regFile = Join-Path $structDir "agent-registrations.jsonl"
$null = New-Item -ItemType Directory -Force -Path (Split-Path $regFile) -ErrorAction SilentlyContinue
$registration | Out-File -FilePath $regFile -Append -Encoding UTF8 -ErrorAction SilentlyContinue

# ── Step 3: Fast inbox cleanup (smoke mode — 30d+ only) ────────────────
$cleanupScript = Join-Path $WorkspaceRoot "ops\cleanup-inbox.ps1"
if (Test-Path $cleanupScript) {
    $null = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$cleanupScript,"-StoreRoot",$storeRoot,"-SmokeMode" -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
}

# Always exit 0 — non-blocking
exit 0
