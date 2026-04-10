param(
    [string]$TargetRoot = "",
    [string]$WorkspaceRoot = "",
    $RegisterStartup = $true,
    $PersistUserEnvironment = $true,
    $InstallPythonDeps = $true,
    $ApplyClientIntegrations = $true,
    $IncludeOptionalClientServers = $false,
    [switch]$DryRun
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = $bundleRoot
$layoutPath = Join-Path $PSScriptRoot "install-layout.psd1"
$layout = Import-PowerShellDataFile -Path $layoutPath
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$platformHelperPath = Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1")
. $platformHelperPath

if ([string]::IsNullOrWhiteSpace($TargetRoot)) {
    $TargetRoot = Get-SharedDefaultAiMemoryRoot
} else {
    $TargetRoot = Resolve-SharedOptionalPathArgument -Path $TargetRoot -ParameterName "TargetRoot"
}

$WorkspaceRoot = Resolve-SharedOptionalPathArgument -Path $WorkspaceRoot -ParameterName "WorkspaceRoot" -RequireExisting

function ConvertTo-BooleanOption {
    param(
        [AllowNull()]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [bool]$Default = $true
    )

    if ($null -eq $Value) {
        return $Default
    }

    if ($Value -is [bool]) {
        return [bool]$Value
    }

    if ($Value -is [System.Management.Automation.SwitchParameter]) {
        return [bool]$Value.IsPresent
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Default
    }

    switch -Regex ($text.Trim().ToLowerInvariant()) {
        '^(1|true|yes|on)$' { return $true }
        '^(0|false|no|off)$' { return $false }
        default { throw "Invalid boolean value for -${Name}: $Value" }
    }
}

$RegisterStartup = ConvertTo-BooleanOption -Value $RegisterStartup -Name "RegisterStartup" -Default $true
$PersistUserEnvironment = ConvertTo-BooleanOption -Value $PersistUserEnvironment -Name "PersistUserEnvironment" -Default $true
$InstallPythonDeps = ConvertTo-BooleanOption -Value $InstallPythonDeps -Name "InstallPythonDeps" -Default $true
$ApplyClientIntegrations = ConvertTo-BooleanOption -Value $ApplyClientIntegrations -Name "ApplyClientIntegrations" -Default $true
$IncludeOptionalClientServers = ConvertTo-BooleanOption -Value $IncludeOptionalClientServers -Name "IncludeOptionalClientServers" -Default $false

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Normalize-RelativeInstallPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $separator = [System.IO.Path]::DirectorySeparatorChar
    return (($Path -replace '[/\\]+', [string]$separator).TrimStart('\', '/'))
}

function Get-ManagedInstallFiles {
    param([Parameter(Mandatory = $true)]$Layout)

    $managedFiles = New-Object System.Collections.Generic.List[string]
    $cliFiles = if ($Layout.ContainsKey("CliFiles")) { @($Layout.CliFiles) } else { @() }

    foreach ($sourceDir in @($Layout.FlatRuntimeFiles.Keys | Sort-Object)) {
        foreach ($name in @($Layout.FlatRuntimeFiles[$sourceDir])) {
            [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path $name))
        }
    }

    foreach ($name in @($Layout.SharedMcpFiles)) {
        [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path (Join-Path "shared-mcp" $name)))
    }

    foreach ($name in @(Get-GeneratedShellWrapperFiles -Layout $Layout)) {
        [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path $name))
    }

    foreach ($name in @("activate-ai-memory.sh", "activate-ai-memory.ps1")) {
        [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path $name))
    }

    foreach ($name in @($cliFiles)) {
        [void]$managedFiles.Add((Normalize-RelativeInstallPath -Path $name))
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

function Remove-ManagedDirectoryIfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $targetPath = Join-Path $TargetRoot (Normalize-RelativeInstallPath -Path $RelativePath)
    if (Test-Path -LiteralPath $targetPath -PathType Container) {
        Remove-Item -LiteralPath $targetPath -Force -Recurse
    }
}

function Remove-StaleManagedFiles {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string[]]$CurrentManagedFiles,
        [string[]]$LegacyCleanupFiles = @(),
        [string[]]$LegacyCleanupDirectories = @()
    )

    $desiredLookup = @{}
    foreach ($path in @($CurrentManagedFiles)) {
        $desiredLookup[(Normalize-RelativeInstallPath -Path $path)] = $true
    }

    foreach ($path in @($LegacyCleanupFiles)) {
        Remove-ManagedFileIfPresent -TargetRoot $TargetRoot -RelativePath $path
    }

    foreach ($path in @($LegacyCleanupDirectories)) {
        Remove-ManagedDirectoryIfPresent -TargetRoot $TargetRoot -RelativePath $path
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

function Set-PosixExecutableIfNeeded {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-SharedIsWindows) {
        return
    }

    if ([System.IO.Path]::GetExtension($Path) -ne ".sh") {
        return
    }

    $chmodCommand = Get-Command chmod -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $chmodCommand) {
        throw "chmod was not found on PATH. Unable to mark installed shell wrapper as executable: $Path"
    }

    & $chmodCommand.Source "+x" $Path
    if ($LASTEXITCODE -ne 0) {
        throw "chmod +x failed for installed shell wrapper: $Path"
    }
}

function Get-GeneratedShellWrapperFiles {
    param([Parameter(Mandatory = $true)]$Layout)

    $wrapperFiles = New-Object System.Collections.Generic.List[string]
    foreach ($sourceDir in @($Layout.FlatRuntimeFiles.Keys | Sort-Object)) {
        foreach ($name in @($Layout.FlatRuntimeFiles[$sourceDir])) {
            if ([System.IO.Path]::GetExtension($name) -ne ".ps1") {
                continue
            }

            $wrapperFiles.Add(([System.IO.Path]::ChangeExtension($name, ".sh"))) | Out-Null
        }
    }

    return @($wrapperFiles | Sort-Object -Unique)
}

function New-PosixWrapperContent {
    param([Parameter(Mandatory = $true)][string]$TargetScriptName)

    $template = @'
#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PWSH_BIN="${AI_MEMORY_PWSH:-}"
IS_WINDOWS_WRAPPER=0
case "${OS:-}" in
  Windows_NT) IS_WINDOWS_WRAPPER=1 ;;
esac
case "$(uname -s 2>/dev/null || printf '')" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS_WRAPPER=1 ;;
esac

if [ "$IS_WINDOWS_WRAPPER" -eq 1 ]; then
  if [ -z "$PWSH_BIN" ]; then
    PWSH_BIN="powershell.exe"
  fi
  exec "$PWSH_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/__TARGET_SCRIPT__" "$@"
fi

if [ -z "$PWSH_BIN" ]; then
  PWSH_BIN="pwsh"
fi

exec "$PWSH_BIN" -NoProfile -File "$SCRIPT_DIR/__TARGET_SCRIPT__" "$@"
'@
    return $template.Replace("__TARGET_SCRIPT__", $TargetScriptName).Trim() + "`n"
}

function Write-GeneratedShellWrappers {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string[]]$WrapperFiles
    )

    foreach ($relativeWrapperPath in @($WrapperFiles)) {
        $wrapperPath = Join-Path $TargetRoot $relativeWrapperPath
        $scriptName = [System.IO.Path]::ChangeExtension((Split-Path -Leaf $relativeWrapperPath), ".ps1")
        Ensure-Directory -Path (Split-Path -Parent $wrapperPath)
        [System.IO.File]::WriteAllText($wrapperPath, (New-PosixWrapperContent -TargetScriptName $scriptName), $utf8NoBom)
        Set-PosixExecutableIfNeeded -Path $wrapperPath
    }
}

function Write-EnvironmentActivationFiles {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$ResolvedTargetRoot,
        [Parameter(Mandatory = $true)][string]$ResolvedPython,
        [string]$ResolvedSharedMcpPython = ""
    )

    $activateShPath = Join-Path $TargetRoot "activate-ai-memory.sh"
    $activatePs1Path = Join-Path $TargetRoot "activate-ai-memory.ps1"

    $shContent = @"
#!/usr/bin/env sh
export AI_MEMORY_ROOT="$ResolvedTargetRoot"
export AI_MEMORY_PYTHON="$ResolvedPython"
"@.Trim() + "`n"
    if (-not [string]::IsNullOrWhiteSpace($ResolvedSharedMcpPython)) {
        $shContent = $shContent.TrimEnd() + "`n" + ('export AI_MEMORY_MCP_PYTHON="{0}"' -f $ResolvedSharedMcpPython) + "`n"
    }
    [System.IO.File]::WriteAllText($activateShPath, $shContent, $utf8NoBom)
    Set-PosixExecutableIfNeeded -Path $activateShPath

    $ps1Content = @"
\$env:AI_MEMORY_ROOT = "$ResolvedTargetRoot"
\$env:AI_MEMORY_PYTHON = "$ResolvedPython"
"@.Trim() + "`n"
    if (-not [string]::IsNullOrWhiteSpace($ResolvedSharedMcpPython)) {
        $ps1Content = $ps1Content.TrimEnd() + "`n" + ('$env:AI_MEMORY_MCP_PYTHON = "{0}"' -f $ResolvedSharedMcpPython) + "`n"
    }
    [System.IO.File]::WriteAllText($activatePs1Path, $ps1Content, $utf8NoBom)
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

    $workingDirectory = Split-Path -Parent $ScriptPath
    if (Test-SharedIsWindows) {
        Start-SharedWindowsDetachedPowerShellFile -ScriptPath $ScriptPath -ArgumentList $ArgumentList -WorkingDirectory $workingDirectory | Out-Null
        return
    }

    Start-SharedPowerShellFile -ScriptPath $ScriptPath -ArgumentList $ArgumentList -WorkingDirectory $workingDirectory | Out-Null
}

function Stop-ManagedRuntimeBeforeInstall {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) {
        return
    }

    $watchdogStatePath = Join-Path $TargetRoot "watchdog-state.json"
    if (Test-Path -LiteralPath $watchdogStatePath -PathType Leaf) {
        try {
            $watchdogState = Get-Content -Raw -LiteralPath $watchdogStatePath -Encoding utf8 | ConvertFrom-Json
            $watchdogPid = if ($null -ne $watchdogState.pid) { [int]$watchdogState.pid } else { 0 }
            if ($watchdogPid -gt 0) {
                Stop-SharedProcessTree -ProcessId $watchdogPid
            }
        } catch {
            Write-Warning ("Unable to stop previous watchdog from {0}: {1}" -f $watchdogStatePath, $_.Exception.Message)
        }
    }

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        return
    }

    try {
        $manifest = Get-Content -Raw -LiteralPath $ManifestPath -Encoding utf8 | ConvertFrom-Json
        foreach ($server in @($manifest.servers)) {
            if (-not ($server.PSObject.Properties.Name -contains "port")) {
                continue
            }

            foreach ($listenerPid in @(Get-SharedListeningProcessIds -Port ([int]$server.port))) {
                if ([int]$listenerPid -gt 0) {
                    Stop-SharedProcessTree -ProcessId ([int]$listenerPid)
                }
            }
        }
    } catch {
        Write-Warning ("Unable to stop previous shared MCP listeners before install: {0}" -f $_.Exception.Message)
    }

    Start-Sleep -Milliseconds 750
}

function Get-UvManagedPythonCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]
    $roots = @()

    if (Test-SharedIsWindows) {
        $roots += (Join-SharedPath @((Get-SharedConfigHome), "uv", "python"))
    } else {
        $roots += (Join-SharedPath @((Get-SharedDataHome), "uv", "python"))
    }

    foreach ($uvPythonRoot in @($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $uvPythonRoot -PathType Container)) {
            continue
        }

        foreach ($candidate in @(
            Get-ChildItem -LiteralPath $uvPythonRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object {
                    if (Test-SharedIsWindows) {
                        Join-SharedPath @($_.FullName, "python.exe")
                    } else {
                        Join-SharedPath @($_.FullName, "bin", "python3")
                    }
                } |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
        )) {
            $candidates.Add($candidate) | Out-Null
        }
    }

    return @($candidates | Select-Object -Unique)
}

function Resolve-PythonRuntime {
    param([switch]$InstallIfMissing)

    $resolved = Resolve-SharedPythonRuntime
    if (-not [string]::IsNullOrWhiteSpace($resolved)) {
        return $resolved
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

            if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-SharedPythonUsable -PythonPath $candidate)) {
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

            if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-SharedPythonUsable -PythonPath $candidate)) {
                return (Get-Item -LiteralPath $candidate).FullName
            }
        }
    }

    return $null
}

function Test-PythonVersionAtLeast {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [int]$Major = 3,
        [int]$Minor = 10
    )

    return (Test-SharedPythonUsable -PythonPath $PythonPath -Major $Major -Minor $Minor)
}

function Resolve-SharedMcpPythonRuntime {
    param([string]$PrimaryPythonPath = "")

    $processOverride = [Environment]::GetEnvironmentVariable("AI_MEMORY_MCP_PYTHON", "Process")
    if (-not [string]::IsNullOrWhiteSpace($processOverride) -and (Test-PythonVersionAtLeast -PythonPath $processOverride)) {
        return (Get-Item -LiteralPath $processOverride).FullName
    }

    $userOverride = [Environment]::GetEnvironmentVariable("AI_MEMORY_MCP_PYTHON", "User")
    if (-not [string]::IsNullOrWhiteSpace($userOverride) -and (Test-PythonVersionAtLeast -PythonPath $userOverride)) {
        return (Get-Item -LiteralPath $userOverride).FullName
    }

    $resolved = Resolve-SharedPythonRuntime -Major 3 -Minor 10 -ExtraCandidates @($PrimaryPythonPath)
    if (-not [string]::IsNullOrWhiteSpace($resolved)) {
        return $resolved
    }

    return $null
}

function Get-PythonPackageInstallExtraArgs {
    $indexUrl = Get-SharedEnvValue -Name "AI_MEMORY_PIP_INDEX_URL"
    if ([string]::IsNullOrWhiteSpace($indexUrl)) {
        $indexUrl = Get-SharedEnvValue -Name "PIP_INDEX_URL"
    }

    if ([string]::IsNullOrWhiteSpace($indexUrl)) {
        return @()
    }

    return @("--index-url", $indexUrl.Trim())
}

function Ensure-SharedMcpPythonDependencies {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        Write-Warning ("Skipping shared MCP Python dependency bootstrap because the runtime path does not exist: {0}" -f $PythonPath)
        return
    }

    if (-not (Test-PythonVersionAtLeast -PythonPath $PythonPath -Major 3 -Minor 10)) {
        Write-Warning ("Skipping shared MCP Python dependency bootstrap because {0} is below Python 3.10." -f $PythonPath)
        return
    }

    $moduleToPackage = [ordered]@{
        "mcp_server_fetch" = "mcp-server-fetch"
        "mcp_server_time"  = "mcp-server-time"
    }

    $probeScript = @'
import importlib.util
import json
import sys

print(json.dumps({name: bool(importlib.util.find_spec(name)) for name in sys.argv[1:]}))
'@

    $availabilityJson = ""
    try {
        $availabilityJson = & $PythonPath -c $probeScript @($moduleToPackage.Keys)
    } catch {
        $availabilityJson = ""
    }

    $availability = $null
    if (-not [string]::IsNullOrWhiteSpace($availabilityJson)) {
        try {
            $availability = $availabilityJson | ConvertFrom-Json
        } catch {
            $availability = $null
        }
    }

    $missingPackages = New-Object System.Collections.Generic.List[string]
    foreach ($moduleName in @($moduleToPackage.Keys)) {
        $isInstalled = $false
        if ($availability -and $null -ne $availability.PSObject.Properties[$moduleName]) {
            $isInstalled = [bool]$availability.$moduleName
        }
        if (-not $isInstalled) {
            $missingPackages.Add([string]$moduleToPackage[$moduleName]) | Out-Null
        }
    }

    if ($missingPackages.Count -eq 0) {
        return
    }

    try {
        & $PythonPath -m pip --version 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) {
            & $PythonPath -m ensurepip --upgrade 1>$null 2>$null
        }
    } catch {
        Write-Warning ("Shared MCP Python dependency bootstrap could not ensure pip for {0}: {1}" -f $PythonPath, $_.Exception.Message)
    }

    $installSucceeded = $false
    $installError = ""

    try {
        $pipExtraArgs = @(Get-PythonPackageInstallExtraArgs)
        & $PythonPath -m pip install "--user" "--disable-pip-version-check" "--no-input" @($pipExtraArgs) @($missingPackages)
        if ($LASTEXITCODE -ne 0) {
            throw "python -m pip install failed"
        }
        $installSucceeded = $true
        Write-Output ("Installed shared MCP Python dependencies: {0}" -f ([string]::Join(", ", @($missingPackages))))
    } catch {
        $installSucceeded = $false
        $installError = $_.Exception.Message
    }

    if (-not $installSucceeded) {
        Write-Warning (
            "Shared MCP Python dependencies remain degraded. Missing packages: {0}. Error: {1}" -f
            ([string]::Join(", ", @($missingPackages))),
            $installError
        )
    }
}

function Ensure-PythonRetrievalDependencies {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        Write-Warning ("Skipping Python dependency bootstrap because the runtime path does not exist: {0}" -f $PythonPath)
        return
    }

    $moduleToPackage = [ordered]@{
        "rank_bm25" = "rank-bm25"
        "jieba"     = "jieba"
    }

    $probeScript = @'
import importlib.util
import json
import sys

print(json.dumps({name: bool(importlib.util.find_spec(name)) for name in sys.argv[1:]}))
'@

    $availabilityJson = ""
    try {
        $availabilityJson = & $PythonPath -c $probeScript @($moduleToPackage.Keys)
    } catch {
        $availabilityJson = ""
    }

    $availability = $null
    if (-not [string]::IsNullOrWhiteSpace($availabilityJson)) {
        try {
            $availability = $availabilityJson | ConvertFrom-Json
        } catch {
            $availability = $null
        }
    }

    $missingPackages = New-Object System.Collections.Generic.List[string]
    foreach ($moduleName in @($moduleToPackage.Keys)) {
        $isInstalled = $false
        if ($availability -and $null -ne $availability.PSObject.Properties[$moduleName]) {
            $isInstalled = [bool]$availability.$moduleName
        }
        if (-not $isInstalled) {
            $missingPackages.Add([string]$moduleToPackage[$moduleName]) | Out-Null
        }
    }

    if ($missingPackages.Count -eq 0) {
        return
    }

    try {
        & $PythonPath -m pip --version 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) {
            & $PythonPath -m ensurepip --upgrade 1>$null 2>$null
        }
    } catch {
        Write-Warning ("Python dependency bootstrap could not ensure pip for {0}: {1}" -f $PythonPath, $_.Exception.Message)
    }

    $uvCommand = Get-Command uv.exe,uv -ErrorAction SilentlyContinue | Select-Object -First 1
    $installSucceeded = $false
    $installError = ""

    try {
        if ($uvCommand) {
            try {
                $pipExtraArgs = @(Get-PythonPackageInstallExtraArgs)
                & $uvCommand.Source "pip" "install" "--python" $PythonPath "--no-progress" @($pipExtraArgs) @($missingPackages)
                if ($LASTEXITCODE -eq 0) {
                    $installSucceeded = $true
                }
            } catch {
                $installSucceeded = $false
            }
        }

        if (-not $installSucceeded) {
            $pipExtraArgs = @(Get-PythonPackageInstallExtraArgs)
            & $PythonPath -m pip install "--user" "--disable-pip-version-check" "--no-input" @($pipExtraArgs) @($missingPackages)
            if ($LASTEXITCODE -ne 0) {
                throw "python -m pip install failed"
            }
            $installSucceeded = $true
        }

        Write-Output ("Installed shared-memory Python retrieval dependencies: {0}" -f ([string]::Join(", ", @($missingPackages))))
    } catch {
        $installSucceeded = $false
        $installError = $_.Exception.Message
    }

    if (-not $installSucceeded) {
        Write-Warning (
            "Shared-memory Python retrieval dependencies remain degraded. Missing packages: {0}. Error: {1}" -f
            ([string]::Join(", ", @($missingPackages))),
            $installError
        )
    }
}

function ConvertTo-XmlSafeText {
    param([AllowEmptyString()][string]$Value)

    return [System.Security.SecurityElement]::Escape([string]$Value)
}

function ConvertTo-DesktopExecArgument {
    param([AllowEmptyString()][string]$Value)

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return '""'
    }
    if ($text -notmatch '[\s"\\]') {
        return $text
    }
    return '"' + ($text -replace '(\\|")', '\\$1') + '"'
}

function Join-DesktopExecArguments {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    return [string]::Join(" ", @($Arguments | ForEach-Object { ConvertTo-DesktopExecArgument -Value $_ }))
}

function Get-StartupEnvironmentVariables {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellExe
    )

    $entries = [ordered]@{}
    if (-not (Test-SharedIsWindows)) {
        $pathSeparator = [string][System.IO.Path]::PathSeparator
        $pathEntries = New-Object System.Collections.Generic.List[string]
        foreach ($source in @(
            [string]$env:PATH,
            (Join-SharedPath @((Get-SharedUserHome), ".local", "bin")),
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin"
        )) {
            if ([string]::IsNullOrWhiteSpace($source)) {
                continue
            }
            foreach ($piece in ([string]$source).Split($pathSeparator)) {
                $clean = [string]$piece
                if ([string]::IsNullOrWhiteSpace($clean)) {
                    continue
                }
                if (-not $pathEntries.Contains($clean)) {
                    $pathEntries.Add($clean) | Out-Null
                }
            }
        }

        $entries["PATH"] = [string]::Join($pathSeparator, @($pathEntries))
    }

    $entries["AI_MEMORY_ROOT"] = $TargetRoot
    $pythonPath = Get-SharedEnvValue -Name "AI_MEMORY_PYTHON"
    if (-not [string]::IsNullOrWhiteSpace($pythonPath)) {
        $entries["AI_MEMORY_PYTHON"] = $pythonPath
    }
    $sharedMcpPythonPath = Get-SharedEnvValue -Name "AI_MEMORY_MCP_PYTHON"
    if (-not [string]::IsNullOrWhiteSpace($sharedMcpPythonPath)) {
        $entries["AI_MEMORY_MCP_PYTHON"] = $sharedMcpPythonPath
    }
    if (-not (Test-SharedIsWindows)) {
        $entries["AI_MEMORY_PWSH"] = $PowerShellExe
    }
    return $entries
}

function ConvertTo-PlistEnvironmentXml {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Variables)

    if ($Variables.Count -eq 0) {
        return ""
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("  <key>EnvironmentVariables</key>") | Out-Null
    $lines.Add("  <dict>") | Out-Null
    foreach ($key in @($Variables.Keys)) {
        $lines.Add("    <key>$(ConvertTo-XmlSafeText $key)</key>") | Out-Null
        $lines.Add("    <string>$(ConvertTo-XmlSafeText $Variables[$key])</string>") | Out-Null
    }
    $lines.Add("  </dict>") | Out-Null
    return [string]::Join("`n", @($lines))
}

function ConvertTo-SystemdEnvironmentLines {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Variables)

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($Variables.Keys)) {
        $escapedValue = ([string]$Variables[$key] -replace '(\\|")', '\\$1')
        $lines.Add(('Environment="{0}={1}"' -f $key, $escapedValue)) | Out-Null
    }
    return [string]::Join("`n", @($lines))
}

function Test-SystemdUserAvailable {
    if (-not (Test-SharedIsLinux)) {
        return $false
    }

    $systemctl = Get-Command systemctl -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $systemctl) {
        return $false
    }

    try {
        & $systemctl.Source --user show-environment 1>$null 2>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Write-XdgAutostartEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ExecLine
    )

    Ensure-Directory -Path $Directory
    $desktopPath = Join-Path $Directory $FileName
    $content = @"
[Desktop Entry]
Type=Application
Version=1.0
Name=$Name
Exec=$ExecLine
Terminal=false
X-GNOME-Autostart-enabled=true
"@
    [System.IO.File]::WriteAllText($desktopPath, $content.Trim() + "`n", $utf8NoBom)
}

function ConvertTo-VbsStringLiteral {
    param([AllowEmptyString()][string]$Value)

    return ([string]$Value -replace '"', '""')
}

function New-VbsEnvironmentAssignments {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Variables)

    $lines = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Variables -or $Variables.Count -eq 0) {
        return @($lines)
    }

    $lines.Add('Set env = shell.Environment("Process")') | Out-Null
    foreach ($key in @($Variables.Keys)) {
        $escapedKey = ConvertTo-VbsStringLiteral -Value ([string]$key)
        $escapedValue = ConvertTo-VbsStringLiteral -Value ([string]$Variables[$key])
        $lines.Add(('env("{0}") = "{1}"' -f $escapedKey, $escapedValue)) | Out-Null
    }

    return @($lines)
}

function ConvertTo-WindowsCommandLine {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add($FilePath) | Out-Null
    foreach ($argument in @($Arguments)) {
        $parts.Add([string]$argument) | Out-Null
    }

    return (Join-SharedWindowsProcessArguments -Arguments $parts.ToArray())
}

function Test-WindowsStartupScriptHostRunning {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-SharedIsWindows)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return $false
    }

    $fullPath = (Get-Item -LiteralPath $ScriptPath).FullName.ToLowerInvariant()
    $scriptName = [System.IO.Path]::GetFileName($fullPath)

    $matches = @(
        Get-CimInstance Win32_Process -Filter "Name='wscript.exe' or Name='cscript.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) {
                    return $false
                }

                $lowered = $commandLine.ToLowerInvariant()
                return $lowered.Contains($fullPath) -or $lowered.Contains($scriptName)
            }
    )

    return $matches.Count -gt 0
}

function Stop-WindowsStartupScriptHosts {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-SharedIsWindows)) {
        return
    }

    if ([string]::IsNullOrWhiteSpace($ScriptPath)) {
        return
    }

    $fullPath = [System.IO.Path]::GetFullPath($ScriptPath).ToLowerInvariant()
    $scriptName = [System.IO.Path]::GetFileName($fullPath)

    foreach ($process in @(
            Get-CimInstance Win32_Process -Filter "Name='wscript.exe' or Name='cscript.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $commandLine = [string]$_.CommandLine
                    if ([string]::IsNullOrWhiteSpace($commandLine)) {
                        return $false
                    }

                    $lowered = $commandLine.ToLowerInvariant()
                    return $lowered.Contains($fullPath) -or $lowered.Contains($scriptName)
                }
        )) {
        try {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Write-WindowsHiddenLauncherVbs {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [System.Collections.IDictionary]$Environment = $null
    )

    $command = ConvertTo-WindowsCommandLine -FilePath $FilePath -Arguments $Arguments
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('Set shell = CreateObject("Wscript.Shell")') | Out-Null
    foreach ($line in @(New-VbsEnvironmentAssignments -Variables $Environment)) {
        $lines.Add($line) | Out-Null
    }
    $lines.Add(('command = "{0}"' -f (ConvertTo-VbsStringLiteral -Value $command))) | Out-Null
    $lines.Add('shell.Run command, 0, False') | Out-Null
    $content = [string]::Join([Environment]::NewLine, @($lines)) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

function Repair-OpenClawStartupEntry {
    param([Parameter(Mandatory = $true)][string]$CurrentOpenClawHome)

    $result = [ordered]@{
        configured = $false
        launcherPath = ""
        reason = ""
        error = ""
        removedEntries = New-Object System.Collections.Generic.List[string]
    }

    if (-not (Test-SharedIsWindows)) {
        return [pscustomobject]$result
    }

    try {
        $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
        Ensure-Directory -Path $startupDir

        $openClawVbsPath = Join-Path $startupDir "OpenClaw.vbs"
        $startGatewayPath = Join-SharedPath @($CurrentOpenClawHome, "start-gateway.ps1")
        $legacyEntryPaths = @(
            (Join-Path $startupDir "OpenClaw.lnk"),
            (Join-Path $startupDir "OpenClaw Gateway.lnk"),
            (Join-Path $startupDir "OpenClaw Gateway.cmd"),
            (Join-Path $startupDir "OpenClaw.cmd"),
            (Join-Path $startupDir "OpenClaw.ps1")
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

        foreach ($legacyEntryPath in @($legacyEntryPaths)) {
            if (Test-Path -LiteralPath $legacyEntryPath -PathType Leaf) {
                Remove-Item -LiteralPath $legacyEntryPath -Force -ErrorAction SilentlyContinue
                $result.removedEntries.Add($legacyEntryPath) | Out-Null
            }
            Stop-WindowsStartupScriptHosts -ScriptPath $legacyEntryPath
        }

        if (-not (Test-Path -LiteralPath $startGatewayPath -PathType Leaf)) {
            if (Test-Path -LiteralPath $openClawVbsPath -PathType Leaf) {
                Remove-Item -LiteralPath $openClawVbsPath -Force -ErrorAction SilentlyContinue
                $result.removedEntries.Add($openClawVbsPath) | Out-Null
            }
            Stop-WindowsStartupScriptHosts -ScriptPath $openClawVbsPath
            $result.reason = "openclaw-start-gateway-missing"
            return [pscustomobject]$result
        }

        $powerShellExe = Resolve-SharedPowerShellExecutable
        $gatewayArgs = Get-SharedPowerShellFileArguments -ScriptPath $startGatewayPath -ArgumentList @()
        Write-WindowsHiddenLauncherVbs -Path $openClawVbsPath -FilePath $powerShellExe -Arguments $gatewayArgs
        $result.configured = $true
        $result.launcherPath = $openClawVbsPath
        $result.reason = "openclaw-hidden-vbs"
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Test-WindowsPowerShellScriptRunning {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-SharedIsWindows)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return $false
    }

    $fullPath = (Get-Item -LiteralPath $ScriptPath).FullName.ToLowerInvariant()
    return @(
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) {
                    return $false
                }

                $lowered = $commandLine.ToLowerInvariant()
                return $lowered.Contains("-file") -and $lowered.Contains($fullPath)
            }
    ).Count -gt 0
}

function Write-LegacyOpenClawGatewayShim {
    param(
        [Parameter(Mandatory = $true)][string]$LegacyActionPath,
        [Parameter(Mandatory = $true)][string]$CurrentOpenClawHome
    )

    $result = [ordered]@{
        created = $false
        path = $LegacyActionPath
        target = ""
        error = ""
    }

    try {
        $extension = [System.IO.Path]::GetExtension($LegacyActionPath).ToLowerInvariant()
        $currentStartGatewayPath = Join-SharedPath @($CurrentOpenClawHome, "start-gateway.ps1")
        if (-not (Test-Path -LiteralPath $currentStartGatewayPath -PathType Leaf)) {
            $result.error = "current-start-gateway-missing"
            return [pscustomobject]$result
        }

        $parentPath = Split-Path -Parent $LegacyActionPath
        if ([string]::IsNullOrWhiteSpace($parentPath)) {
            $result.error = "legacy-action-parent-missing"
            return [pscustomobject]$result
        }

        Ensure-Directory -Path $parentPath
        $result.target = $currentStartGatewayPath

        switch ($extension) {
            ".cmd" {
                $shimContent = @"
@echo off
setlocal
set "TARGET_PS1=$currentStartGatewayPath"
if exist "%TARGET_PS1%" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%TARGET_PS1%" >nul 2>nul
)
exit /b 0
"@.Trim() + "`r`n"
                [System.IO.File]::WriteAllText($LegacyActionPath, $shimContent, $utf8NoBom)
                $result.created = $true
            }
            ".ps1" {
                $shimContent = @"
\$ErrorActionPreference = "SilentlyContinue"
\$target = "$currentStartGatewayPath"
if (Test-Path -LiteralPath \$target -PathType Leaf) {
    Start-Process powershell.exe -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", \$target
    ) -WindowStyle Hidden | Out-Null
}
"@.Trim() + "`r`n"
                [System.IO.File]::WriteAllText($LegacyActionPath, $shimContent, $utf8NoBom)
                $result.created = $true
            }
            default {
                $result.error = "unsupported-legacy-openclaw-action-extension:$extension"
            }
        }
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Write-OpenClawGatewayAdminRepairScript {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [string]$ActionPath = ""
    )

    $result = [ordered]@{
        created = $false
        path = ""
        error = ""
    }

    if (-not (Test-SharedIsWindows)) {
        return [pscustomobject]$result
    }

    try {
        $reportsDir = Join-Path $TargetRoot "reports"
        Ensure-Directory -Path $reportsDir
        $scriptPath = Join-Path $reportsDir "repair-openclaw-gateway.admin.ps1"
        $actionComment = if ([string]::IsNullOrWhiteSpace($ActionPath)) { "" } else { "# Observed stale action path: $ActionPath`r`n" }
        $scriptContent = @"
`$ErrorActionPreference = "Stop"
$actionComment`$taskName = "OpenClaw Gateway"
`$task = Get-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue
if (`$null -eq `$task) {
    Write-Output "OpenClaw Gateway task not found."
    return
}

try {
    Disable-ScheduledTask -TaskName `$taskName -ErrorAction SilentlyContinue | Out-Null
} catch {
}

try {
    Unregister-ScheduledTask -TaskName `$taskName -Confirm:`$false -ErrorAction Stop | Out-Null
    Write-Output "Removed OpenClaw Gateway."
    return
} catch {
}

& schtasks /Delete /TN `$taskName /F
if (`$LASTEXITCODE -ne 0) {
    throw "schtasks /Delete failed with exit code `$LASTEXITCODE"
}

Write-Output "Removed OpenClaw Gateway."
"@.Trim() + "`r`n"
        [System.IO.File]::WriteAllText($scriptPath, $scriptContent, $utf8NoBom)
        $result.created = $true
        $result.path = $scriptPath
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Disable-StaleOpenClawGatewayTask {
    param([string]$TargetRoot = "")

    $result = [ordered]@{
        taskFound = $false
        stale = $false
        disabled = $false
        shimCreated = $false
        shimPath = ""
        shimTarget = ""
        shimError = ""
        actionPath = ""
        reason = ""
        disableError = ""
        repairScriptCreated = $false
        repairScriptPath = ""
        repairScriptError = ""
        error = ""
    }

    if (-not (Test-SharedIsWindows)) {
        return [pscustomobject]$result
    }

    try {
        $task = Get-ScheduledTask -TaskName "OpenClaw Gateway" -ErrorAction SilentlyContinue
        if ($null -eq $task) {
            return [pscustomobject]$result
        }

        $result.taskFound = $true
        $openClawHome = Join-SharedPath @((Get-SharedUserHome), ".openclaw")
        $expectedActionPaths = @(
            (Join-SharedPath @($openClawHome, "gateway.cmd")),
            (Join-SharedPath @($openClawHome, "start-gateway.ps1"))
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            try {
                [System.IO.Path]::GetFullPath($_).ToLowerInvariant()
            } catch {
                ([string]$_).Trim().ToLowerInvariant()
            }
        }

        $resolvedActionPath = ""
        foreach ($action in @($task.Actions)) {
            foreach ($candidate in @([string]$action.Execute, [string]$action.Arguments)) {
                if ([string]::IsNullOrWhiteSpace($candidate)) {
                    continue
                }

                if ($candidate -match '(?i)([A-Z]:\\[^"]+?\.openclaw\\(?:gateway\.cmd|start-gateway\.ps1))') {
                    $resolvedActionPath = $matches[1]
                    break
                }

                $trimmedCandidate = $candidate.Trim().Trim('"')
                if ($trimmedCandidate -match '(?i)\\\.openclaw\\(?:gateway\.cmd|start-gateway\.ps1)$') {
                    $resolvedActionPath = $trimmedCandidate
                    break
                }
            }

            if (-not [string]::IsNullOrWhiteSpace($resolvedActionPath)) {
                break
            }
        }

        if ([string]::IsNullOrWhiteSpace($resolvedActionPath)) {
            $result.reason = "no-openclaw-action-detected"
            return [pscustomobject]$result
        }

        $result.actionPath = $resolvedActionPath
        $normalizedActionPath = try {
            [System.IO.Path]::GetFullPath($resolvedActionPath).ToLowerInvariant()
        } catch {
            $resolvedActionPath.Trim().ToLowerInvariant()
        }
        $result.actionPath = $normalizedActionPath

        $actionMissing = -not (Test-Path -LiteralPath $resolvedActionPath -PathType Leaf)
        $unexpectedProfilePath = $expectedActionPaths.Count -gt 0 -and ($expectedActionPaths -notcontains $normalizedActionPath)

        $cmdActionPath = $normalizedActionPath -match '(?i)\\\.openclaw\\gateway\.cmd$'

        if (-not $actionMissing -and -not $unexpectedProfilePath -and -not $cmdActionPath) {
            $result.reason = "task-action-current"
            return [pscustomobject]$result
        }

        $result.stale = $true
        if ($actionMissing) {
            $result.reason = "task-action-missing"
        } elseif ($unexpectedProfilePath) {
            $result.reason = "task-action-points-to-different-profile"
        } else {
            $result.reason = "task-action-cmd-entrypoint"
        }

        try {
            Disable-ScheduledTask -TaskName "OpenClaw Gateway" -ErrorAction Stop | Out-Null
            $result.disabled = $true
            return [pscustomobject]$result
        } catch {
            try {
                & schtasks /Change /TN "OpenClaw Gateway" /DISABLE *> $null
                if ($LASTEXITCODE -eq 0) {
                    $result.disabled = $true
                    return [pscustomobject]$result
                }
                $result.disableError = "schtasks-disable-exit-$LASTEXITCODE"
            } catch {
                $result.disableError = $_.Exception.Message
            }
        }

        if (($actionMissing -or $cmdActionPath) -and -not [string]::IsNullOrWhiteSpace($resolvedActionPath)) {
            $shimResult = Write-LegacyOpenClawGatewayShim -LegacyActionPath $resolvedActionPath -CurrentOpenClawHome $openClawHome
            $result.shimCreated = [bool]$shimResult.created
            $result.shimPath = [string]$shimResult.path
            $result.shimTarget = [string]$shimResult.target
            $result.shimError = [string]$shimResult.error
        }

        if (-not [string]::IsNullOrWhiteSpace($TargetRoot)) {
            $repairScript = Write-OpenClawGatewayAdminRepairScript -TargetRoot $TargetRoot -ActionPath $resolvedActionPath
            $result.repairScriptCreated = [bool]$repairScript.created
            $result.repairScriptPath = [string]$repairScript.path
            $result.repairScriptError = [string]$repairScript.error
        }
    } catch {
        $result.error = $_.Exception.Message
    }

    return [pscustomobject]$result
}

function Register-StartupHooks {
    param([Parameter(Mandatory = $true)][string]$TargetRoot)

    $powerShellExe = Resolve-SharedPowerShellExecutable
    $watchdogSupervisorScript = Join-Path $TargetRoot "memory-watchdog-supervisor.ps1"
    $sharedMcpScript = Join-SharedPath @($TargetRoot, "shared-mcp", "start-default-shared-mcp.ps1")
    $watchdogArgs = Get-SharedPowerShellFileArguments -ScriptPath $watchdogSupervisorScript -ArgumentList @()
    $sharedMcpArgs = Get-SharedPowerShellFileArguments -ScriptPath $sharedMcpScript
    $startupEnvironment = Get-StartupEnvironmentVariables -TargetRoot $TargetRoot -PowerShellExe $powerShellExe

    if (Test-SharedIsWindows) {
        $startupDir = Join-SharedPath @((Get-SharedConfigHome), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
        Ensure-Directory -Path $startupDir

        $watchdogVbsPath = Join-Path $startupDir "AI Memory Watchdog.vbs"
        $legacySharedMcpVbsPath = Join-Path $startupDir "AI Shared MCP.vbs"
        $legacyStartupDir = Join-Path $TargetRoot "startup"
        $legacyWatchdogVbsPath = Join-Path $legacyStartupDir "AI-Memory-Watchdog.vbs"
        $watchdogCommand = ConvertTo-WindowsCommandLine -FilePath $powerShellExe -Arguments $watchdogArgs
        $watchdogMatch = $watchdogSupervisorScript.ToLowerInvariant()
        $watchdogVbsLines = New-Object System.Collections.Generic.List[string]
        $watchdogVbsLines.Add('Set shell = CreateObject("Wscript.Shell")') | Out-Null
        foreach ($line in @(New-VbsEnvironmentAssignments -Variables $startupEnvironment)) {
            $watchdogVbsLines.Add($line) | Out-Null
        }
        $watchdogVbsLines.Add('Set wmi = GetObject("winmgmts:\\.\root\cimv2")') | Out-Null
        $watchdogVbsLines.Add(('command = "{0}"' -f (ConvertTo-VbsStringLiteral -Value $watchdogCommand))) | Out-Null
        $watchdogVbsLines.Add(('watchdogMatch = "{0}"' -f (ConvertTo-VbsStringLiteral -Value $watchdogMatch))) | Out-Null
        $watchdogVbsLines.Add('running = False') | Out-Null
        $watchdogVbsLines.Add('Set procs = wmi.ExecQuery("Select CommandLine from Win32_Process where Name=''powershell.exe'' or Name=''pwsh.exe''")') | Out-Null
        $watchdogVbsLines.Add('For Each proc in procs') | Out-Null
        $watchdogVbsLines.Add('  If Not IsNull(proc.CommandLine) Then') | Out-Null
        $watchdogVbsLines.Add('    lc = LCase(proc.CommandLine)') | Out-Null
        $watchdogVbsLines.Add('    If InStr(lc, "-file") > 0 And InStr(lc, watchdogMatch) > 0 Then') | Out-Null
        $watchdogVbsLines.Add('      running = True') | Out-Null
        $watchdogVbsLines.Add('      Exit For') | Out-Null
        $watchdogVbsLines.Add('    End If') | Out-Null
        $watchdogVbsLines.Add('  End If') | Out-Null
        $watchdogVbsLines.Add('Next') | Out-Null
        $watchdogVbsLines.Add('') | Out-Null
        $watchdogVbsLines.Add('If Not running Then') | Out-Null
        $watchdogVbsLines.Add('  shell.Run command, 0, False') | Out-Null
        $watchdogVbsLines.Add('End If') | Out-Null
        $watchdogVbsContent = [string]::Join([Environment]::NewLine, @($watchdogVbsLines)) + [Environment]::NewLine
        [System.IO.File]::WriteAllText($watchdogVbsPath, $watchdogVbsContent, $utf8NoBom)
        Stop-WindowsStartupScriptHosts -ScriptPath $watchdogVbsPath
        if (Test-Path -LiteralPath $legacySharedMcpVbsPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacySharedMcpVbsPath -Force
        }
        Stop-WindowsStartupScriptHosts -ScriptPath $legacySharedMcpVbsPath
        if (Test-Path -LiteralPath $legacyWatchdogVbsPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyWatchdogVbsPath -Force
        }
        try {
            Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "AI-Memory-Bus-Startup" -ErrorAction SilentlyContinue
        } catch {
        }
        try {
            if (Get-ScheduledTask -TaskName "AI-Memory-Bus-Sync" -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName "AI-Memory-Bus-Sync" -Confirm:$false -ErrorAction SilentlyContinue
            }
        } catch {
        }
        $openClawStartupRepair = Repair-OpenClawStartupEntry -CurrentOpenClawHome (Join-SharedPath @((Get-SharedUserHome), ".openclaw"))
        if ([bool]$openClawStartupRepair.configured) {
            Write-Output ("Configured hidden OpenClaw startup launcher: {0}" -f $openClawStartupRepair.launcherPath)
        } elseif (@($openClawStartupRepair.removedEntries).Count -gt 0) {
            Write-Output ("Removed stale OpenClaw startup entries: {0}" -f ([string]::Join(", ", @($openClawStartupRepair.removedEntries))))
        }
        return
    }

    if (Test-SharedIsMacOS) {
        $launchAgentsDir = Join-SharedPath @((Get-SharedUserHome), "Library", "LaunchAgents")
        Ensure-Directory -Path $launchAgentsDir

        $watchdogPlistPath = Join-Path $launchAgentsDir "com.ai-memory.watchdog.plist"
        $sharedMcpPlistPath = Join-Path $launchAgentsDir "com.ai-memory.shared-mcp.plist"

        $watchdogArgsXml = [string]::Join("", @($watchdogArgs | ForEach-Object { "<string>$(ConvertTo-XmlSafeText $_)</string>" }))
        $sharedMcpArgsXml = [string]::Join("", @($sharedMcpArgs | ForEach-Object { "<string>$(ConvertTo-XmlSafeText $_)</string>" }))

        $watchdogPlist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-memory.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(ConvertTo-XmlSafeText $powerShellExe)</string>
    $watchdogArgsXml
  </array>
$(ConvertTo-PlistEnvironmentXml -Variables $startupEnvironment)
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
"@
        [System.IO.File]::WriteAllText($watchdogPlistPath, $watchdogPlist.Trim() + "`n", $utf8NoBom)

        $sharedMcpPlist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-memory.shared-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(ConvertTo-XmlSafeText $powerShellExe)</string>
    $sharedMcpArgsXml
  </array>
$(ConvertTo-PlistEnvironmentXml -Variables $startupEnvironment)
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"@
        [System.IO.File]::WriteAllText($sharedMcpPlistPath, $sharedMcpPlist.Trim() + "`n", $utf8NoBom)

        $launchctl = Get-Command launchctl -ErrorAction SilentlyContinue
        if ($launchctl) {
            try { & $launchctl.Source unload $watchdogPlistPath 2>$null | Out-Null } catch {}
            try { & $launchctl.Source unload $sharedMcpPlistPath 2>$null | Out-Null } catch {}
            try { & $launchctl.Source load $watchdogPlistPath 2>$null | Out-Null } catch {}
            try { & $launchctl.Source load $sharedMcpPlistPath 2>$null | Out-Null } catch {}
        }
        return
    }

    $watchdogExecLine = (Join-DesktopExecArguments -Arguments @($powerShellExe)) + " " + (Join-DesktopExecArguments -Arguments $watchdogArgs)
    $sharedMcpExecLine = (Join-DesktopExecArguments -Arguments @($powerShellExe)) + " " + (Join-DesktopExecArguments -Arguments $sharedMcpArgs)

    if (Test-SystemdUserAvailable) {
        $systemdUserDir = Join-SharedPath @((Get-SharedConfigHome), "systemd", "user")
        Ensure-Directory -Path $systemdUserDir

        $watchdogServicePath = Join-Path $systemdUserDir "ai-memory-watchdog.service"
        $sharedMcpServicePath = Join-Path $systemdUserDir "ai-memory-shared-mcp.service"

        $watchdogService = @"
[Unit]
Description=AI Memory Watchdog

[Service]
Type=simple
ExecStart=$watchdogExecLine
$(ConvertTo-SystemdEnvironmentLines -Variables $startupEnvironment)
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"@
        [System.IO.File]::WriteAllText($watchdogServicePath, $watchdogService.Trim() + "`n", $utf8NoBom)

        $sharedMcpService = @"
[Unit]
Description=AI Memory Shared MCP bootstrap

[Service]
Type=oneshot
ExecStart=$sharedMcpExecLine
$(ConvertTo-SystemdEnvironmentLines -Variables $startupEnvironment)
RemainAfterExit=yes

[Install]
WantedBy=default.target
"@
        [System.IO.File]::WriteAllText($sharedMcpServicePath, $sharedMcpService.Trim() + "`n", $utf8NoBom)

        $systemctl = Get-Command systemctl -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($systemctl) {
            try { & $systemctl.Source --user daemon-reload 2>$null | Out-Null } catch {}
            try { & $systemctl.Source --user enable ai-memory-watchdog.service ai-memory-shared-mcp.service 2>$null | Out-Null } catch {}
        }
        return
    }

    $autostartDir = Join-SharedPath @((Get-SharedConfigHome), "autostart")
    Write-XdgAutostartEntry -Directory $autostartDir -FileName "ai-memory-watchdog.desktop" -Name "AI Memory Watchdog" -ExecLine $watchdogExecLine
    Write-XdgAutostartEntry -Directory $autostartDir -FileName "ai-memory-shared-mcp.desktop" -Name "AI Memory Shared MCP" -ExecLine $sharedMcpExecLine
    Write-Warning ("systemctl --user is unavailable; generated XDG autostart entries in {0} instead." -f $autostartDir)
}

$sourceSharedMcpManifestPath = Join-Path $sourceRoot (Join-Path "shared-mcp" "manifest.json")
Stop-ManagedRuntimeBeforeInstall -TargetRoot $TargetRoot -ManifestPath $sourceSharedMcpManifestPath

Ensure-Directory -Path $TargetRoot
Ensure-Directory -Path (Join-SharedPath @($TargetRoot, "shared-mcp"))

$resolvedTargetRoot = (Get-Item -LiteralPath $TargetRoot).FullName
$env:AI_MEMORY_ROOT = $resolvedTargetRoot
$resolvedPython = Resolve-PythonRuntime -InstallIfMissing
if (-not $resolvedPython) {
    throw "Could not resolve a usable Python runtime. Set AI_MEMORY_PYTHON or install Python (uv-managed Python is supported)."
}
$env:AI_MEMORY_PYTHON = $resolvedPython
if ($InstallPythonDeps) {
    Ensure-PythonRetrievalDependencies -PythonPath $resolvedPython
}
$resolvedSharedMcpPython = Resolve-SharedMcpPythonRuntime -PrimaryPythonPath $resolvedPython
if ($resolvedSharedMcpPython) {
    $env:AI_MEMORY_MCP_PYTHON = $resolvedSharedMcpPython
    if ($InstallPythonDeps) {
        Ensure-SharedMcpPythonDependencies -PythonPath $resolvedSharedMcpPython
    }
} else {
    Write-Warning "No Python 3.10+ runtime was found for shared fetch/time MCP services. Set AI_MEMORY_MCP_PYTHON or install a newer Python runtime if those services stay degraded."
}

$legacyCleanupFiles = if ($layout.ContainsKey("LegacyCleanupFiles")) {
    @($layout.LegacyCleanupFiles)
} else {
    @()
}
$legacyCleanupDirectories = if ($layout.ContainsKey("LegacyCleanupDirectories")) {
    @($layout.LegacyCleanupDirectories)
} else {
    @()
}
$managedInstallFiles = Get-ManagedInstallFiles -Layout $layout
$cliFiles = if ($layout.ContainsKey("CliFiles")) { @($layout.CliFiles) } else { @() }
$installManifestPath = Join-Path $TargetRoot "install-manifest.json"
Remove-StaleManagedFiles `
    -TargetRoot $TargetRoot `
    -ManifestPath $installManifestPath `
    -CurrentManagedFiles $managedInstallFiles `
    -LegacyCleanupFiles $legacyCleanupFiles `
    -LegacyCleanupDirectories $legacyCleanupDirectories

foreach ($sourceDir in @($layout.FlatRuntimeFiles.Keys | Sort-Object)) {
    foreach ($name in @($layout.FlatRuntimeFiles[$sourceDir])) {
        $srcPath = Join-Path $sourceRoot (Join-Path $sourceDir $name)
        if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
            throw "Install layout manifest references missing runtime file: $srcPath"
        }

        $destinationPath = Join-Path $TargetRoot $name
        if ($DryRun) {
            Write-Output "[dry-run] would copy: $srcPath -> $destinationPath"
        } else {
            Copy-Item -LiteralPath $srcPath -Destination $destinationPath -Force
            Set-PosixExecutableIfNeeded -Path $destinationPath
        }
    }
}

foreach ($name in @($layout.SharedMcpFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "shared-mcp" $name)
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing shared-mcp file: $srcPath"
    }

    $destinationPath = Join-SharedPath @($TargetRoot, "shared-mcp", $name)
    if ($DryRun) {
        Write-Output "[dry-run] would copy: $srcPath -> $destinationPath"
    } else {
        Copy-Item -LiteralPath $srcPath -Destination $destinationPath -Force
        Set-PosixExecutableIfNeeded -Path $destinationPath
    }
}

foreach ($name in @($layout.TemplateFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "templates" $name)
    $dstPath = Join-Path $TargetRoot $name
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing template file: $srcPath"
    }

    if (-not (Test-Path -LiteralPath $dstPath)) {
        Ensure-Directory -Path (Split-Path -Parent $dstPath)
        if ($DryRun) {
            Write-Output "[dry-run] would copy template: $srcPath -> $dstPath"
        } else {
            Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
        }
    }
}

foreach ($name in @($cliFiles)) {
    $srcPath = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing CLI file: $srcPath"
    }

    $destinationPath = Join-Path $TargetRoot $name
    Ensure-Directory -Path (Split-Path -Parent $destinationPath)
    if ($DryRun) {
        Write-Output "[dry-run] would copy CLI: $srcPath -> $destinationPath"
    } else {
        Copy-Item -LiteralPath $srcPath -Destination $destinationPath -Force
        Set-PosixExecutableIfNeeded -Path $destinationPath
    }
}

# ADR-002 Phase 0.2: Initialize .memory/ directory structure
function Initialize-MemoryDirectory {
    param(
        [string]$TargetRoot
    )
    $memoryRoot = Join-Path $TargetRoot ".memory"
    $subdirs = @("user", "feedback", "project", "reference", "sessions", "archived", ".index", ".lock", ".config")
    foreach ($subdir in $subdirs) {
        $dirPath = Join-Path $memoryRoot $subdir
        if (-not (Test-Path -LiteralPath $dirPath)) {
            Ensure-Directory -Path $dirPath
            Write-Host "[init] Created $dirPath"
        }
    }
    # Copy .memory/ templates from templates/.memory/
    $templateSrc = Join-Path (Join-Path $sourceRoot "templates") ".memory"
    if (Test-Path -LiteralPath $templateSrc -PathType Container) {
        foreach ($tmpl in @("MEMORY.md", "README.md", "TEMPLATE.md")) {
            $src = Join-Path $templateSrc $tmpl
            $dst = Join-Path $memoryRoot $tmpl
            if ((Test-Path -LiteralPath $src -PathType Leaf) -and -not (Test-Path -LiteralPath $dst)) {
                Copy-Item -LiteralPath $src -Destination $dst -Force
                Write-Host "[init] Copied $tmpl to .memory/"
            }
        }
        # Copy config files
        $configSrc = Join-Path $templateSrc ".config"
        if (Test-Path -LiteralPath $configSrc -PathType Container) {
            $configDst = Join-Path $memoryRoot ".config"
            foreach ($cfg in @("retrieval.json", "retention-policy.json")) {
                $src = Join-Path $configSrc $cfg
                $dst = Join-Path $configDst $cfg
                if ((Test-Path -LiteralPath $src -PathType Leaf) -and -not (Test-Path -LiteralPath $dst)) {
                    Copy-Item -LiteralPath $src -Destination $dst -Force
                    Write-Host "[init] Copied .config/$cfg"
                }
            }
        }
    }
    Write-Host "[init] .memory/ directory structure ready at $memoryRoot"
}

if (-not $DryRun) {
    Initialize-MemoryDirectory -TargetRoot $TargetRoot
} else {
    Write-Output "[dry-run] would initialize .memory/ directory structure"
}

# ADR-002 Phase 0.3: Initialize SQLite schema (sqlite-vec 0.1.9)
$initSchemaScript = Join-Path (Join-Path $TargetRoot "ops") "init-sqlite-schema.js"
if (Test-Path -LiteralPath $initSchemaScript -PathType Leaf) {
    Write-Host "[init] Running SQLite schema init..."
    $schemaResult = & node $initSchemaScript 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[init] SQLite schema OK: $schemaResult"
    } else {
        Write-Warning "[init] SQLite schema init had issues (exit $LASTEXITCODE): $schemaResult"
    }
} else {
    Write-Host "[init] SQLite schema bootstrap script not bundled; skipping explicit SQLite init"
}

$generatedShellWrappers = Get-GeneratedShellWrapperFiles -Layout $layout
Write-GeneratedShellWrappers -TargetRoot $TargetRoot -WrapperFiles $generatedShellWrappers
Write-EnvironmentActivationFiles -TargetRoot $TargetRoot -ResolvedTargetRoot $resolvedTargetRoot -ResolvedPython $resolvedPython -ResolvedSharedMcpPython $resolvedSharedMcpPython

$npmCommand = Get-Command npm.cmd,npm -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npmCommand) {
    throw "npm was not found on PATH. Install Node.js before running this installer."
}

Push-Location (Join-SharedPath @($TargetRoot, "shared-mcp"))
try {
    $sharedMcpLockPath = Join-SharedPath @($TargetRoot, "shared-mcp", "package-lock.json")
    $npmArgs = if (Test-Path -LiteralPath $sharedMcpLockPath -PathType Leaf) {
        @("ci", "--omit=dev")
    } else {
        @("install", "--omit=dev")
    }

    if ($DryRun) {
        Write-Output "[dry-run] would run npm $($npmArgs[0]) in shared-mcp/"
    } else {
        & $npmCommand.Source @npmArgs
        if ($LASTEXITCODE -ne 0) {
            throw ("npm {0} failed in shared-mcp." -f $npmArgs[0])
        }
    }
} finally {
    Pop-Location
}

if ($RegisterStartup) {
    if ($DryRun) {
        Write-Output "[dry-run] would register startup hooks"
    } else {
        Register-StartupHooks -TargetRoot $TargetRoot
    }
}

if ((Test-SharedIsWindows) -and (-not $DryRun)) {
    $openClawGatewayTaskRepair = Disable-StaleOpenClawGatewayTask -TargetRoot $TargetRoot
    if ([bool]$openClawGatewayTaskRepair.disabled) {
        Write-Output ("Disabled stale OpenClaw Gateway scheduled task ({0}): {1}" -f $openClawGatewayTaskRepair.reason, $openClawGatewayTaskRepair.actionPath)
    } elseif ([bool]$openClawGatewayTaskRepair.shimCreated) {
        Write-Output ("Installed legacy OpenClaw Gateway shim for stale task ({0}): {1} -> {2}" -f $openClawGatewayTaskRepair.reason, $openClawGatewayTaskRepair.shimPath, $openClawGatewayTaskRepair.shimTarget)
    } elseif ([bool]$openClawGatewayTaskRepair.stale -and -not [string]::IsNullOrWhiteSpace([string]$openClawGatewayTaskRepair.disableError)) {
        Write-Warning ("Detected stale OpenClaw Gateway scheduled task but could not disable it automatically: {0}" -f $openClawGatewayTaskRepair.disableError)
        if ([bool]$openClawGatewayTaskRepair.repairScriptCreated) {
            Write-Warning ("Wrote elevated repair script for the stale OpenClaw task: {0}" -f $openClawGatewayTaskRepair.repairScriptPath)
        } elseif (-not [string]::IsNullOrWhiteSpace([string]$openClawGatewayTaskRepair.repairScriptError)) {
            Write-Warning ("Unable to write elevated repair script for the stale OpenClaw task: {0}" -f $openClawGatewayTaskRepair.repairScriptError)
        }
    }
}

$generateArgs = @("-Action", "Generate")
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $generateArgs += @("-Project", $WorkspaceRoot)
}
if ($DryRun) {
    Write-Output "[dry-run] would invoke memory-bus.ps1 -Action Generate"
    Write-Output "[dry-run] would invoke write-config-snippets.ps1"
} else {
    Invoke-SharedPowerShellFile -ScriptPath (Join-Path $TargetRoot "memory-bus.ps1") -ArgumentList $generateArgs | Out-Null
    Invoke-SharedPowerShellFile -ScriptPath (Join-SharedPath @($TargetRoot, "shared-mcp", "write-config-snippets.ps1")) | Out-Null
}

if ($ApplyClientIntegrations) {
    $clientIntegrationScript = Join-Path $TargetRoot "install-client-integrations.ps1"
    if (-not (Test-Path -LiteralPath $clientIntegrationScript -PathType Leaf)) {
        throw "install-client-integrations.ps1 was not installed into the managed runtime."
    }

    $clientArgs = @(
        "-AiMemoryRoot", $resolvedTargetRoot,
        "-SkipGenerate",
        "-SkipSkillSync"
    )
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        $clientArgs += @("-WorkspaceRoot", $WorkspaceRoot)
    }
    if ($IncludeOptionalClientServers) {
        $clientArgs += "-IncludeOptionalServers"
    }

    if ($DryRun) {
        Write-Output "[dry-run] would invoke install-client-integrations.ps1 with args: $($clientArgs -join ' ')"
    } else {
        Invoke-SharedPowerShellFile -ScriptPath $clientIntegrationScript -ArgumentList $clientArgs | Out-Null
    }
}

Write-InstallManifest `
    -ManifestPath $installManifestPath `
    -ManagedFiles $managedInstallFiles `
    -LegacyCleanupFiles $legacyCleanupFiles `
    -LayoutPath $layoutPath

if ($PersistUserEnvironment) {
    if (Test-SharedIsWindows) {
        if ($DryRun) {
            Write-Output "[dry-run] would persist env vars to User scope: AI_MEMORY_ROOT=$resolvedTargetRoot, AI_MEMORY_PYTHON=$resolvedPython"
        } else {
            [Environment]::SetEnvironmentVariable("AI_MEMORY_ROOT", $resolvedTargetRoot, "User")
            [Environment]::SetEnvironmentVariable("AI_MEMORY_PYTHON", $resolvedPython, "User")
            if ($resolvedSharedMcpPython) {
                [Environment]::SetEnvironmentVariable("AI_MEMORY_MCP_PYTHON", $resolvedSharedMcpPython, "User")
            }
        }
    } else {
        Write-Output ("Generated activation helpers at {0} and {1}" -f (Join-Path $TargetRoot "activate-ai-memory.sh"), (Join-Path $TargetRoot "activate-ai-memory.ps1"))
    }
}

$shouldStartServicesNow = (-not $env:CI) -and (-not $env:GITHUB_ACTIONS)
if ($shouldStartServicesNow) {
    if (Test-SharedIsWindows) {
        $startupDir = Join-SharedPath @((Get-SharedConfigHome), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
        $watchdogVbsPath = Join-Path $startupDir "AI Memory Watchdog.vbs"
        $watchdogSupervisorScript = Join-Path $TargetRoot "memory-watchdog-supervisor.ps1"
        if ($DryRun) {
            Write-Output "[dry-run] would start watchdog supervisor and startup VBS"
        } else {
            if (-not (Test-WindowsPowerShellScriptRunning -ScriptPath $watchdogSupervisorScript)) {
                Start-SharedBackgroundProcess `
                    -FilePath (Resolve-SharedPowerShellExecutable) `
                    -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $watchdogSupervisorScript) `
                    -WorkingDirectory $TargetRoot | Out-Null
            }
        }
    } else {
        if ($DryRun) {
            Write-Output "[dry-run] would register event-driven hooks (no background daemons)"
        } else {
            # 轻量化：不再启动后台 watchdog 和 MCP 服务
            # 用户通过 Stop Hook 触发同步，按需启动 MCP
            Write-Output "[shared-memory] Event-driven mode: no background daemons started"
            Write-Output "[shared-memory] Use memory-bus.ps1 -Action SyncAll for manual sync"
            Write-Output "[shared-memory] Configure Stop Hooks in ~/.claude/settings.json for auto-sync"
        }
    }
}

Write-Output ("Installed shared-memory bus to {0}" -f $TargetRoot)
