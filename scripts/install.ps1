param(
    [string]$TargetRoot = "$env:USERPROFILE\.ai-memory",
    [switch]$RegisterStartup = $true,
    [bool]$PersistUserEnvironment = $true
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = $bundleRoot
$layoutPath = Join-Path $PSScriptRoot "install-layout.psd1"
$layout = Import-PowerShellDataFile -Path $layoutPath
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Normalize-RelativeInstallPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (($Path -replace '[/\\]+', '\').TrimStart('\'))
}

function Get-ManagedInstallFiles {
    param([Parameter(Mandatory = $true)]$Layout)

    $managedFiles = New-Object System.Collections.Generic.List[string]

    foreach ($sourceDir in @($Layout.FlatRuntimeFiles.Keys | Sort-Object)) {
        foreach ($name in @($Layout.FlatRuntimeFiles[$sourceDir])) {
            [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path $name))
        }
    }

    foreach ($name in @($Layout.SharedMcpFiles)) {
        [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path (Join-Path "shared-mcp" $name)))
    }

    return @($managedFiles | Sort-Object -Unique)
}

function Remove-ManagedFileIfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $targetPath = Join-Path $TargetRoot (Normalize-RelativeInstallPath -Path $RelativePath)
    if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
        Remove-Item -LiteralPath $targetPath -Force
    }
}

function Remove-StaleManagedFiles {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string[]]$CurrentManagedFiles,
        [string[]]$LegacyCleanupFiles = @()
    )

    $desiredLookup = @{}
    foreach ($path in @($CurrentManagedFiles)) {
        $desiredLookup[(Normalize-RelativeInstallPath -Path $path)] = $true
    }

    foreach ($path in @($LegacyCleanupFiles)) {
        Remove-ManagedFileIfPresent -TargetRoot $TargetRoot -RelativePath $path
    }

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        return
    }

    try {
        $previousManifest = Get-Content -Raw -LiteralPath $ManifestPath -Encoding utf8 | ConvertFrom-Json
    } catch {
        Write-Warning ("Skipping stale managed-file cleanup because install manifest could not be parsed: {0}" -f $ManifestPath)
        return
    }

    foreach ($path in @($previousManifest.managedFiles)) {
        $normalized = Normalize-RelativeInstallPath -Path $path
        if (-not $desiredLookup.ContainsKey($normalized)) {
            Remove-ManagedFileIfPresent -TargetRoot $TargetRoot -RelativePath $normalized
        }
    }
}

function Write-InstallManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string[]]$ManagedFiles,
        [string[]]$LegacyCleanupFiles = @(),
        [Parameter(Mandatory = $true)][string]$LayoutPath
    )

    $payload = [ordered]@{
        formatVersion      = 1
        installedAt        = (Get-Date).ToString("o")
        layoutFile         = (Split-Path -Leaf $LayoutPath)
        managedFiles       = @($ManagedFiles | Sort-Object -Unique)
        legacyCleanupFiles = @($LegacyCleanupFiles | Sort-Object -Unique)
    }

    $json = $payload | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($ManifestPath, $json, $utf8NoBom)
}

function Start-BackgroundRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return
    }

    Start-Process -FilePath "powershell.exe" `
        -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $ArgumentList) `
        -WindowStyle Hidden | Out-Null
}

function Get-UvManagedPythonCandidates {
    $uvPythonRoot = Join-Path $env:APPDATA "uv\python"
    if (-not (Test-Path -LiteralPath $uvPythonRoot -PathType Container)) {
        return @()
    }

    return @(
        Get-ChildItem -LiteralPath $uvPythonRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "python.exe" } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    )
}

function Resolve-PythonRuntime {
    param([switch]$InstallIfMissing)

    $explicit = [Environment]::GetEnvironmentVariable("AI_MEMORY_PYTHON", "Process")
    if (-not [string]::IsNullOrWhiteSpace($explicit) -and (Test-Path -LiteralPath $explicit -PathType Leaf)) {
        return (Get-Item -LiteralPath $explicit).FullName
    }

    foreach ($name in @("python", "python3")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source -and $command.Source -notmatch "WindowsApps") {
            return $command.Source
        }
    }

    foreach ($candidate in @(Get-UvManagedPythonCandidates)) {
        return (Get-Item -LiteralPath $candidate).FullName
    }

    $uvCommand = Get-Command uv.exe,uv -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uvCommand) {
        foreach ($version in @("3.11", "3.12", "3.13", "3.10")) {
            try {
                $candidate = (& $uvCommand.Source python find $version 2>$null | Select-Object -First 1)
                if ([string]::IsNullOrWhiteSpace($candidate)) {
                    $candidate = ""
                } else {
                    $candidate = $candidate.Trim()
                }
            } catch {
                $candidate = ""
            }

            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                return (Get-Item -LiteralPath $candidate).FullName
            }
        }

        if ($InstallIfMissing) {
            Write-Output "No usable Python runtime was detected. Installing managed Python 3.11 via uv..."
            & $uvCommand.Source python install 3.11
            if ($LASTEXITCODE -ne 0) {
                throw "uv python install 3.11 failed."
            }

            try {
                $candidate = (& $uvCommand.Source python find 3.11 2>$null | Select-Object -First 1)
                if ([string]::IsNullOrWhiteSpace($candidate)) {
                    $candidate = ""
                } else {
                    $candidate = $candidate.Trim()
                }
            } catch {
                $candidate = ""
            }

            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                return (Get-Item -LiteralPath $candidate).FullName
            }
        }
    }

    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE "AppData\Local\Programs\Python\Python313\python.exe"),
        (Join-Path $env:USERPROFILE "AppData\Local\Programs\Python\Python312\python.exe"),
        (Join-Path $env:USERPROFILE "AppData\Local\Programs\Python\Python311\python.exe"),
        "D:\python\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return $null
}

Ensure-Directory -Path $TargetRoot
Ensure-Directory -Path (Join-Path $TargetRoot "shared-mcp")

$resolvedTargetRoot = (Get-Item -LiteralPath $TargetRoot).FullName
$env:AI_MEMORY_ROOT = $resolvedTargetRoot
$resolvedPython = Resolve-PythonRuntime -InstallIfMissing
if (-not $resolvedPython) {
    throw "Could not resolve a usable Python runtime. Set AI_MEMORY_PYTHON or install Python (uv-managed Python is supported)."
}
$env:AI_MEMORY_PYTHON = $resolvedPython

$legacyCleanupFiles = if ($layout.ContainsKey("LegacyCleanupFiles")) {
    @($layout.LegacyCleanupFiles)
} else {
    @()
}
$managedInstallFiles = Get-ManagedInstallFiles -Layout $layout
$installManifestPath = Join-Path $TargetRoot "install-manifest.json"
Remove-StaleManagedFiles `
    -TargetRoot $TargetRoot `
    -ManifestPath $installManifestPath `
    -CurrentManagedFiles $managedInstallFiles `
    -LegacyCleanupFiles $legacyCleanupFiles

foreach ($sourceDir in @($layout.FlatRuntimeFiles.Keys | Sort-Object)) {
    foreach ($name in @($layout.FlatRuntimeFiles[$sourceDir])) {
        $srcPath = Join-Path $sourceRoot (Join-Path $sourceDir $name)
        if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
            throw "Install layout manifest references missing runtime file: $srcPath"
        }

        Copy-Item -LiteralPath $srcPath -Destination (Join-Path $TargetRoot $name) -Force
    }
}

foreach ($name in @($layout.SharedMcpFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "shared-mcp" $name)
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing shared-mcp file: $srcPath"
    }

    Copy-Item -LiteralPath $srcPath -Destination (Join-Path $TargetRoot (Join-Path "shared-mcp" $name)) -Force
}

foreach ($name in @($layout.TemplateFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "templates" $name)
    $dstPath = Join-Path $TargetRoot $name
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing template file: $srcPath"
    }

    if (-not (Test-Path -LiteralPath $dstPath)) {
        Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
    }
}

$npmCommand = Get-Command npm.cmd,npm -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npmCommand) {
    throw "npm was not found on PATH. Install Node.js before running this installer."
}

Push-Location (Join-Path $TargetRoot "shared-mcp")
try {
    $npmArgs = if (Test-Path -LiteralPath (Join-Path $TargetRoot "shared-mcp\package-lock.json") -PathType Leaf) {
        @("ci", "--omit=dev")
    } else {
        @("install", "--omit=dev")
    }

    & $npmCommand.Source @npmArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("npm {0} failed in shared-mcp." -f $npmArgs[0])
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
Write-InstallManifest `
    -ManifestPath $installManifestPath `
    -ManagedFiles $managedInstallFiles `
    -LegacyCleanupFiles $legacyCleanupFiles `
    -LayoutPath $layoutPath

if ($PersistUserEnvironment) {
    [Environment]::SetEnvironmentVariable("AI_MEMORY_ROOT", $resolvedTargetRoot, "User")
    [Environment]::SetEnvironmentVariable("AI_MEMORY_PYTHON", $resolvedPython, "User")
}

$shouldStartServicesNow = $RegisterStartup -and (-not $env:CI) -and (-not $env:GITHUB_ACTIONS)
if ($shouldStartServicesNow) {
    Start-BackgroundRuntime -ScriptPath (Join-Path $TargetRoot "memory-watchdog.ps1") -ArgumentList @("-Daemon", "-PollSeconds", "15")
    Start-BackgroundRuntime -ScriptPath (Join-Path $TargetRoot "shared-mcp\start-default-shared-mcp.ps1")
}

Write-Output ("Installed shared-memory bus to {0}" -f $TargetRoot)
