Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Join-SharedPath {
    param([Parameter(Mandatory = $true)][string[]]$Segments)

    $parts = @($Segments | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) {
        return ""
    }

    $current = [string]$parts[0]
    foreach ($segment in @($parts | Select-Object -Skip 1)) {
        $current = [System.IO.Path]::Combine($current, [string]$segment)
    }

    return $current
}

function Get-SharedPlatformInfo {
    $isWindows = $false
    $isMacOS = $false
    $isLinux = $false

    try {
        $runtimeInfo = [System.Runtime.InteropServices.RuntimeInformation]
        $isWindows = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
        $isMacOS = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)
        $isLinux = $runtimeInfo::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)
    } catch {
        $platform = [Environment]::OSVersion.Platform
        $isWindows = $platform -eq [System.PlatformID]::Win32NT
    }

    [pscustomobject]@{
        IsWindows = [bool]$isWindows
        IsMacOS = [bool]$isMacOS
        IsLinux = [bool]$isLinux
    }
}

$Script:SharedPlatformInfo = Get-SharedPlatformInfo

function Test-SharedIsWindows {
    return [bool]$Script:SharedPlatformInfo.IsWindows
}

function Test-SharedIsMacOS {
    return [bool]$Script:SharedPlatformInfo.IsMacOS
}

function Test-SharedIsLinux {
    return [bool]$Script:SharedPlatformInfo.IsLinux
}

function Get-SharedUserHome {
    foreach ($candidate in @(
        [string]$env:USERPROFILE,
        [string]$env:HOME,
        [Environment]::GetFolderPath("UserProfile")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            return $candidate
        }
    }

    throw "Unable to resolve the current user's home directory."
}

function Get-SharedConfigHome {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
            return $env:APPDATA
        }
        return (Join-SharedPath @($userHome, "AppData", "Roaming"))
    }
    if (Test-SharedIsMacOS) {
        return Join-SharedPath @($userHome, "Library", "Application Support")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_CONFIG_HOME)) {
        return $env:XDG_CONFIG_HOME
    }
    return (Join-SharedPath @($userHome, ".config"))
}

function Get-SharedDataHome {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            return $env:LOCALAPPDATA
        }
        return (Join-SharedPath @($userHome, "AppData", "Local"))
    }
    if (Test-SharedIsMacOS) {
        return Join-SharedPath @($userHome, "Library", "Application Support")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_DATA_HOME)) {
        return $env:XDG_DATA_HOME
    }
    return (Join-SharedPath @($userHome, ".local", "share"))
}

function Get-SharedDefaultAiMemoryRoot {
    return (Join-SharedPath @((Get-SharedUserHome), ".ai-memory"))
}

function Get-SharedEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return [string]$value
    }

    if (Test-SharedIsWindows) {
        foreach ($scope in @("User", "Machine")) {
            $value = [Environment]::GetEnvironmentVariable($Name, $scope)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                return [string]$value
            }
        }
    }

    return ""
}

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

    throw "PowerShell 7 (pwsh) is required on macOS/Linux. Install pwsh or set AI_MEMORY_PWSH."
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

    throw "Node.js was not found on PATH."
}

function Get-SharedOpenCodeDataRoot {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        return (Join-SharedPath @($userHome, ".local", "share", "opencode"))
    }

    return (Join-SharedPath @((Get-SharedDataHome), "opencode"))
}

function Get-SharedOpenCodeConfigRoot {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        return (Join-SharedPath @($userHome, ".config", "opencode"))
    }

    return (Join-SharedPath @((Get-SharedConfigHome), "opencode"))
}

function Get-SharedCopilotHomeRoot {
    return (Join-SharedPath @((Get-SharedUserHome), ".copilot"))
}

function Get-SharedTraeUserRoot {
    param([Parameter(Mandatory = $true)][string]$ProductName)

    return (Join-SharedPath @((Get-SharedConfigHome), $ProductName, "User"))
}

function Get-SharedWatchdogStartupHookPath {
    if (-not (Test-SharedIsWindows)) {
        return ""
    }

    return (Join-SharedPath @(
        (Get-SharedConfigHome),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "AI Memory Watchdog.vbs"
    ))
}

function Get-SharedPowerShellFileArguments {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    $prefix = if (Test-SharedIsWindows) {
        @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath)
    } else {
        @("-NoProfile", "-File", $ScriptPath)
    }

    return @($prefix + @($ArgumentList))
}

function Invoke-SharedPowerShellFile {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    $executable = Resolve-SharedPowerShellExecutable
    $args = Get-SharedPowerShellFileArguments -ScriptPath $ScriptPath -ArgumentList $ArgumentList
    & $executable @args
}

function Invoke-SharedShellCommand {
    param([Parameter(Mandatory = $true)][string]$Command)

    if (Test-SharedIsWindows) {
        & cmd.exe /d /s /c $Command
        return
    }

    $shellPath = $null
    $shellArgs = @("-c", $Command)
    foreach ($candidate in @("bash", "/bin/bash", "sh", "/bin/sh")) {
        $commandInfo = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($commandInfo) {
            $shellPath = $commandInfo.Source
            if ($candidate -like "*bash") {
                $shellArgs = @("-lc", $Command)
            }
            break
        }
        if (([System.IO.Path]::IsPathRooted($candidate)) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $shellPath = (Get-Item -LiteralPath $candidate).FullName
            if ($candidate -like "*bash") {
                $shellArgs = @("-lc", $Command)
            }
            break
        }
    }

    if (-not $shellPath) {
        throw "No POSIX shell was found. Install bash/sh or set up a compatible shell runtime."
    }

    & $shellPath @shellArgs
}

function Start-SharedPowerShellFile {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = ""
    )

    $executable = Resolve-SharedPowerShellExecutable
    $args = Get-SharedPowerShellFileArguments -ScriptPath $ScriptPath -ArgumentList $ArgumentList
    $parameters = @{
        FilePath = $executable
        ArgumentList = $args
        PassThru = $true
    }

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $parameters.WorkingDirectory = $WorkingDirectory
    }
    if (Test-SharedIsWindows) {
        $parameters.WindowStyle = "Hidden"
    }

    return Start-Process @parameters
}

function Get-SharedObsidianConfigCandidates {
    $configHome = Get-SharedConfigHome
    return @(
        (Join-SharedPath @($configHome, "obsidian", "obsidian.json"))
    ) | Select-Object -Unique
}

function Get-SharedDefaultObsidianVaultCandidates {
    $userHome = Get-SharedUserHome
    return @(
        (Join-SharedPath @($userHome, "Obsidian Vault")),
        (Join-SharedPath @($userHome, "Documents", "Obsidian Vault")),
        (Join-SharedPath @($userHome, "Desktop", "Obsidian Vault"))
    ) | Select-Object -Unique
}

function Resolve-SharedObsidianVaultRoot {
    param(
        [AllowEmptyString()][string]$FallbackPath = "",
        [switch]$ThrowIfMissing
    )

    foreach ($overridePath in @(
        (Get-SharedEnvValue -Name "AI_MEMORY_OBSIDIAN_VAULT"),
        (Get-SharedEnvValue -Name "OBSIDIAN_VAULT_ROOT")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    foreach ($obsidianConfigPath in @(Get-SharedObsidianConfigCandidates)) {
        if (-not (Test-Path -LiteralPath $obsidianConfigPath -PathType Leaf)) {
            continue
        }

        try {
            $config = Get-Content -Raw -LiteralPath $obsidianConfigPath -Encoding utf8 | ConvertFrom-Json
            $records = New-Object System.Collections.Generic.List[object]
            if ($config.vaults) {
                foreach ($property in $config.vaults.PSObject.Properties) {
                    $vault = $property.Value
                    $path = [string]$vault.path
                    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) {
                        continue
                    }

                    $records.Add([pscustomobject]@{
                        path = (Get-Item -LiteralPath $path).FullName
                        open = [bool]$vault.open
                        ts = if ($null -ne $vault.ts) { [int64]$vault.ts } else { 0 }
                    }) | Out-Null
                }
            }

            $openVault = @($records | Where-Object { $_.open } | Sort-Object ts -Descending | Select-Object -First 1)
            if ($openVault.Count -gt 0) {
                return $openVault[0].path
            }

            $recentVault = @($records | Sort-Object ts -Descending | Select-Object -First 1)
            if ($recentVault.Count -gt 0) {
                return $recentVault[0].path
            }
        } catch {
        }
    }

    foreach ($candidate in (@($FallbackPath) + @(Get-SharedDefaultObsidianVaultCandidates))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    if ($ThrowIfMissing) {
        throw "No Obsidian vault directory found."
    }

    return $FallbackPath
}

function Get-SharedVsCodeUserRoot {
    param([Parameter(Mandatory = $true)][string]$ProductName)

    return (Join-SharedPath @((Get-SharedConfigHome), $ProductName, "User"))
}

function Get-SharedListeningProcessIds {
    param([Parameter(Mandatory = $true)][int]$Port)

    if ($Port -le 0) {
        return @()
    }

    if (Test-SharedIsWindows) {
        $processIds = New-Object System.Collections.Generic.List[int]
        try {
            foreach ($tcp in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)) {
                if ($tcp -and $tcp.OwningProcess) {
                    $processIds.Add([int]$tcp.OwningProcess) | Out-Null
                }
            }
        } catch {
        }

        try {
            $pattern = ":{0}\s+.*LISTENING\s+(\d+)\s*$" -f $Port
            foreach ($line in @(netstat -ano -p tcp | Select-String -Pattern $pattern)) {
                if ($line -and ([string]$line.Line -match "LISTENING\s+(\d+)\s*$")) {
                    $processIds.Add([int]$Matches[1]) | Out-Null
                }
            }
        } catch {
        }

        return @($processIds | Sort-Object -Unique)
    }

    try {
        $lsof = Get-Command lsof -ErrorAction SilentlyContinue
        if ($lsof) {
            $output = & $lsof.Source "-nP" "-iTCP:$Port" "-sTCP:LISTEN" "-t" 2>$null
            $processIds = @(
                $output |
                    ForEach-Object { [string]$_ } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    ForEach-Object { $_.Trim() } |
                    Select-Object -Unique
            )
            if ($processIds.Count -gt 0) {
                return @($processIds | ForEach-Object { [int]$_ })
            }
        }
    } catch {
    }

    return @()
}

function Get-SharedListeningProcessId {
    param([Parameter(Mandatory = $true)][int]$Port)

    $processIds = @(Get-SharedListeningProcessIds -Port $Port)
    if ($processIds.Count -gt 0) {
        return [int]$processIds[0]
    }

    return 0
}

function Get-SharedChildProcessIds {
    param([Parameter(Mandatory = $true)][int]$ParentId)

    $children = New-Object System.Collections.Generic.List[int]
    if ($ParentId -le 0 -or (Test-SharedIsWindows)) {
        return @()
    }

    try {
        $psCommand = Get-Command ps -ErrorAction SilentlyContinue
        if (-not $psCommand) {
            return @()
        }

        $lines = & $psCommand.Source "-o" "pid=" "--ppid" "$ParentId" 2>$null
        foreach ($line in @($lines)) {
            $value = [string]$line
            if ([string]::IsNullOrWhiteSpace($value)) {
                continue
            }

            $childId = 0
            if ([int]::TryParse($value.Trim(), [ref]$childId) -and $childId -gt 0) {
                $children.Add($childId) | Out-Null
                foreach ($descendant in @(Get-SharedChildProcessIds -ParentId $childId)) {
                    $children.Add([int]$descendant) | Out-Null
                }
            }
        }
    } catch {
    }

    return @($children | Select-Object -Unique)
}

function Stop-SharedProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    if ($ProcessId -le 0) {
        return
    }

    if (Test-SharedIsWindows) {
        try {
            $null = cmd.exe /d /c "taskkill /PID $ProcessId /T /F" 2>$null
        } catch {
            try {
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            } catch {
            }
        }
        return
    }

    $targets = New-Object System.Collections.Generic.List[int]
    foreach ($childId in @(Get-SharedChildProcessIds -ParentId $ProcessId)) {
        $targets.Add([int]$childId) | Out-Null
    }
    $targets.Add($ProcessId) | Out-Null

    foreach ($target in @($targets | Sort-Object -Descending -Unique)) {
        try {
            Stop-Process -Id ([int]$target) -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Get-SharedMutexName {
    param([Parameter(Mandatory = $true)][string]$BaseName)

    if (Test-SharedIsWindows) {
        return "Global\$BaseName"
    }

    return $BaseName
}

function Start-SharedShellProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )

    $parameters = @{
        PassThru = $true
    }

    if (Test-SharedIsWindows) {
        $parameters.FilePath = "cmd.exe"
        $parameters.ArgumentList = @("/d", "/s", "/c", $Command)
        $parameters.WindowStyle = "Hidden"
    } else {
        $shell = Get-Command bash -ErrorAction SilentlyContinue
        $shellPath = if ($shell) { $shell.Source } else { "/bin/bash" }
        $parameters.FilePath = $shellPath
        $parameters.ArgumentList = @("-lc", $Command)
    }

    if (-not [string]::IsNullOrWhiteSpace($StdoutPath)) {
        $parameters.RedirectStandardOutput = $StdoutPath
    }
    if (-not [string]::IsNullOrWhiteSpace($StderrPath)) {
        $parameters.RedirectStandardError = $StderrPath
    }

    return Start-Process @parameters
}

function New-SharedDirectoryLink {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$SourcePath
    )

    $parent = Split-Path -Parent $TargetPath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }

    if (Test-Path -LiteralPath $TargetPath) {
        Remove-Item -LiteralPath $TargetPath -Force -Recurse
    }

    if (Test-SharedIsWindows) {
        try {
            [void](New-Item -ItemType Junction -Path $TargetPath -Target $SourcePath -Force)
            return
        } catch {
            $mklinkOutput = Invoke-SharedShellCommand -Command ('mklink /J "{0}" "{1}"' -f $TargetPath, $SourcePath) 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw ("Failed to create junction '{0}' -> '{1}': {2}" -f $TargetPath, $SourcePath, (($mklinkOutput | Out-String).Trim()))
            }
            return
        }
    }

    try {
        [void](New-Item -ItemType SymbolicLink -Path $TargetPath -Target $SourcePath -Force)
    } catch {
        throw ("Failed to create symlink '{0}' -> '{1}': {2}" -f $TargetPath, $SourcePath, $_.Exception.Message)
    }
}
