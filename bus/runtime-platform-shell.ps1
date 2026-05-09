Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-shell.ps1
# Shell / process launching and argument encoding utilities.
# Depends on: runtime-platform-paths.ps1, runtime-platform-runtimes.ps1,
#             runtime-platform-env.ps1
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"
. "$PSScriptRoot\runtime-platform-runtimes.ps1"

function Get-SharedPowerShellFileArguments {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    $prefix = if (Test-SharedIsWindows) {
        @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $ScriptPath)
    } else {
        @("-NoProfile", "-File", $ScriptPath)
    }

    return @($prefix + @($ArgumentList))
}

function ConvertTo-SharedStringArray {
    param([AllowNull()]$Value)

    $items = New-Object System.Collections.Generic.List[string]
    foreach ($entry in @($Value)) {
        if ($null -eq $entry) {
            continue
        }

        foreach ($piece in ([string]$entry).Split(",")) {
            $trimmed = $piece.Trim()
            if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
                $items.Add($trimmed) | Out-Null
            }
        }
    }

    return @($items | Select-Object -Unique)
}

function Resolve-SharedOptionalPathArgument {
    param(
        [AllowEmptyString()][string]$Path,
        [Parameter(Mandatory = $true)][string]$ParameterName,
        [switch]$RequireExisting
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $trimmed = $Path.Trim()
    if (($trimmed -eq "-") -or ($trimmed -eq "--") -or ($trimmed -match '^[/-]{1,2}[A-Za-z0-9][A-Za-z0-9-]*$')) {
        throw ("Invalid value for -{0}: '{1}' looks like another switch. Pass a real directory path after -{0}." -f $ParameterName, $trimmed)
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($trimmed)
    } catch {
        throw ("Invalid value for -{0}: '{1}'. {2}" -f $ParameterName, $trimmed, $_.Exception.Message)
    }

    if ($RequireExisting -and -not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw ("Invalid value for -{0}: '{1}' does not exist." -f $ParameterName, $fullPath)
    }

    return $fullPath
}

function ConvertTo-ShellLiteral {
    param([AllowEmptyString()][string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    if (Test-SharedIsWindows) {
        return '"' + ([string]$Value -replace '"', '\"') + '"'
    }

    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $replacement = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    $escapedValue = [string]$Value -replace [regex]::Escape($singleQuote), $replacement
    return "'$escapedValue'"
}

function ConvertTo-SharedWindowsCommandArgument {
    param([AllowEmptyString()][string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    $text = [string]$Value
    if ($text.Length -eq 0) {
        return '""'
    }

    if ($text -notmatch '[\s"]') {
        return $text
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashCount = 0
    foreach ($character in $text.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount++
            continue
        }

        if ($character -eq '"') {
            [void]$builder.Append(([string]::new('\', ($backslashCount * 2) + 1)))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append(([string]::new('\', $backslashCount)))
            $backslashCount = 0
        }

        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append(([string]::new('\', $backslashCount * 2)))
    }

    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-SharedPowerShellLiteral {
    param([AllowEmptyString()][string]$Value)

    if ($null -eq $Value) {
        return "''"
    }

    return "'" + ([string]$Value -replace "'", "''") + "'"
}

function Join-SharedWindowsProcessArguments {
    param([string[]]$Arguments = @())

    return [string]::Join(" ", @($Arguments | ForEach-Object { ConvertTo-SharedWindowsCommandArgument -Value ([string]$_) }))
}

function ConvertTo-SharedPowerShellEncodedCommand {
    param([Parameter(Mandatory = $true)][string]$Command)

    return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
}

function Build-SharedPowerShellInvocation {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("&") | Out-Null
    $parts.Add((ConvertTo-SharedPowerShellLiteral -Value $FilePath)) | Out-Null
    foreach ($arg in @($ArgumentList)) {
        $parts.Add((ConvertTo-SharedPowerShellLiteral -Value ([string]$arg))) | Out-Null
    }

    return [string]::Join(" ", @($parts))
}

function ConvertTo-SharedPosixShellLiteral {
    param([AllowEmptyString()][string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $replacement = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    $escapedValue = [string]$Value -replace [regex]::Escape($singleQuote), $replacement
    return "'$escapedValue'"
}

function ConvertTo-SharedProcessCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $parts = New-Object System.Collections.Generic.List[string]
    if (Test-SharedIsWindows) {
        $parts.Add((ConvertTo-SharedWindowsCommandArgument -Value $FilePath)) | Out-Null
        foreach ($arg in @($ArgumentList)) {
            $parts.Add((ConvertTo-SharedWindowsCommandArgument -Value ([string]$arg))) | Out-Null
        }
    } else {
        $parts.Add((ConvertTo-SharedPosixShellLiteral -Value $FilePath)) | Out-Null
        foreach ($arg in @($ArgumentList)) {
            $parts.Add((ConvertTo-SharedPosixShellLiteral -Value ([string]$arg))) | Out-Null
        }
    }

    return [string]::Join(" ", @($parts))
}

# ---------------------------------------------------------------------------
# Windows-only process starting helpers
# ---------------------------------------------------------------------------

function Resolve-SharedWindowsScriptHostExecutable {
    if (-not (Test-SharedIsWindows)) {
        return ""
    }

    $command = Get-Command wscript.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        return $command.Source
    }

    return "wscript.exe"
}

function Start-SharedWindowsHiddenPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string]$WorkingDirectory = ""
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Resolve-SharedPowerShellExecutable
    $startInfo.Arguments = Join-SharedWindowsProcessArguments -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-EncodedCommand", (ConvertTo-SharedPowerShellEncodedCommand -Command $Command)
    )
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    return $process
}

function Start-SharedWindowsDetachedHiddenCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = ""
    )

    $effectiveWorkingDirectory = if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $WorkingDirectory
    } else {
        try {
            (Get-Location).ProviderPath
        } catch {
            ""
        }
    }

    $launcherPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".vbs")
    try {
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add('Set shell = CreateObject("Wscript.Shell")') | Out-Null
        if (-not [string]::IsNullOrWhiteSpace($effectiveWorkingDirectory)) {
            $lines.Add(('shell.CurrentDirectory = "{0}"' -f ($effectiveWorkingDirectory -replace '"', '""'))) | Out-Null
        }
        foreach ($entry in @($Environment.GetEnumerator())) {
            $key = ([string]$entry.Key -replace '"', '""')
            $value = ([string]$entry.Value -replace '"', '""')
            $lines.Add(('shell.Environment("Process")("{0}") = "{1}"' -f $key, $value)) | Out-Null
        }
        $lines.Add(('shell.Run "{0}", 0, False' -f ($Command -replace '"', '""'))) | Out-Null
        [System.IO.File]::WriteAllText($launcherPath, ([string]::Join([Environment]::NewLine, @($lines)) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = Resolve-SharedWindowsScriptHostExecutable
        $startInfo.Arguments = Join-SharedWindowsProcessArguments -Arguments @("//B", "//NoLogo", $launcherPath)
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        if (-not [string]::IsNullOrWhiteSpace($effectiveWorkingDirectory)) {
            $startInfo.WorkingDirectory = $effectiveWorkingDirectory
        }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()

        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            try {
                if (-not [string]::IsNullOrWhiteSpace($launcherPath) -and (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
                    Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
                }
            } catch {
            }

            if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
                break
            }
            Start-Sleep -Milliseconds 200
        }

        return $process
    } catch {
        if (-not [string]::IsNullOrWhiteSpace($launcherPath) -and (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
            Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Start-SharedWindowsDetachedPowerShellFile {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = ""
    )

    $executable = Resolve-SharedPowerShellExecutable
    $arguments = Get-SharedPowerShellFileArguments -ScriptPath $ScriptPath -ArgumentList $ArgumentList
    $command = Join-SharedWindowsProcessArguments -Arguments (@($executable) + @($arguments))
    return Start-SharedWindowsDetachedHiddenCommand -Command $command -Environment $Environment -WorkingDirectory $WorkingDirectory
}

function Start-SharedWindowsDetachedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = "",
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )

    $effectiveWorkingDirectory = if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $WorkingDirectory
    } else {
        try {
            (Get-Location).ProviderPath
        } catch {
            ""
        }
    }

    foreach ($capturePath in @($StdoutPath, $StderrPath)) {
        if ([string]::IsNullOrWhiteSpace($capturePath)) {
            continue
        }

        $captureParent = Split-Path -Parent $capturePath
        if (-not [string]::IsNullOrWhiteSpace($captureParent) -and -not (Test-Path -LiteralPath $captureParent -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $captureParent -Force)
        }
    }

    $specPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".json")
    $launcherScriptPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".ps1")

    try {
        $invocationSpec = @{
            executable      = $FilePath
            arguments       = @($ArgumentList)
            workingDirectory = $effectiveWorkingDirectory
            stdoutPath      = $StdoutPath
            stderrPath      = $StderrPath
        } | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($specPath, $invocationSpec, (New-Object System.Text.UTF8Encoding($false)))

        $specLiteral = $specPath -replace "'", "''"
        $launcherTemplate = @'
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -LiteralPath '__SPEC_PATH__' -Encoding utf8 | ConvertFrom-Json
$launcherPath = $MyInvocation.MyCommand.Path
$arguments = @()
foreach ($argument in @($spec.arguments)) {
    $arguments += [string]$argument
}
if (-not [string]::IsNullOrWhiteSpace([string]$spec.workingDirectory)) {
    Set-Location -LiteralPath ([string]$spec.workingDirectory)
}

$stdoutPath = [string]$spec.stdoutPath
$stderrPath = [string]$spec.stderrPath
try {
    if (Test-Path -LiteralPath '__SPEC_PATH__' -PathType Leaf) {
        Remove-Item -LiteralPath '__SPEC_PATH__' -Force -ErrorAction SilentlyContinue
    }
} catch {
}

$exitCode = 0
try {
    if (-not [string]::IsNullOrWhiteSpace($stdoutPath) -and -not [string]::IsNullOrWhiteSpace($stderrPath)) {
        & ([string]$spec.executable) @arguments 1> $stdoutPath 2> $stderrPath
    } elseif (-not [string]::IsNullOrWhiteSpace($stdoutPath)) {
        & ([string]$spec.executable) @arguments 1> $stdoutPath
    } elseif (-not [string]::IsNullOrWhiteSpace($stderrPath)) {
        & ([string]$spec.executable) @arguments 2> $stderrPath
    } else {
        & ([string]$spec.executable) @arguments
    }
    $exitCode = $LASTEXITCODE
} finally {
    try {
        if (-not [string]::IsNullOrWhiteSpace($launcherPath) -and (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
            Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
}
exit $exitCode
'@
        $launcherContent = $launcherTemplate.Replace('__SPEC_PATH__', $specLiteral)
        [System.IO.File]::WriteAllText($launcherScriptPath, $launcherContent, (New-Object System.Text.UTF8Encoding($false)))

        $process = Start-SharedWindowsDetachedPowerShellFile `
            -ScriptPath $launcherScriptPath `
            -Environment $Environment `
            -WorkingDirectory $effectiveWorkingDirectory
        return $process
    } catch {
        foreach ($tempPath in @($specPath, $launcherScriptPath)) {
            if ([string]::IsNullOrWhiteSpace($tempPath)) {
                continue
            }

            try {
                if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
                    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
                }
            } catch {
            }
        }
        throw
    }
}

function Start-SharedWindowsDetachedShellProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = "",
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )

    return Start-SharedWindowsDetachedProcess `
        -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/s", "/c", $Command) `
        -Environment $Environment `
        -WorkingDirectory $WorkingDirectory `
        -StdoutPath $StdoutPath `
        -StderrPath $StderrPath
}

function Start-SharedWindowsHeadlessProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = ""
    )

    # On Windows, PowerShell -File ignores CreateNoWindow=true and always allocates
    # a console. Inject -WindowStyle Hidden so child processes stay invisible.
    $isWindowsPowerShell = $FilePath -replace '\\', '/' -like '*/powershell.exe'
    if ($isWindowsPowerShell -and $ArgumentList -notcontains '-WindowStyle') {
        $ArgumentList = @('-WindowStyle', 'Hidden') + @($ArgumentList)
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = Join-SharedWindowsProcessArguments -Arguments $ArgumentList
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }

    foreach ($entry in @($Environment.GetEnumerator())) {
        $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    return $process
}

# ---------------------------------------------------------------------------
# Cross-platform background process launcher
# ---------------------------------------------------------------------------

function Start-SharedBackgroundProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = "",
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )

    if (Test-SharedIsWindows) {
        if ([string]::IsNullOrWhiteSpace($StdoutPath) -and [string]::IsNullOrWhiteSpace($StderrPath)) {
            return Start-SharedWindowsHeadlessProcess `
                -FilePath $FilePath `
                -ArgumentList $ArgumentList `
                -Environment $Environment `
                -WorkingDirectory $WorkingDirectory
        }

        $effectiveWorkingDirectory = if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            $WorkingDirectory
        } else {
            try {
                (Get-Location).ProviderPath
            } catch {
                ""
            }
        }

        foreach ($capturePath in @($StdoutPath, $StderrPath)) {
            if ([string]::IsNullOrWhiteSpace($capturePath)) {
                continue
            }

            $captureParent = Split-Path -Parent $capturePath
            if (-not [string]::IsNullOrWhiteSpace($captureParent) -and -not (Test-Path -LiteralPath $captureParent -PathType Container)) {
                [void](New-Item -ItemType Directory -Path $captureParent -Force)
            }
        }

        $specPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".json")
        $launcherScriptPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".ps1")

        try {
            $invocationSpec = @{
                executable      = $FilePath
                arguments        = @($ArgumentList)
                workingDirectory = $effectiveWorkingDirectory
                stdoutPath       = $StdoutPath
                stderrPath       = $StderrPath
            } | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText($specPath, $invocationSpec, (New-Object System.Text.UTF8Encoding($false)))

            $specLiteral = $specPath -replace "'", "''"
            $launcherTemplate = @'
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -LiteralPath '__SPEC_PATH__' -Encoding utf8 | ConvertFrom-Json
$launcherPath = $MyInvocation.MyCommand.Path
$arguments = @()
foreach ($argument in @($spec.arguments)) {
    $arguments += [string]$argument
}
if (-not [string]::IsNullOrWhiteSpace([string]$spec.workingDirectory)) {
    Set-Location -LiteralPath ([string]$spec.workingDirectory)
}

$stdoutPath = [string]$spec.stdoutPath
$stderrPath = [string]$spec.stderrPath
try {
    if (Test-Path -LiteralPath '__SPEC_PATH__' -PathType Leaf) {
        Remove-Item -LiteralPath '__SPEC_PATH__' -Force -ErrorAction SilentlyContinue
    }
} catch {
}

$exitCode = 0
try {
    if (-not [string]::IsNullOrWhiteSpace($stdoutPath) -and -not [string]::IsNullOrWhiteSpace($stderrPath)) {
        & ([string]$spec.executable) @arguments 1> $stdoutPath 2> $stderrPath
    } elseif (-not [string]::IsNullOrWhiteSpace($stdoutPath)) {
        & ([string]$spec.executable) @arguments 1> $stdoutPath
    } elseif (-not [string]::IsNullOrWhiteSpace($stderrPath)) {
        & ([string]$spec.executable) @arguments 2> $stderrPath
    } else {
        & ([string]$spec.executable) @arguments
    }
    $exitCode = $LASTEXITCODE
} finally {
    try {
        if (-not [string]::IsNullOrWhiteSpace($launcherPath) -and (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
            Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
}
exit $exitCode
'@
            $launcherContent = $launcherTemplate.Replace('__SPEC_PATH__', $specLiteral)
            [System.IO.File]::WriteAllText($launcherScriptPath, $launcherContent, (New-Object System.Text.UTF8Encoding($false)))

            $process = Start-SharedWindowsHeadlessProcess `
                -FilePath (Resolve-SharedPowerShellExecutable) `
                -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $launcherScriptPath -ArgumentList @()) `
                -Environment $Environment `
                -WorkingDirectory $effectiveWorkingDirectory
            return $process
        } catch {
            foreach ($tempPath in @($specPath, $launcherScriptPath)) {
                if ([string]::IsNullOrWhiteSpace($tempPath)) {
                    continue
                }

                try {
                    if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
                        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
                    }
                } catch {
                }
            }
            throw
        }
    }

    $parameters = @{
        FilePath  = $FilePath
        ArgumentList = $ArgumentList
        PassThru  = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $parameters.WorkingDirectory = $WorkingDirectory
    }
    if (-not [string]::IsNullOrWhiteSpace($StdoutPath)) {
        $parameters.RedirectStandardOutput = $StdoutPath
    }
    if (-not [string]::IsNullOrWhiteSpace($StderrPath)) {
        $parameters.RedirectStandardError = $StderrPath
    }

    return Start-Process @parameters
}

function Invoke-SharedShellCommand {
    param([Parameter(Mandatory = $true)][string]$Command)

    if (Test-SharedIsWindows) {
        # NOTE: & cmd.exe /d /s /c runs the command synchronously (this function
        # blocks until the child exits). Callers that need async background execution
        # should use Start-SharedShellProcess instead.
        # The spawned child does NOT get -WindowStyle Hidden here because this
        # function is used for short-lived commands where a brief visible window
        # is acceptable. For long-running servers that must stay hidden, use
        # Start-SharedShellProcess (Windows branch) which uses Start-SharedWindows
        # HeadlessProcess with CREATE_NO_WINDOW.
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
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = ""
    )

    $executable = Resolve-SharedPowerShellExecutable
    $args = Get-SharedPowerShellFileArguments -ScriptPath $ScriptPath -ArgumentList $ArgumentList
    return Start-SharedBackgroundProcess -FilePath $executable -ArgumentList $args -Environment $Environment -WorkingDirectory $WorkingDirectory
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

function Start-SharedShellProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = "",
        [string]$StdoutPath = "",
        [string]$StderrPath = ""
    )

    if (Test-SharedIsWindows) {
        return Start-SharedBackgroundProcess -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $Command) -Environment $Environment -WorkingDirectory $WorkingDirectory -StdoutPath $StdoutPath -StderrPath $StderrPath
    }

    $shell = Get-Command bash -ErrorAction SilentlyContinue
    $shellPath = if ($shell) { $shell.Source } else { "/bin/bash" }
    $effectiveCommand = $Command
    if ($Environment.Count -gt 0) {
        $exports = New-Object System.Collections.Generic.List[string]
        foreach ($entry in @($Environment.GetEnumerator())) {
            $exports.Add(('export {0}={1}' -f [string]$entry.Key, (ConvertTo-SharedPosixShellLiteral -Value ([string]$entry.Value)))) | Out-Null
        }
        $effectiveCommand = ([string]::Join("; ", @($exports))) + "; " + $effectiveCommand
    }
    return Start-SharedBackgroundProcess -FilePath $shellPath -ArgumentList @("-lc", $effectiveCommand) -WorkingDirectory $WorkingDirectory -StdoutPath $StdoutPath -StderrPath $StderrPath
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
            # Use PowerShell's native New-Item -ItemType Junction instead of cmd.exe mklink.
            # This avoids spawning a visible cmd.exe window.
            [void](New-Item -ItemType Junction -Path $TargetPath -Target $SourcePath -Force)
            return
        } catch {
            # If PowerShell junction creation fails (e.g. insufficient privilege),
            # fall back to Invoke-SharedShellCommand which now uses a hidden cmd.exe.
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
