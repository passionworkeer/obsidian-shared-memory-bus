# scripts/extraction-stop-hook.ps1
# Claude Code Stop Hook: triggers extraction pipeline
#
# Claude Code passes JSON via stdin:
#   { "transcript_path": "...", "session_id": "...", "cwd": "..." }
#
# Configure in Claude Code settings.json as stop_hook.

param(
    [switch]$DryRun
)

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptRoot/..").Path

# Read JSON from stdin (Claude Code passes hook data here)
# Handle empty stdin in dry-run or error scenarios
$hookInput = $input | Out-String
$hookData = $null
if ($hookInput.Trim()) {
    try {
        $hookData = $hookInput | ConvertFrom-Json
    } catch {
        Write-Warning "[extraction-stop-hook] Failed to parse stdin JSON: $_"
    }
}

# Extract values (use defaults if not provided)
$TranscriptPath = $hookData.transcript_path
$SessionId = $hookData.session_id
$Cwd = $hookData.cwd

$Project = $null
if ($Cwd) {
    $Project = Split-Path -Leaf $Cwd
}
if (-not $Project) { $Project = "default" }

if ($DryRun) {
    Write-Host "[extraction-stop-hook] Dry run: transcript=$TranscriptPath project=$Project session=$SessionId"
    exit 0
}

if (-not $TranscriptPath) {
    Write-Error "[extraction-stop-hook] Error: transcript_path not provided"
    exit 1
}

if (-not (Test-Path -LiteralPath $TranscriptPath)) {
    Write-Error "[extraction-stop-hook] Error: transcript not found at $TranscriptPath"
    exit 1
}

# Bypass Claude Code's proxy for extraction pipeline LLM calls.
# Claude Code injects env vars (incl. ANTHROPIC_BASE_URL proxy) into all child
# processes. Unset HTTP_PROXY/HTTPS_PROXY so the pipeline reaches OpenAI directly.
Remove-Item Env:\HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:\HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:\http_proxy -ErrorAction SilentlyContinue
Remove-Item Env:\https_proxy -ErrorAction SilentlyContinue
Remove-Item Env:\ALL_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:\all_proxy -ErrorAction SilentlyContinue

node "$ProjectRoot\ops\extraction-pipeline.mjs" $TranscriptPath $Project $SessionId

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Error "[extraction-stop-hook] Pipeline failed with exit code $exitCode"
} else {
    Write-Host "[extraction-stop-hook] Extraction complete"
}

exit $exitCode