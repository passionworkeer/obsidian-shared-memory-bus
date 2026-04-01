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

# Copy from bundle subdirs → flat .ai-memory root
$dirMaps = @{
    "bus"       = @("*.ps1","*.js")
    "ops"       = @("*.ps1","*.js")
    "retrieval" = @("*.py","*.js","*.json")
}

foreach ($dir in $dirMaps.Keys) {
    $srcDir = Join-Path $sourceRoot $dir
    if (Test-Path -LiteralPath $srcDir -PathType Container) {
        $files = Get-ChildItem -LiteralPath $srcDir -Include $dirMaps[$dir] -Recurse -File -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $TargetRoot $file.Name) -Force
        }
    }
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
