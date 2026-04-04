param(
    [string]$VaultRoot,
    [string]$StructuredRoot,
    [int]$MinToolCallsPerSession = 10,
    [int]$MinGapMinutes = 30,
    [switch]$DryRun
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Continue"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

# ---------------------------------------------------------------------------
# Helper resolution  (same pattern as other ops/ scripts)
# ---------------------------------------------------------------------------
$sourceRoot = Split-Path -Parent $PSScriptRoot
$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "bus/runtime-platform.ps1"),
    (Join-Path $sourceRoot "bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($VaultRoot)) {
    $VaultRoot = Resolve-SharedObsidianVaultRoot -FallbackPath (Join-Path $env:USERPROFILE "Documents\Obsidian Vault")
}

if ([string]::IsNullOrWhiteSpace($StructuredRoot)) {
    $AiMemoryRoot = Join-SharedPath @($VaultRoot, "00-System", "ai-memory")
    $StructuredRoot = Join-SharedPath @($AiMemoryRoot, "structured")
}

$InboxDir = Join-Path $StructuredRoot "inbox"
$InboxFile = Join-Path $InboxDir "auto-extracted.md"

# ---------------------------------------------------------------------------
# Session-memory file discovery
# ---------------------------------------------------------------------------
function Get-SessionMemoryFiles($vaultRoot) {
    $claudeDir = Join-Path $env:USERPROFILE ".claude"
    if (-not (Test-Path -LiteralPath $claudeDir)) { return @() }

    Get-ChildItem -Path $claudeDir -Filter "session-memory.md" -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -match '^\d{8}T\d{6}' } |
        Sort-Object LastWriteTime -Descending
}

function Estimate-SessionToolCallCount($sessionFile) {
    $content = Get-Content -LiteralPath $sessionFile.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return 0 }

    # Count tool-call markers broadly
    $patterns = @(
        '(?:Tool:|Bash|Read|Edit|Write|Glob|Grep|Search|Agent|Task|Think|WebSearch|WebFetch)'
    )
    $matches = [regex]::Matches($content, ($patterns -join '|'))
    return $matches.Count
}

# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------
$sessions = Get-SessionMemoryFiles $VaultRoot
$candidates = @()

foreach ($session in $sessions) {
    $toolCalls = Estimate-SessionToolCallCount $session
    if ($toolCalls -lt $MinToolCallsPerSession) { continue }

    $gapMinutes = ((Get-Date) - $session.LastWriteTime).TotalMinutes
    if ($gapMinutes -lt $MinGapMinutes) { continue }

    $candidates += [PSCustomObject]@{
        SessionFile = $session.FullName
        ToolCalls   = $toolCalls
        LastWriteTime = $session.LastWriteTime
        GapMinutes  = [math]::Round($gapMinutes, 1)
    }
}

if ($candidates.Count -eq 0) {
    Write-Output (@{ ok = $true; skipped = $true; reason = "no-candidates"; detail = "No sessions meet extraction criteria" } | ConvertTo-Json -Compress)
    return
}

if ($DryRun) {
    $candidatesJson = $candidates | ConvertTo-Json -Compress
    Write-Output (@{ ok = $true; dryRun = $true; candidates = $candidates.Count; toolCallsTotal = ($candidates | Measure-Object ToolCalls -Sum).Sum; detail = $candidatesJson } | ConvertTo-Json -Compress)
    return
}

# Build extraction prompt from candidates
$promptLines = @()
$promptLines += "# Background Memory Extraction Candidates"
$promptLines += ""
$promptLines += "The following sessions have high tool-call activity but may not have been captured in memory."
$promptLines += "For each, write a brief memory note about what was accomplished."
$promptLines += ""
$promptLines += "---"
foreach ($c in $candidates) {
    $promptLines += ""
    $promptLines += "## Session: $($c.SessionFile)"
    $promptLines += "Tool calls: $($c.ToolCalls) | Last active: $($c.GapMinutes) min ago"
    $content = Get-Content $c.SessionFile -Raw -ErrorAction SilentlyContinue
    $shortContent = if ($content.Length -gt 2000) { $content.Substring(0, 2000) + "`n[...truncated...]" } else { $content }
    $promptLines += $shortContent
    $promptLines += "---"
}

$proposal = $promptLines -join "`n"

# Write to inbox for the next Dream cycle to pick up
$header = "<!-- Generated: $(Get-Date -Format 'o') | type: auto-extraction | candidates: $($candidates.Count) -->"
$footer = "<!-- /AUTO-EXTRACTION -->"
$entry = "$header`n`n$proposal`n`n$footer"

if (-not (Test-Path -LiteralPath $InboxDir)) {
    New-Item -ItemType Directory -Path $InboxDir -Force | Out-Null
}
Add-Content -Path $InboxFile -Value "`n`n$entry" -Encoding UTF8

Write-Output (@{
    ok = $true
    extracted = $candidates.Count
    inboxFile = $InboxFile
    toolCallsTotal = ($candidates | Measure-Object ToolCalls -Sum).Sum
} | ConvertTo-Json -Compress)
