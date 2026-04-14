# scripts/extraction-session-start.ps1
# Claude Code SessionStart Hook wrapper (PowerShell)
#
# Injects user identity + recent project facts into Claude Code context.
# Configure in Claude Code settings.json as session_start_hook.

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptRoot/..").Path

node "$ProjectRoot\scripts\extraction-session-start.mjs"