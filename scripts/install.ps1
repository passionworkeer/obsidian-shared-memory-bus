param(
    [string]$TargetRoot = "$env:USERPROFILE\.ai-memory",
    [switch]$RegisterStartup = $true
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = $bundleRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

Ensure-Directory -Path $TargetRoot
Ensure-Directory -Path (Join-Path $TargetRoot "shared-mcp")

$resolvedTargetRoot = (Get-Item -LiteralPath $TargetRoot).FullName
$env:AI_MEMORY_ROOT = $resolvedTargetRoot
[Environment]::SetEnvironmentVariable("AI_MEMORY_ROOT", $resolvedTargetRoot, "User")

$copyFiles = @(
    "benchmark-embedding-backends.py",
    "cleanup-inbox.ps1",
    "generate-embeddings.js",
    "install-client-integrations.ps1",
    "memory-bus.ps1",
    "memory-watchdog.ps1",
    "obsidian-blackboard-daemon.js",
    "probe-embedding-models.py",
    "register-agent.ps1",
    "repair-codex-runtime.ps1",
    "run-minimax-mcp.ps1",
    "run-obsidian-mcp.ps1",
    "run-shared-stack-pressure-test.ps1",
    "semantic-search.js",
    "semantic-search.py",
    "sync-claudemem-to-obsidian.ps1",
    "sync-openclaw-to-obsidian.js",
    "sync-shared-skills.ps1",
    "verify-client-integrations.ps1"
)

foreach ($name in $copyFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $TargetRoot $name) -Force
}

$sharedMcpFiles = @(
    "manifest.json",
    "omni-memory-server.js",
    "package.json",
    "playwright-stdio-proxy.js",
    "singleton-stdio-mcp-proxy.mjs",
    "start-default-shared-mcp.ps1",
    "start-shared-mcp.ps1",
    "status-shared-mcp.ps1",
    "stop-shared-mcp.ps1",
    "write-config-snippets.ps1"
)

foreach ($name in $sharedMcpFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot ("shared-mcp\" + $name)) -Destination (Join-Path $TargetRoot ("shared-mcp\" + $name)) -Force
}

$packageLockPath = Join-Path $sourceRoot "shared-mcp\package-lock.json"
if (Test-Path -LiteralPath $packageLockPath -PathType Leaf) {
    Copy-Item -LiteralPath $packageLockPath -Destination (Join-Path $TargetRoot "shared-mcp\package-lock.json") -Force
}

$agentsTemplatePath = Join-Path $bundleRoot "templates\agents.json"
$targetAgentsPath = Join-Path $TargetRoot "agents.json"
if (-not (Test-Path -LiteralPath $targetAgentsPath)) {
    Copy-Item -LiteralPath $agentsTemplatePath -Destination $targetAgentsPath -Force
}

$npmCommand = Get-Command npm.cmd,npm -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npmCommand) {
    throw "npm was not found on PATH. Install Node.js before running this installer."
}

Push-Location (Join-Path $TargetRoot "shared-mcp")
try {
    & $npmCommand.Source install --omit=dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed in shared-mcp."
    }
} finally {
    Pop-Location
}

if ($RegisterStartup) {
    $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
    Ensure-Directory -Path $startupDir
    $watchdogVbsPath = Join-Path $startupDir "AI Memory Watchdog.vbs"
    $watchdogVbsContent = 'Set shell = CreateObject("Wscript.Shell")' + "`n" +
        ('command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{0}\memory-watchdog.ps1"" -Daemon -PollSeconds 15"' -f $TargetRoot) + "`n" +
        'shell.Run command, 0, False' + "`n"
    [System.IO.File]::WriteAllText($watchdogVbsPath, $watchdogVbsContent, $utf8NoBom)

    $sharedMcpVbsPath = Join-Path $startupDir "AI Shared MCP.vbs"
    $sharedMcpVbsContent = 'Set shell = CreateObject("Wscript.Shell")' + "`n" +
        ('command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{0}\shared-mcp\start-default-shared-mcp.ps1"""' -f $TargetRoot) + "`n" +
        'shell.Run command, 0, False' + "`n"
    [System.IO.File]::WriteAllText($sharedMcpVbsPath, $sharedMcpVbsContent, $utf8NoBom)
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $TargetRoot "memory-bus.ps1") -Action Generate | Out-Null
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $TargetRoot "shared-mcp\write-config-snippets.ps1") | Out-Null
Write-Output ("Installed shared-memory bus to {0}" -f $TargetRoot)
