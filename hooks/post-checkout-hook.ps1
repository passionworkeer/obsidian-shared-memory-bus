#Requires -Version 7
<#
.SYNOPSIS
    post-checkout hook — refresh GLOBAL-CONTEXT if stale + detect new agent skills.
    Non-blocking: always exits 0.
.DESCRIPTION
    1. Detects if GLOBAL-CONTEXT.md is stale (compare sourceStructuredSignature)
    2. If stale, spawns build-memory-layers.js in background
    3. Detects new .agents/skills/*.md files not present in the previous checkout
.PARAMETER PrevHead
    Previous HEAD ref (git passes this automatically)
.PARAMETER NewHead
    New HEAD ref (git passes this automatically)
.PARAMETER CheckoutFlag
    1 = branch checkout, 0 = file checkout. Only triggers on branch checkout.
#>
param(
    [string]$PrevHead,
    [string]$NewHead,
    [int]$CheckoutFlag = 1
)

$ErrorActionPreference = 'SilentlyContinue'

# Only trigger on branch checkout (flag=1), not file checkout
if ($CheckoutFlag -ne 1) { exit 0 }

# Resolve workspace root
$WorkspaceRoot = $PSScriptRoot | Split-Path -Parent
if (-not (Test-Path "$WorkspaceRoot\.git")) {
    $candidates = @("$PSScriptRoot","$PSScriptRoot\..","$PSScriptRoot\..\..")
    foreach ($c in $candidates) { if (Test-Path "$c\.git") { $WorkspaceRoot = $c; break } }
}

$storeRoot = if ($env:AI_MEMORY_STORE) { $env:AI_MEMORY_STORE } elseif ($env:AI_MEMORY_OBSIDIAN_VAULT) { $env:AI_MEMORY_OBSIDIAN_VAULT } else { $null }
if (-not $storeRoot) { exit 0 }

# ── Step 1: Staleness check ───────────────────────────────────────────
$gctxFile = Join-Path $storeRoot "generated\GLOBAL-CONTEXT.md"
$gctxMetaFile = Join-Path $storeRoot "generated\GLOBAL-CONTEXT.meta.json"

$structDir = Join-Path $storeRoot "structured"
$stateDir  = Join-Path $storeRoot "state"

function Get-StructuredSignature {
    param([string]$StructDir)
    $sigParts = @()
    $jsonlFiles = Get-ChildItem -Path $StructDir -Filter "*.jsonl" -ErrorAction SilentlyContinue
    foreach ($f in $jsonlFiles) {
        $sigParts += "$($f.Name):$($f.LastWriteTimeUtc.ToString('yyyyMMddHHmmss'))"
    }
    $combined = $sigParts -join '|'
    # Simple hash for comparison (not cryptographic)
    $hash = [System.Security.Cryptography.SHA256]::ComputeHash([System.Text.Encoding]::UTF8.GetBytes($combined))
    [BitConverter]::ToString($hash).Replace('-', '').Substring(0, 16)
}

$currentSig = Get-StructuredSignature -StructDir $structDir

$isStale = $true
if (Test-Path $gctxMetaFile) {
    $meta = Get-Content $gctxMetaFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($meta.sourceStructuredSignature -and $meta.sourceStructuredSignature.hash -eq $currentSig) {
        $isStale = $false
    }
}

# ── Step 2: Trigger rebuild if stale ──────────────────────────────────
if ($isStale) {
    $buildScript = Join-Path $WorkspaceRoot "ops\build-memory-layers.js"
    if (Test-Path $buildScript) {
        $null = Start-Process -FilePath "node" -ArgumentList $buildScript,"--workspace",$WorkspaceRoot -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
    }
}

# ── Step 3: Detect new agent skill files ─────────────────────────────
$skillsDir = Join-Path $WorkspaceRoot ".agents\skills"
$skillStateFile = Join-Path $stateDir "known-agent-skills.json"
$knownSkills = @{}
if (Test-Path $skillStateFile) {
    $knownSkills = Get-Content $skillStateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
}
if (-not $knownSkills.PSObject.Properties.Name) { $knownSkills = @{} }

$newSkills = @()
if (Test-Path $skillsDir) {
    $currentSkillFiles = Get-ChildItem -Path $skillsDir -Filter "*.md" -ErrorAction SilentlyContinue
    foreach ($sf in $currentSkillFiles) {
        $name = $sf.Name
        if (-not $knownSkills[$name]) {
            $newSkills += $name
            $knownSkills[$name] = $sf.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
    }
    # Persist known skills state
    $null = New-Item -ItemType Directory -Force -Path $stateDir -ErrorAction SilentlyContinue
    $knownSkills | ConvertTo-Json -Depth 3 | Out-File -FilePath $skillStateFile -Encoding UTF8 -ErrorAction SilentlyContinue
}

# Log new skill discoveries (non-blocking, informational)
if ($newSkills.Count -gt 0) {
    $eventLog = Join-Path $structDir "agent-events.jsonl"
    $event = @{
        event = "new-agent-skill-discovered"
        skills = $newSkills
        head = $NewHead
        t = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    } | ConvertTo-Json -Compress
    $event | Out-File -FilePath $eventLog -Append -Encoding UTF8 -ErrorAction SilentlyContinue
}

exit 0
