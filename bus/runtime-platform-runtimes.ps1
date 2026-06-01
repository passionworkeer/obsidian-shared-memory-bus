Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-runtimes.ps1
# Python / Node / PowerShell executable discovery.
# Depends on: runtime-platform-paths.ps1, runtime-platform-env.ps1
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"
. "$PSScriptRoot\runtime-platform-env.ps1"

function Resolve-SharedPowerShellExecutable {
    if (Test-SharedIsWindows) {
        $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
        return "powershell.exe"
    }

    $override = Get-SharedEnvValue -Name "AI_MEMORY_PWSH"
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        return $override
    }

    foreach ($candidate in @("pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    throw "RUNTIME_CONFIG_INVALID: PowerShell 7 (pwsh) is required on macOS/Linux. Install pwsh from https://github.com/PowerShell/PowerShell or set AI_MEMORY_PWSH to the pwsh executable path."
}

function Get-SharedPowerShellCommandName {
    if (Test-SharedIsWindows) {
        return "powershell.exe"
    }

    return "pwsh"
}

function Resolve-SharedNodeExecutable {
    foreach ($candidate in @("node.exe", "node")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "RUNTIME_CONFIG_INVALID: Node.js was not found on PATH. Install Node.js from https://nodejs.org or set the NODE_PATH environment variable."
}

function Get-SharedUvManagedPythonCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]
    $roots = New-Object System.Collections.Generic.List[string]

    if (Test-SharedIsWindows) {
        $roots.Add((Join-SharedPath @((Get-SharedConfigHome), "uv", "python"))) | Out-Null
    } else {
        $roots.Add((Join-SharedPath @((Get-SharedDataHome), "uv", "python"))) | Out-Null
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
            $candidates.Add([string]$candidate) | Out-Null
        }
    }

    return @($candidates | Select-Object -Unique)
}

function Get-SharedPyLauncherExecutable {
    if (-not (Test-SharedIsWindows)) {
        return ""
    }

    $launcherCandidates = @(
        (Join-SharedPath @((Get-SharedUserHome), "AppData", "Local", "Programs", "Python", "Launcher", "py.exe"))
    )

    foreach ($candidate in @("py.exe", "py")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
            $launcherCandidates += [string]$command.Source
        }
    }

    foreach ($candidate in @($launcherCandidates | Select-Object -Unique)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return ""
}

function Get-SharedPyLauncherPythonCandidates {
    if (-not (Test-SharedIsWindows)) {
        return @()
    }

    $launcherPath = Get-SharedPyLauncherExecutable
    if ([string]::IsNullOrWhiteSpace($launcherPath)) {
        return @()
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    try {
        $lines = & $launcherPath -0p 2>$null
    } catch {
        $lines = @()
    }

    foreach ($line in @($lines)) {
        $match = [regex]::Match([string]$line, '^\s*-V:[^\s]+\s+\*?\s*(.+?)\s*$')
        if (-not $match.Success) {
            continue
        }

        $candidate = $match.Groups[1].Value.Trim()
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $candidates.Add((Get-Item -LiteralPath $candidate).FullName) | Out-Null
        }
    }

    return @($candidates | Select-Object -Unique)
}

function Get-SharedPythonVersionInfo {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        return $null
    }

    $probeScript = @'
import sys
import encodings

print(str(sys.version_info[0]) + '|' + str(sys.version_info[1]) + '|' + sys.executable)
'@

    try {
        $raw = & $PythonPath -c $probeScript 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$raw)) {
            return $null
        }

        $parts = ([string]$raw).Trim().Split("|")
        if ($parts.Length -lt 3) {
            return $null
        }

        return [pscustomobject]@{
            major      = [int]$parts[0]
            minor      = [int]$parts[1]
            executable = [string]::Join("|", @($parts | Select-Object -Skip 2))
        }
    } catch {
        return $null
    }
}

function Test-SharedPythonUsable {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [int]$Major = 0,
        [int]$Minor = 0
    )

    $info = Get-SharedPythonVersionInfo -PythonPath $PythonPath
    if ($null -eq $info) {
        return $false
    }

    if ($Major -le 0) {
        return $true
    }

    if ([int]$info.major -gt $Major) {
        return $true
    }
    if ([int]$info.major -lt $Major) {
        return $false
    }

    return ([int]$info.minor -ge $Minor)
}

function Get-SharedPythonExecutableCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]

    foreach ($envName in @("AI_MEMORY_MCP_PYTHON", "AI_MEMORY_PYTHON")) {
        $override = Get-SharedEnvValue -Name $envName
        if (-not [string]::IsNullOrWhiteSpace($override) -and (Test-Path -LiteralPath $override -PathType Leaf)) {
            $candidates.Add((Get-Item -LiteralPath $override).FullName) | Out-Null
        }
    }

    foreach ($commandName in @("python.exe", "python", "python3")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source) -and ([string]$command.Source -notmatch "WindowsApps")) {
            $candidates.Add([string]$command.Source) | Out-Null
        }
    }

    foreach ($candidate in @(Get-SharedPyLauncherPythonCandidates)) {
        $candidates.Add([string]$candidate) | Out-Null
    }

    foreach ($candidate in @(Get-SharedUvManagedPythonCandidates)) {
        $candidates.Add([string]$candidate) | Out-Null
    }

    if (Test-SharedIsWindows) {
        $userHome = Get-SharedUserHome
        foreach ($candidate in @(
            (Join-Path $userHome "AppData\Local\Programs\Python\Python313\python.exe"),
            (Join-Path $userHome "AppData\Local\Programs\Python\Python312\python.exe"),
            (Join-Path $userHome "AppData\Local\Programs\Python\Python311\python.exe"),
            (Join-Path $userHome "AppData\Local\Programs\Python\Python310\python.exe")
        )) {
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                $candidates.Add((Get-Item -LiteralPath $candidate).FullName) | Out-Null
            }
        }
    } else {
        foreach ($candidate in @(
            (Join-SharedPath @((Get-SharedUserHome), ".local", "bin", "python3")),
            "/usr/bin/python3",
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3"
        )) {
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                $candidates.Add((Get-Item -LiteralPath $candidate).FullName) | Out-Null
            }
        }
    }

    return @($candidates | Select-Object -Unique)
}

function Resolve-SharedPythonRuntime {
    param(
        [int]$Major = 0,
        [int]$Minor = 0,
        [string[]]$ExtraCandidates = @()
    )

    foreach ($candidate in @(@($ExtraCandidates) + @(Get-SharedPythonExecutableCandidates))) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        if (Test-SharedPythonUsable -PythonPath $candidate -Major $Major -Minor $Minor) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return ""
}
