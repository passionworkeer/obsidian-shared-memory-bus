param(
    [string]$TargetRoot = "",
    [string]$WorkspaceRoot = "",
    $RegisterStartup = $true,
    $PersistUserEnvironment = $true,
    $InstallPythonDeps = $true,
    $ApplyClientIntegrations = $true,
    $IncludeOptionalClientServers = $false
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
}

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
    Start-SharedPowerShellFile -ScriptPath $ScriptPath -ArgumentList $ArgumentList -WorkingDirectory $workingDirectory | Out-Null
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

    $userHome = Get-SharedUserHome

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

    $fallbackCandidates = New-Object System.Collections.Generic.List[string]
    if (Test-SharedIsWindows) {
        foreach ($candidate in @(
            (Join-Path $userHome "AppData\Local\Programs\Python\Python313\python.exe"),
            (Join-Path $userHome "AppData\Local\Programs\Python\Python312\python.exe"),
            (Join-Path $userHome "AppData\Local\Programs\Python\Python311\python.exe"),
            "D:\python\python.exe",
            "C:\Python313\python.exe",
            "C:\Python312\python.exe",
            "C:\Python311\python.exe"
        )) {
            $fallbackCandidates.Add($candidate) | Out-Null
        }
    } else {
        foreach ($candidate in @(
            (Join-SharedPath @($userHome, ".local", "bin", "python3")),
            "/usr/bin/python3",
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3"
        )) {
            $fallbackCandidates.Add($candidate) | Out-Null
        }
    }

    foreach ($candidate in @($fallbackCandidates)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
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

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        return $false
    }

    try {
        $versionText = & $PythonPath -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($versionText)) {
            return $false
        }

        $parts = $versionText.Trim().Split(".")
        if ($parts.Length -lt 2) {
            return $false
        }

        $majorValue = 0
        $minorValue = 0
        if (-not [int]::TryParse($parts[0], [ref]$majorValue)) {
            return $false
        }
        if (-not [int]::TryParse($parts[1], [ref]$minorValue)) {
            return $false
        }

        if ($majorValue -gt $Major) {
            return $true
        }
        if ($majorValue -lt $Major) {
            return $false
        }

        return $minorValue -ge $Minor
    } catch {
        return $false
    }
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

    foreach ($candidate in (@($PrimaryPythonPath) + @(Get-UvManagedPythonCandidates))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-PythonVersionAtLeast -PythonPath $candidate)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
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
        & $PythonPath -m pip install "--break-system-packages" "--disable-pip-version-check" "--no-input" @($pipExtraArgs) @($missingPackages)
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
                & $uvCommand.Source "pip" "install" "--python" $PythonPath "--break-system-packages" "--no-progress" @($pipExtraArgs) @($missingPackages)
                if ($LASTEXITCODE -eq 0) {
                    $installSucceeded = $true
                }
            } catch {
                $installSucceeded = $false
            }
        }

        if (-not $installSucceeded) {
            $pipExtraArgs = @(Get-PythonPackageInstallExtraArgs)
            & $PythonPath -m pip install "--break-system-packages" "--disable-pip-version-check" "--no-input" @($pipExtraArgs) @($missingPackages)
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
    $entries["AI_MEMORY_ROOT"] = $TargetRoot
    $pythonPath = Get-SharedEnvValue -Name "AI_MEMORY_PYTHON"
    if (-not [string]::IsNullOrWhiteSpace($pythonPath)) {
        $entries["AI_MEMORY_PYTHON"] = $pythonPath
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

function Register-StartupHooks {
    param([Parameter(Mandatory = $true)][string]$TargetRoot)

    $powerShellExe = Resolve-SharedPowerShellExecutable
    $watchdogScript = Join-Path $TargetRoot "memory-watchdog.ps1"
    $sharedMcpScript = Join-SharedPath @($TargetRoot, "shared-mcp", "start-default-shared-mcp.ps1")
    $watchdogArgs = Get-SharedPowerShellFileArguments -ScriptPath $watchdogScript -ArgumentList @("-Daemon", "-PollSeconds", "15")
    $sharedMcpArgs = Get-SharedPowerShellFileArguments -ScriptPath $sharedMcpScript
    $startupEnvironment = Get-StartupEnvironmentVariables -TargetRoot $TargetRoot -PowerShellExe $powerShellExe

    if (Test-SharedIsWindows) {
        $startupDir = Join-SharedPath @((Get-SharedConfigHome), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
        Ensure-Directory -Path $startupDir

        $watchdogVbsPath = Join-Path $startupDir "AI Memory Watchdog.vbs"
        $watchdogCommand = ('"{0}" {1}' -f $powerShellExe, [string]::Join(" ", @($watchdogArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })))
        $watchdogVbsContent = 'Set shell = CreateObject("Wscript.Shell")' + "`n" +
            ('command = "{0}"' -f ($watchdogCommand -replace '"', '""')) + "`n" +
            'shell.Run command, 0, False' + "`n"
        [System.IO.File]::WriteAllText($watchdogVbsPath, $watchdogVbsContent, $utf8NoBom)

        $sharedMcpVbsPath = Join-Path $startupDir "AI Shared MCP.vbs"
        $sharedMcpCommand = ('"{0}" {1}' -f $powerShellExe, [string]::Join(" ", @($sharedMcpArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })))
        $sharedMcpVbsContent = 'Set shell = CreateObject("Wscript.Shell")' + "`n" +
            ('command = "{0}"' -f ($sharedMcpCommand -replace '"', '""')) + "`n" +
            'shell.Run command, 0, False' + "`n"
        [System.IO.File]::WriteAllText($sharedMcpVbsPath, $sharedMcpVbsContent, $utf8NoBom)
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

        $destinationPath = Join-Path $TargetRoot $name
        Copy-Item -LiteralPath $srcPath -Destination $destinationPath -Force
        Set-PosixExecutableIfNeeded -Path $destinationPath
    }
}

foreach ($name in @($layout.SharedMcpFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "shared-mcp" $name)
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing shared-mcp file: $srcPath"
    }

    $destinationPath = Join-SharedPath @($TargetRoot, "shared-mcp", $name)
    Copy-Item -LiteralPath $srcPath -Destination $destinationPath -Force
    Set-PosixExecutableIfNeeded -Path $destinationPath
}

foreach ($name in @($layout.TemplateFiles)) {
    $srcPath = Join-Path $sourceRoot (Join-Path "templates" $name)
    $dstPath = Join-Path $TargetRoot $name
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) {
        throw "Install layout manifest references missing template file: $srcPath"
    }

    if (-not (Test-Path -LiteralPath $dstPath)) {
        Ensure-Directory -Path (Split-Path -Parent $dstPath)
        Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
    }
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

    & $npmCommand.Source @npmArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("npm {0} failed in shared-mcp." -f $npmArgs[0])
    }
} finally {
    Pop-Location
}

if ($RegisterStartup) {
    Register-StartupHooks -TargetRoot $TargetRoot
}

$generateArgs = @("-Action", "Generate")
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $generateArgs += @("-Project", $WorkspaceRoot)
}
Invoke-SharedPowerShellFile -ScriptPath (Join-Path $TargetRoot "memory-bus.ps1") -ArgumentList $generateArgs | Out-Null
Invoke-SharedPowerShellFile -ScriptPath (Join-SharedPath @($TargetRoot, "shared-mcp", "write-config-snippets.ps1")) | Out-Null

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

    Invoke-SharedPowerShellFile -ScriptPath $clientIntegrationScript -ArgumentList $clientArgs | Out-Null
}

Write-InstallManifest `
    -ManifestPath $installManifestPath `
    -ManagedFiles $managedInstallFiles `
    -LegacyCleanupFiles $legacyCleanupFiles `
    -LayoutPath $layoutPath

if ($PersistUserEnvironment) {
    if (Test-SharedIsWindows) {
        [Environment]::SetEnvironmentVariable("AI_MEMORY_ROOT", $resolvedTargetRoot, "User")
        [Environment]::SetEnvironmentVariable("AI_MEMORY_PYTHON", $resolvedPython, "User")
        if ($resolvedSharedMcpPython) {
            [Environment]::SetEnvironmentVariable("AI_MEMORY_MCP_PYTHON", $resolvedSharedMcpPython, "User")
        }
    } else {
        Write-Output ("Generated activation helpers at {0} and {1}" -f (Join-Path $TargetRoot "activate-ai-memory.sh"), (Join-Path $TargetRoot "activate-ai-memory.ps1"))
    }
}

$shouldStartServicesNow = $RegisterStartup -and (-not $env:CI) -and (-not $env:GITHUB_ACTIONS)
if ($shouldStartServicesNow) {
    Start-BackgroundRuntime -ScriptPath (Join-Path $TargetRoot "memory-watchdog.ps1") -ArgumentList @("-Daemon", "-PollSeconds", "15")
    Start-BackgroundRuntime -ScriptPath (Join-SharedPath @($TargetRoot, "shared-mcp", "start-default-shared-mcp.ps1"))
}

Write-Output ("Installed shared-memory bus to {0}" -f $TargetRoot)
