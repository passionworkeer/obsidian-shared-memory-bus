# ============================================================================
# Watchdog-Core.ps1 - Core utilities, locking, and state management
# ============================================================================
# Split from memory-watchdog.ps1 for maintainability
# Functions: Resolve-BusPath, Ensure-Directory, Write-WatchdogErrorLog,
#            Write-WatchdogTrace, Read-TrimmedFileOrEmpty, Acquire-WatchdogLock,
#            Release-WatchdogLock, Write-State, Get-LastKnownSyncAt,
#            Set-LastKnownSyncAt, Wait-ProcessWithHeartbeat
# ============================================================================

# Ensure $AiMemoryRoot and $LockPath are set before sourcing
if (-not (Test-Path Variable:Global:AiMemoryRoot)) {
    throw "Watchdog-Core.ps1 requires `$AiMemoryRoot to be defined"
}
if (-not (Test-Path Variable:Global:LockPath)) {
    throw "Watchdog-Core.ps1 requires `$LockPath to be defined"
}
if (-not (Test-Path Variable:Global:StatePath)) {
    throw "Watchdog-Core.ps1 requires `$StatePath to be defined"
}

function Resolve-BusPath {
    param(
        [Parameter(Mandatory = $true)][string[]]$Candidates,
        [switch]$Directory
    )

    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($root in @($env:AI_MEMORY_ROOT, $PSScriptRoot, (Split-Path -Parent $PSScriptRoot))) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and -not $roots.Contains($root)) {
            $roots.Add($root) | Out-Null
        }
    }

    foreach ($root in @($roots)) {
        foreach ($candidate in @($Candidates)) {
            $path = Join-Path $root $candidate
            $pathType = if ($Directory) { "Container" } else { "Leaf" }
            if (Test-Path -LiteralPath $path -PathType $pathType) {
                return (Get-Item -LiteralPath $path).FullName
            }
        }
    }

    return (Join-Path $roots[0] $Candidates[0])
}

function Ensure-Directory {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir -PathType Container)) {
        $null = New-Item -Path $dir -ItemType Directory -Force -ErrorAction SilentlyContinue
    }
}

function Write-WatchdogErrorLog {
    param(
        [Parameter(Mandatory = $true)][object]$ErrorRecord,
        [string]$Context = "unknown"
    )

    if (-not $Global:ErrorLogPath) { return }
    Ensure-Directory -Path $Global:ErrorLogPath

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $message = "[{0}] [{1}] {2}`n{3}" -f $timestamp, $Context, $ErrorRecord.Exception.Message, $ErrorRecord.ScriptStackTrace
    try {
        [System.IO.File]::AppendAllText(
            $Global:ErrorLogPath,
            "$message`n",
            [System.Text.Encoding]::UTF8
        )
    } catch { }
}

function Test-WatchdogTraceEnabled {
    return $env:AI_MEMORY_WATCHDOG_TRACE -in @("1", "true", "yes", "on")
}

function Write-WatchdogTrace {
    param(
        [Parameter(Mandatory = $true)][string]$Step,
        [hashtable]$Data = @{}
    )

    if (-not (Test-WatchdogTraceEnabled)) { return }

    $timestamp = Get-Date -Format "HH:mm:ss.fff"
    $dataStr = if ($Data.Count -gt 0) {
        ($Data.GetEnumerator() | ForEach-Object {
            $v = $_.Value
            if ($v -is [array]) { $v = "[$($v -join ',')]" }
            elseif ($v -is [datetime]) { $v = $v.ToString("o") }
            elseif ($null -eq $v) { $v = "null" }
            "{0}={1}" -f $_.Key, $v
        }) -join " "
    } else { "" }

    $line = "[{0}] [{1}] {2} {3}" -f $timestamp, $Step, $env:COMPUTERNAME, $dataStr
    if ($Global:TraceLogPath) {
        Ensure-Directory -Path $Global:TraceLogPath
        try {
            [System.IO.File]::AppendAllText($Global:TraceLogPath, "$line`n", [System.Text.Encoding]::UTF8)
        } catch { }
    }
}

function Read-TrimmedFileOrEmpty {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ([string]::IsNullOrWhiteSpace($content)) {
                return ""
            }
            return $content.Trim()
        }
    } catch { }
    return ""
}

function Acquire-WatchdogLock {
    param(
        [int]$TimeoutSeconds = 5
    )

    $start = [DateTime]::UtcNow
    while (([DateTime]::UtcNow - $start).TotalSeconds -lt $TimeoutSeconds) {
        try {
            if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
                $content = Read-TrimmedFileOrEmpty -Path $LockPath
                if (-not [string]::IsNullOrWhiteSpace($content)) {
                    $pid = [int]::TryParse($content, [ref]$null) ? [int]$content : 0
                    if ($pid -gt 0 -and $pid -ne $PID -and (Test-ProcessIdAlive -Pid $pid)) {
                        Write-WatchdogTrace -Step "lock.held" -Data @{ pid = $pid; by = $PID }
                        Start-Sleep -Milliseconds 500
                        continue
                    }
                }
            }
            Ensure-Directory -Path $LockPath
            [System.IO.File]::WriteAllText($LockPath, "$PID", [System.Text.Encoding]::UTF8)
            Write-WatchdogTrace -Step "lock.acquired" -Data @{ pid = $PID }
            return $true
        } catch (System.IO.IOException) {
            Start-Sleep -Milliseconds 100
            continue
        } catch {
            Write-WatchdogTrace -Step "lock.error" -Data @{ error = $_.Exception.Message }
            return $false
        }
    }

    Write-WatchdogTrace -Step "lock.timeout"
    return $false
}

function Release-WatchdogLock {
    try {
        if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
            $content = Read-TrimmedFileOrEmpty -Path $LockPath
            $lockPid = if ([int]::TryParse($content, [ref]$null)) { [int]$content } else { -1 }
            if ($lockPid -eq $PID -or $lockPid -le 0) {
                Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
                Write-WatchdogTrace -Step "lock.released" -Data @{ pid = $PID }
            }
        }
    } catch { }
}

function Invoke-PowerShellFileWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [int]$TimeoutSeconds = 120,
        [string[]]$ArgumentList = @()
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        Write-WatchdogTrace -Step "pwsh.notfound" -Data @{ path = $FilePath }
        return $null
    }

    $tempOutput = [System.IO.Path]::GetTempPath() + [Guid]::NewGuid().ToString("N") + ".json"

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "pwsh"
        $psi.Arguments = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "`"$FilePath`"",
            "-OutputPath", "`"$tempOutput`""
        ) + $ArgumentList | ForEach-Object { $_ } | Where-Object { $_ -ne "" }
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $false
        $psi.RedirectStandardError = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $exited = $proc.WaitForExit($TimeoutSeconds * 1000)

        if (-not $exited) {
            try { $proc.Kill() } catch { }
            Write-WatchdogTrace -Step "pwsh.timeout" -Data @{ path = $FilePath; timeout = $TimeoutSeconds }
            return $null
        }

        if (Test-Path -LiteralPath $tempOutput -PathType Leaf) {
            $result = Get-Content -LiteralPath $tempOutput -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if (-not [string]::IsNullOrWhiteSpace($result)) {
                return $result | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Write-WatchdogTrace -Step "pwsh.error" -Data @{ path = $FilePath; error = $_.Exception.Message }
    } finally {
        try { Remove-Item -LiteralPath $tempOutput -Force -ErrorAction SilentlyContinue } catch { }
    }

    return $null
}

function Write-State {
    param(
        [bool]$Running,
        [string]$LastReason = "",
        [string[]]$ChangedSpecs = @(),
        $LastSyncAt = [datetime]::MinValue,
        $StructuredSignature = $null,
        $HeavySyncAt = $null
    )

    $state = @{
        running = $Running
        pid = $PID
        hostname = $env:COMPUTERNAME
        lastReason = $LastReason
        changedSpecs = @($ChangedSpecs)
        lastSyncAt = if ($LastSyncAt -and $LastSyncAt -ne [datetime]::MinValue) { $LastSyncAt.ToString("o") } else { $null }
        structuredSignature = $StructuredSignature
        lastHeavySyncAt = if ($HeavySyncAt) { $HeavySyncAt.ToString("o") } else { $null }
        timestamp = (Get-Date).ToString("o")
    }

    try {
        Ensure-Directory -Path $StatePath
        [System.IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
    } catch {
        Write-WatchdogTrace -Step "state.write.error" -Data @{ error = $_.Exception.Message }
    }
}

function Get-LastKnownSyncAt {
    param([datetime]$Default = [datetime]::MinValue)

    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        return $Default
    }

    try {
        $content = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        $state = $content | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
        if ($state -and $state.ContainsKey("lastSyncAt") -and -not [string]::IsNullOrWhiteSpace($state.lastSyncAt)) {
            return [datetime]::Parse($state.lastSyncAt)
        }
    } catch { }
    return $Default
}

function Set-LastKnownSyncAt {
    param([datetime]$Value)
    # State is persisted by Write-State, no-op here
}

function Wait-ProcessWithHeartbeat {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [int]$HeartbeatSeconds = 10,
        [int]$TimeoutSeconds = 300
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (-not (Test-ProcessIdAlive -Pid $ProcessId)) {
            return $false
        }
        Write-WatchdogTrace -Step "wait.heartbeat" -Data @{ pid = $ProcessId; elapsed = [int]$sw.Elapsed.TotalSeconds }
        Start-Sleep -Seconds $HeartbeatSeconds
    }
    return $true
}
