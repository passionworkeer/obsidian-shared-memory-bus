# ============================================================================
# Watchdog-Process.ps1 - Process management functions
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Get-NodeExecutable, Start-NodeProcess, Get-NodeScriptProcesses,
#            Test-ProcessIdAlive, Get-PowerShellScriptProcesses,
#            Test-PowerShellScriptRunning, Start-DetachedPowerShellScript
# ============================================================================

function Get-NodeExecutable {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    $nodeExe = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:APPDATA "nvm\v" + (Get-ChildItem "$env:APPDATA\nvm\v" -ErrorAction SilentlyContinue | Select-Object -Last 1).Name "node.exe"),
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "/usr/local/bin/node",
        "/usr/bin/node"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    return $nodeExe
}

function Start-NodeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string]$Name = "",
        [string[]]$ArgumentList = @(),
        [switch]$WaitForExit,
        [int]$TimeoutSeconds = 0
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Write-WatchdogTrace -Step "node.notfound" -Data @{ script = $ScriptPath }
        return $null
    }

    $nodeExe = Get-NodeExecutable
    if (-not $nodeExe) {
        Write-WatchdogTrace -Step "node.missing"
        return $null
    }

    $processName = if ($Name) { $Name } else { [System.IO.Path]::GetFileNameWithoutExtension($ScriptPath) }
    $args = @($ScriptPath) + $ArgumentList
    $argString = $args -join " "

    Write-WatchdogTrace -Step "node.start" -Data @{ name = $processName; script = $ScriptPath; args = $argString }

    try {
        if ($WaitForExit) {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $nodeExe
            $psi.Arguments = $argString
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.WorkingDirectory = Split-Path -Parent $ScriptPath
            $proc = [System.Diagnostics.Process]::Start($psi)
            $stdout = $proc.StandardOutput.ReadToEnd()
            $stderr = $proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
            Write-WatchdogTrace -Step "node.exit" -Data @{ name = $processName; code = $proc.ExitCode }
            return @{
                ExitCode = $proc.ExitCode
                Stdout = $stdout
                Stderr = $stderr
            }
        } else {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $nodeExe
            $psi.Arguments = $argString
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $false
            $psi.RedirectStandardError = $false
            $psi.WorkingDirectory = Split-Path -Parent $ScriptPath
            $psi.CreateNoWindow = $true
            $proc = [System.Diagnostics.Process]::Start($psi)
            return $proc.Id
        }
    } catch {
        Write-WatchdogTrace -Step "node.error" -Data @{ script = $ScriptPath; error = $_.Exception.Message }
        return $null
    }
}

function Get-NodeScriptProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName
    )

    $nodeExe = Get-NodeExecutable
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match [regex]::Escape($ScriptName)
        })

    return @($processes | ForEach-Object { $_.ProcessId })
}

function Test-ProcessIdAlive {
    param(
        [Parameter(Mandatory = $true)][int]$Pid
    )

    if ($Pid -le 0) { return $false }
    try {
        $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
        return $null -ne $proc
    } catch {
        return $false
    }
}

function Get-PowerShellScriptProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName
    )

    $processes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match [regex]::Escape($ScriptName)
        })

    return @($processes | ForEach-Object { $_.ProcessId })
}

function Test-PowerShellScriptRunning {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName
    )

    $pids = Get-PowerShellScriptProcesses -ScriptName $ScriptName
    return $pids.Count -gt 0
}

function Start-DetachedPowerShellScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string]$Name = "",
        [string[]]$ArgumentList = @()
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Write-WatchdogTrace -Step "pwsh.file.missing" -Data @{ path = $ScriptPath }
        return $null
    }

    $processName = if ($Name) { $Name } else { [System.IO.Path]::GetFileNameWithoutExtension($ScriptPath) }
    $argString = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$ScriptPath`"") + $ArgumentList |
        ForEach-Object { $_ } | Where-Object { $_ -ne "" } | Join-String -Separator " "

    Write-WatchdogTrace -Step "pwsh.start" -Data @{ name = $processName; script = $ScriptPath }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "powershell.exe"
        $psi.Arguments = $argString
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $false
        $psi.RedirectStandardError = $false
        $psi.WorkingDirectory = Split-Path -Parent $ScriptPath
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        return $proc.Id
    } catch {
        Write-WatchdogTrace -Step "pwsh.error" -Data @{ script = $ScriptPath; error = $_.Exception.Message }
        return $null
    }
}
