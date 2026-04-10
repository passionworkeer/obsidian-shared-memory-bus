param(
    [switch]$Daemon,
    [switch]$Once,
    [switch]$KeepRunningState,
    [int]$PollSeconds = 15,
    [int]$StaleMinutes = 5
)

$watchdogEnabled = [Environment]::GetEnvironmentVariable("AI_MEMORY_WATCHDOG_ENABLED")
if ($null -ne $watchdogEnabled -and $watchdogEnabled -in @("0", "false", "no", "off")) {
    Write-Output "[watchdog] disabled via AI_MEMORY_WATCHDOG_ENABLED=0"
    exit 0
}

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

$sourceRoot = Split-Path -Parent $PSScriptRoot
$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "bus/runtime-platform.ps1"),
    (Join-Path $sourceRoot "bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

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

$UserHome = Get-SharedUserHome
$AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { $PSScriptRoot }
$BusScript = Resolve-BusPath -Candidates @("memory-bus.ps1", "bus/memory-bus.ps1")
$LockPath = Join-Path $AiMemoryRoot "watchdog.lock"
$StatePath = Join-Path $AiMemoryRoot "watchdog-state.json"
$ErrorLogPath = Join-Path $AiMemoryRoot "watchdog-error.log"
$TraceLogPath = Join-Path $AiMemoryRoot "watchdog-trace.log"
$SharedMcpRoot = Join-Path $AiMemoryRoot "shared-mcp"
$SharedMcpStartScript = Join-Path $SharedMcpRoot "start-default-shared-mcp.ps1"
$SharedMcpStatusScript = Join-Path $SharedMcpRoot "status-shared-mcp.ps1"
$VaultRoot = Resolve-SharedObsidianVaultRoot -FallbackPath (Join-SharedPath @($UserHome, "Documents", "Obsidian Vault"))
$GlobalContextPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "generated", "GLOBAL-CONTEXT.md")
$MemoryLayersJsonPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "generated", "MEMORY-LAYERS.json")
$HandoffPackJsonPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "generated", "HANDOFF.json")
$AutoDreamJsonPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "generated", "AUTO-DREAM.json")
$StructuredRoot = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "structured")
$BlackboardDaemonScript = Resolve-BusPath -Candidates @("obsidian-blackboard-daemon.js", "ops/obsidian-blackboard-daemon.js")
$MD_PATH = Join-Path $VaultRoot "02-KB\WORKING.md"
$OpenClawSyncScript = Resolve-BusPath -Candidates @("sync-openclaw-to-obsidian.js", "ops/sync-openclaw-to-obsidian.js")
$BuildHandoffPackScript = Resolve-BusPath -Candidates @("build-handoff-pack.js", "ops/build-handoff-pack.js")
$BuildMemoryLayersScript = Resolve-BusPath -Candidates @("build-memory-layers.js", "ops/build-memory-layers.js")
$GenerateHygieneScript = Resolve-BusPath -Candidates @("generate-memory-hygiene-report.js", "ops/generate-memory-hygiene-report.js")
$MemoryDreamScript = Resolve-BusPath -Candidates @("run-memory-dream.ps1", "ops/run-memory-dream.ps1")
$MemoryArchivalScript = Resolve-BusPath -Candidates @("memory-archival.js", "ops/memory-archival.js")
$BackgroundExtractionScript = Resolve-BusPath -Candidates @("run-background-extraction.ps1", "ops/run-background-extraction.ps1")
$EmbeddingsScript = Resolve-BusPath -Candidates @("generate-embeddings.js", "bus/generate-embeddings.js")
$EmbeddingsIndexPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "embeddings", "index.jsonl")
$EmbeddingsCooldownSeconds = 180
$BusSyncTimeoutSeconds = 300
$GeneratedArtifactsTimeoutSeconds = 180
$WatchdogHeartbeatSeconds = [Math]::Max(5, [Math]::Min(15, $PollSeconds))
$BgExtractionIntervalHours = 6
$OpenClawWatchSpecNames = @("openclaw-sessions", "openclaw-memory", "openclaw-user", "openclaw-memory-md", "openclaw-jobs", "openclaw-runs", "openclaw-blackboard-db")
$OpenCodeDbPath = Join-SharedPath @((Get-SharedOpenCodeDataRoot), "opencode.db")
$VsCodeUserRoot = Get-SharedVsCodeUserRoot -ProductName "Code"
$CopilotGlobalStorage = Join-SharedPath @($VsCodeUserRoot, "globalStorage", "github.copilot-chat")
$CopilotWorkspaceStorage = Join-SharedPath @($VsCodeUserRoot, "workspaceStorage")
$TraeUserRoot = Get-SharedTraeUserRoot -ProductName "Trae"
$TraeCnUserRoot = Get-SharedTraeUserRoot -ProductName "Trae CN"
$CopilotCliSessionRoot = Join-SharedPath @((Get-SharedCopilotHomeRoot), "session-state")
$StructuredSignatureFiles = @(
    "shared-inbox.jsonl",
    "session-memory.jsonl",
    "shared-events.jsonl",
    "task-memory.jsonl",
    "claude-code.jsonl",
    "openclaw.jsonl",
    "openclaw-blackboard.jsonl",
    "openclaw-runs.jsonl",
    "openclaw-jobs.jsonl",
    "openclaw-journal.jsonl"
)
$WatchSpecs = @(
    [pscustomobject]@{ Name = "claude-user"; Tool = "claude-code"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".claude", "memory", "USER.md")) },
    [pscustomobject]@{ Name = "claude-memory"; Tool = "claude-code"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".claude", "memory", "MEMORY.md")) },
    [pscustomobject]@{ Name = "claude-today"; Tool = "claude-code"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".claude", "memory", "TODAY.md")) },
    [pscustomobject]@{ Name = "claude-session-memory"; Tool = "claude-code"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".claude", "session-memory", "session-memory.md")) },
    [pscustomobject]@{ Name = "claude-mem-db"; Tool = "claude-code"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".claude-mem", "claude-mem.db")) },
    [pscustomobject]@{ Name = "agents-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".agents", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250; MinPollSeconds = 120 },
    [pscustomobject]@{ Name = "codex-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".codex", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250; MinPollSeconds = 120 },
    [pscustomobject]@{ Name = "claude-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".claude", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250; MinPollSeconds = 120 },
    [pscustomobject]@{ Name = "codex-history"; Tool = "codex"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".codex", "history.jsonl")) },
    [pscustomobject]@{ Name = "codex-session-index"; Tool = "codex"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".codex", "session_index.jsonl")) },
    [pscustomobject]@{ Name = "codex-rollouts"; Tool = "codex"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".codex", "sessions")); Filter = "*.jsonl"; Recurse = $true; Top = 20; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "trae-user-rules"; Tool = "trae"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".trae", "user_rules.md")) },
    [pscustomobject]@{ Name = "trae-history"; Tool = "trae"; Type = "dir"; Path = (Join-SharedPath @($TraeUserRoot, "History")); Filter = "entries.json"; Recurse = $true; Top = 10; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "trae-history-cn"; Tool = "trae"; Type = "dir"; Path = (Join-SharedPath @($TraeCnUserRoot, "History")); Filter = "entries.json"; Recurse = $true; Top = 10; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "trae-mcp-user"; Tool = "trae"; Type = "file"; Path = (Join-SharedPath @($TraeUserRoot, "mcp.json")) },
    [pscustomobject]@{ Name = "trae-mcp-cn"; Tool = "trae"; Type = "file"; Path = (Join-SharedPath @($TraeCnUserRoot, "mcp.json")) },
    [pscustomobject]@{ Name = "openclaw-sessions"; Tool = "openclaw"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".openclaw", "agents", "main", "sessions")); Filter = "*.jsonl*"; Recurse = $false; Top = 10 },
    [pscustomobject]@{ Name = "openclaw-memory"; Tool = "openclaw"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".openclaw", "workspace", "memory")); Filter = "*.md"; Recurse = $false; Top = 6 },
    [pscustomobject]@{ Name = "openclaw-user"; Tool = "openclaw"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".openclaw", "workspace", "USER.md")) },
    [pscustomobject]@{ Name = "openclaw-memory-md"; Tool = "openclaw"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".openclaw", "workspace", "MEMORY.md")) },
    [pscustomobject]@{ Name = "openclaw-jobs"; Tool = "openclaw"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".openclaw", "cron", "jobs.json")) },
    [pscustomobject]@{ Name = "openclaw-runs"; Tool = "openclaw"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".openclaw", "subagents", "runs.json")) },
    [pscustomobject]@{ Name = "openclaw-blackboard-db"; Tool = "openclaw"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".openclaw", "workspace", "ai-shrimp", "blackboard", "tasks.db")) },
    [pscustomobject]@{ Name = "opencode-db"; Tool = "opencode"; Type = "file"; Path = $OpenCodeDbPath },
    [pscustomobject]@{ Name = "copilot-global-files"; Tool = "copilot"; Type = "dir"; Path = $CopilotGlobalStorage; Filter = "*"; Recurse = $true; Top = 8; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "copilot-workspaces"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "workspace.json"; Recurse = $true; Top = 20; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "copilot-chat-sessions"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "*.jsonl"; Recurse = $true; Top = 12; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "copilot-cli-workspaces"; Tool = "copilot"; Type = "dir"; Path = $CopilotCliSessionRoot; Filter = "workspace.yaml"; Recurse = $true; Top = 12; MinPollSeconds = 60 },
    [pscustomobject]@{ Name = "copilot-cli-events"; Tool = "copilot"; Type = "dir"; Path = $CopilotCliSessionRoot; Filter = "events.jsonl"; Recurse = $true; Top = 12; MinPollSeconds = 60 }
)
$script:LastKnownSyncAt = [datetime]::MinValue
$script:lastBgExtraction = [datetime]::MinValue
$script:lastHeavySyncSignature = $null
$script:lastHeavySyncAt = [datetime]::MinValue
$script:lastClaudeMemHealthCheck = [datetime]::MinValue
$ClaudeMemHealthIntervalSeconds = 300   # check every 5 min
$ClaudeMemPluginRoot = Join-Path $UserHome ".claude\plugins\marketplaces\thedotmack"
$ClaudeMemWorkerScript = Join-Path $ClaudeMemPluginRoot "plugin\scripts\worker-service.cjs"
$WatchdogVersionPath = Join-Path $AiMemoryRoot "watchdog.version"
$WatchdogVersion = "4"

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Write-WatchdogErrorLog {
    param(
        [Parameter(Mandatory = $true)]$ErrorRecord,
        [string]$Context = ""
    )

    try {
        Ensure-Directory -Path (Split-Path -Parent $ErrorLogPath)
        $details = [ordered]@{
            timestamp = (Get-Date).ToString("o")
            pid = $PID
            daemon = [bool]$Daemon
            context = $Context
            message = [string]$ErrorRecord
            exception = if ($null -ne $ErrorRecord.Exception) { [string]$ErrorRecord.Exception } else { "" }
            scriptStackTrace = if ($null -ne $ErrorRecord.ScriptStackTrace) { [string]$ErrorRecord.ScriptStackTrace } else { "" }
            lastReason = if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
                try {
                    ((Get-Content -Raw -LiteralPath $StatePath -Encoding utf8 | ConvertFrom-Json).lastReason | Out-String).Trim()
                } catch {
                    ""
                }
            } else {
                ""
            }
        }
        Add-Content -LiteralPath $ErrorLogPath -Value (($details | ConvertTo-Json -Depth 6 -Compress) + [Environment]::NewLine) -Encoding UTF8
    } catch {
    }
}

function Test-WatchdogTraceEnabled {
    foreach ($value in @(
            $env:AI_MEMORY_WATCHDOG_TRACE,
            [Environment]::GetEnvironmentVariable("AI_MEMORY_WATCHDOG_TRACE", "Process"),
            [Environment]::GetEnvironmentVariable("AI_MEMORY_WATCHDOG_TRACE", "User"),
            [Environment]::GetEnvironmentVariable("AI_MEMORY_WATCHDOG_TRACE", "Machine")
        )) {
        if ([string]::IsNullOrWhiteSpace([string]$value)) {
            continue
        }

        switch (([string]$value).Trim().ToLowerInvariant()) {
            "1" { return $true }
            "true" { return $true }
            "yes" { return $true }
            "on" { return $true }
        }
    }

    return $false
}

function Write-WatchdogTrace {
    param(
        [Parameter(Mandatory = $true)][string]$Step,
        [hashtable]$Data = @{}
    )

    if (-not (Test-WatchdogTraceEnabled)) {
        return
    }

    try {
        Ensure-Directory -Path (Split-Path -Parent $TraceLogPath)
        $payload = [ordered]@{
            timestamp = (Get-Date).ToString("o")
            pid = $PID
            step = $Step
            data = $Data
        }
        Add-Content -LiteralPath $TraceLogPath -Value (($payload | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine) -Encoding UTF8
    } catch {
    }
}

function Get-NodeExecutable {
    return (Resolve-SharedNodeExecutable)
}

function Get-LastKnownSyncAt {
    if ((Test-Path variable:script:LastKnownSyncAt) -and $script:LastKnownSyncAt -is [datetime] -and $script:LastKnownSyncAt -gt [datetime]::MinValue) {
        return $script:LastKnownSyncAt
    }

    return [datetime]::MinValue
}

function Set-LastKnownSyncAt {
    param([datetime]$Value)

    if ($Value -gt [datetime]::MinValue) {
        $script:LastKnownSyncAt = $Value
    }
}

function Read-TrimmedFileOrEmpty {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ""
    }

    $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    if ($null -eq $content) {
        return ""
    }

    return ([string]$content).Trim()
}

function Start-NodeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [switch]$PassThru
    )

    $workingDirectory = Split-Path -Parent $ScriptPath
    if (-not $PassThru -and (Test-SharedIsWindows)) {
        $process = Start-SharedWindowsHeadlessProcess `
            -FilePath (Get-NodeExecutable) `
            -ArgumentList @($ScriptPath) `
            -WorkingDirectory $workingDirectory
    } else {
        $process = Start-SharedBackgroundProcess `
            -FilePath (Get-NodeExecutable) `
            -ArgumentList @($ScriptPath) `
            -WorkingDirectory $workingDirectory
    }

    if ($PassThru) {
        return $process
    }

    return $null
}

function Get-NodeScriptProcesses {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return @()
    }

    $fullPath = (Get-Item -LiteralPath $ScriptPath).FullName.ToLowerInvariant()
    $fileName = [System.IO.Path]::GetFileName($fullPath)

    if (Test-SharedIsWindows) {
        return @(
            Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $cmd = [string]$_.CommandLine
                    if ([string]::IsNullOrWhiteSpace($cmd)) {
                        return $false
                    }
                    $lc = $cmd.ToLowerInvariant()
                    return $lc.Contains($fullPath) -or $lc.Contains($fileName)
                } |
                Sort-Object ProcessId
        )
    }

    $psCommand = Get-Command ps -ErrorAction SilentlyContinue
    if (-not $psCommand) {
        return @()
    }

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($line in @(& $psCommand.Source "-ax" "-o" "pid=,command=" 2>$null)) {
        $value = [string]$line
        if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^\s*(\d+)\s+(.+)$') {
            continue
        }

        $pid = [int]$Matches[1]
        $cmd = [string]$Matches[2]
        $lc = $cmd.ToLowerInvariant()
        if ($lc.Contains($fullPath) -or $lc.Contains($fileName)) {
            $records.Add([pscustomobject]@{
                ProcessId = $pid
                CommandLine = $cmd
            }) | Out-Null
        }
    }

    return @($records | Sort-Object ProcessId)
}

function Test-ProcessIdAlive {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return $false
    }

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-PowerShellScriptProcesses {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return @()
    }

    $fullPath = (Get-Item -LiteralPath $ScriptPath).FullName.ToLowerInvariant()
    $fileName = [System.IO.Path]::GetFileName($fullPath)

    if (Test-SharedIsWindows) {
        return @(
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $cmd = [string]$_.CommandLine
                    if ([string]::IsNullOrWhiteSpace($cmd)) {
                        return $false
                    }

                    $lc = $cmd.ToLowerInvariant()
                    return $lc.Contains($fullPath) -or $lc.Contains($fileName)
                } |
                Sort-Object ProcessId
        )
    }

    $psCommand = Get-Command ps -ErrorAction SilentlyContinue
    if (-not $psCommand) {
        return @()
    }

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($line in @(& $psCommand.Source "-ax" "-o" "pid=,command=" 2>$null)) {
        $value = [string]$line
        if ([string]::IsNullOrWhiteSpace($value) -or $value -notmatch '^\s*(\d+)\s+(.+)$') {
            continue
        }

        $pid = [int]$Matches[1]
        $cmd = [string]$Matches[2]
        $lc = $cmd.ToLowerInvariant()
        if ($lc.Contains($fullPath) -or $lc.Contains($fileName)) {
            $records.Add([pscustomobject]@{
                ProcessId = $pid
                CommandLine = $cmd
            }) | Out-Null
        }
    }

    return @($records | Sort-Object ProcessId)
}

function Test-PowerShellScriptRunning {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    return @(Get-PowerShellScriptProcesses -ScriptPath $ScriptPath).Count -gt 0
}

function Start-DetachedPowerShellScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @()
    )

    $workingDirectory = Split-Path -Parent $ScriptPath
    if (Test-SharedIsWindows) {
        return (Start-SharedWindowsDetachedPowerShellFile `
                -ScriptPath $ScriptPath `
                -ArgumentList $ArgumentList `
                -WorkingDirectory $workingDirectory)
    }

    return (Start-SharedPowerShellFile `
            -ScriptPath $ScriptPath `
            -ArgumentList $ArgumentList `
            -WorkingDirectory $workingDirectory)
}

function Acquire-WatchdogLock {
    Ensure-Directory -Path (Split-Path -Parent $LockPath)

    while ($true) {
        try {
            $stream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $payload = [ordered]@{
                pid       = $PID
                createdAt = (Get-Date).ToString("o")
            } | ConvertTo-Json -Depth 3
            $bytes = $Utf8NoBom.GetBytes($payload)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            $Script:WatchdogLockStream = $stream
            return $true
        } catch [System.IO.IOException] {
            $lockOwnerPid = 0
            if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
                try {
                    $lockData = Get-Content -Raw -LiteralPath $LockPath -Encoding utf8 | ConvertFrom-Json
                    if ($null -ne $lockData.pid) {
                        $lockOwnerPid = [int]$lockData.pid
                    }
                } catch {
                }
            }

            if ($lockOwnerPid -gt 0 -and (Test-ProcessIdAlive -ProcessId $lockOwnerPid)) {
                return $false
            }

            try {
                Remove-Item -LiteralPath $LockPath -Force -ErrorAction Stop
            } catch {
                return $false
            }

            Start-Sleep -Milliseconds 150
            continue
        }
    }
}

function Release-WatchdogLock {
    if ($Script:WatchdogLockStream) {
        try {
            $Script:WatchdogLockStream.Dispose()
        } catch {
        }
        $Script:WatchdogLockStream = $null
    }

    try {
        if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
            Remove-Item -LiteralPath $LockPath -Force
        }
    } catch {
    }
}

function Invoke-PowerShellFileWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = 60,
        [string]$WorkingDirectory = "",
        [string]$HeartbeatReason = ""
    )

    $stdoutPath = Join-Path $AiMemoryRoot ("tmp-" + [guid]::NewGuid().ToString("N") + ".stdout.log")
    $stderrPath = Join-Path $AiMemoryRoot ("tmp-" + [guid]::NewGuid().ToString("N") + ".stderr.log")
    Write-WatchdogTrace -Step "subprocess.start" -Data @{
        script = $ScriptPath
        timeoutSeconds = $TimeoutSeconds
        workingDirectory = $WorkingDirectory
        heartbeatReason = $HeartbeatReason
    }

    try {
        $proc = Start-SharedShellProcess `
            -Command (ConvertTo-SharedProcessCommand `
                -FilePath (Resolve-SharedPowerShellExecutable) `
                -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $ScriptPath -ArgumentList $ArgumentList)) `
            -WorkingDirectory $WorkingDirectory `
            -StdoutPath $stdoutPath `
            -StderrPath $stderrPath
        $resolvedHeartbeatReason = if ([string]::IsNullOrWhiteSpace($HeartbeatReason)) {
            "watchdog-subprocess:" + [System.IO.Path]::GetFileName($ScriptPath)
        } else {
            $HeartbeatReason
        }
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds $TimeoutSeconds `
            -Reason $resolvedHeartbeatReason `
            -LastSyncAt (Get-LastKnownSyncAt)
        $timedOut = [bool]$waitResult.timedOut
        if ($timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Start-Sleep -Milliseconds 150
        }

        Write-WatchdogTrace -Step "subprocess.finish" -Data @{
            script = $ScriptPath
            timedOut = $timedOut
            exitCode = if ($timedOut) { $null } else { $waitResult.exitCode }
        }
        return [pscustomobject]@{
            timedOut = $timedOut
            exitCode = if ($timedOut) { $null } else { $waitResult.exitCode }
            stdout = Read-TrimmedFileOrEmpty -Path $stdoutPath
            stderr = Read-TrimmedFileOrEmpty -Path $stderrPath
        }
    } finally {
        foreach ($tempPath in @($stdoutPath, $stderrPath)) {
            try {
                if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
                    Remove-Item -LiteralPath $tempPath -Force
                }
            } catch {
            }
        }
    }
}

function Write-State {
    param(
        [Parameter(Mandatory = $true)][bool]$Running,
        [string]$LastReason = "",
        [string[]]$ChangedSpecs = @(),
        [datetime]$LastSyncAt = [datetime]::MinValue,
        [string]$StructuredSignature = "",
        [string]$HeavySyncSignature = "",
        [datetime]$HeavySyncAt = [datetime]::MinValue
    )

    Ensure-Directory -Path (Split-Path -Parent $StatePath)
    if (-not [string]::IsNullOrWhiteSpace($StructuredSignature)) {
        $script:lastHeavySyncSignature = $StructuredSignature
    }
    if ($HeavySyncAt -gt [datetime]::MinValue) {
        $script:lastHeavySyncAt = $HeavySyncAt
    }
    $payload = [ordered]@{
        running = $Running
        pid = $PID
        daemon = [bool]$Daemon
        pollSeconds = $PollSeconds
        staleMinutes = $StaleMinutes
        updatedAt = (Get-Date).ToString("o")
        lastReason = $LastReason
        lastSyncAt = if ($LastSyncAt -gt [datetime]::MinValue) { $LastSyncAt.ToString("o") } else { $null }
        lastStructuredSignature = $script:lastHeavySyncSignature
        lastHeavySignature = $script:lastHeavySyncSignature
        lastHeavySyncAt = if ($script:lastHeavySyncAt -gt [datetime]::MinValue) { $script:lastHeavySyncAt.ToString("o") } else { $null }
        changedSpecs = $ChangedSpecs
        busScript = $BusScript
        globalContext = $GlobalContextPath
    }
    $tempPath = "$StatePath.tmp"
    [System.IO.File]::WriteAllText($tempPath, ($payload | ConvertTo-Json -Depth 6), $Utf8NoBom)
    Move-Item -LiteralPath $tempPath -Destination $StatePath -Force
}

function Wait-ProcessWithHeartbeat {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Reason,
        [datetime]$LastSyncAt = [datetime]::MinValue
    )

    $startedAt = Get-Date
    while (-not $Process.HasExited) {
        if (((Get-Date) - $startedAt).TotalSeconds -ge $TimeoutSeconds) {
            try {
                Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }

            return [pscustomobject]@{
                timedOut = $true
                exitCode = $null
            }
        }

        Start-Sleep -Seconds $WatchdogHeartbeatSeconds
        try {
            $Process.Refresh()
        } catch {
        }

        if (-not $Process.HasExited) {
            Write-WatchdogTrace -Step "subprocess.heartbeat" -Data @{
                reason = $Reason
                lastSyncAt = if ($LastSyncAt -gt [datetime]::MinValue) { $LastSyncAt.ToString("o") } else { $null }
            }
        }
    }

    return [pscustomobject]@{
        timedOut = $false
        exitCode = $Process.ExitCode
    }
}

function Get-WatchSpecPollSeconds {
    param([Parameter(Mandatory = $true)][pscustomobject]$Spec)

    if ($Spec.PSObject.Properties.Name -contains "MinPollSeconds") {
        $configured = [int]$Spec.MinPollSeconds
        if ($configured -gt $PollSeconds) {
            return $configured
        }
    }

    return $PollSeconds
}

function Write-WatchdogScanHeartbeat {
    param([Parameter(Mandatory = $true)][string]$SpecName)

    Write-State -Running $true -LastReason ("watchdog-scan:" + $SpecName) -ChangedSpecs @() -LastSyncAt (Get-LastKnownSyncAt) -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
}

function Get-DirectoryWatchStamp {
    param([Parameter(Mandatory = $true)][pscustomobject]$Spec)

    $topLimit = if (($Spec.PSObject.Properties.Name -contains "Top") -and ([int]$Spec.Top -gt 0)) { [int]$Spec.Top } else { 10 }
    $processed = 0
    $latest = New-Object System.Collections.Generic.List[object]
    $lastHeartbeatAt = Get-Date

    foreach ($file in (Get-ChildItem -LiteralPath $Spec.Path -File -Filter $Spec.Filter -Recurse:([bool]$Spec.Recurse) -ErrorAction SilentlyContinue)) {
        $processed++
        $candidate = [pscustomobject]@{
            FullName = $file.FullName
            LastWriteTicks = $file.LastWriteTimeUtc.Ticks
            Length = $file.Length
        }

        $insertAt = -1
        for ($i = 0; $i -lt $latest.Count; $i++) {
            $existing = $latest[$i]
            if (($candidate.LastWriteTicks -gt [int64]$existing.LastWriteTicks) -or
                (($candidate.LastWriteTicks -eq [int64]$existing.LastWriteTicks) -and ($candidate.FullName -lt [string]$existing.FullName))) {
                $insertAt = $i
                break
            }
        }

        if ($insertAt -ge 0) {
            $latest.Insert($insertAt, $candidate)
        } elseif ($latest.Count -lt $topLimit) {
            $latest.Add($candidate) | Out-Null
        }

        if ($latest.Count -gt $topLimit) {
            $latest.RemoveAt($latest.Count - 1)
        }

        $now = Get-Date
        if ((($processed % 250) -eq 0) -or (($now - $lastHeartbeatAt).TotalSeconds -ge $WatchdogHeartbeatSeconds)) {
            Write-WatchdogScanHeartbeat -SpecName $Spec.Name
            $lastHeartbeatAt = $now
        }
    }

    if ($latest.Count -eq 0) {
        return "__empty__"
    }

    return (@($latest | Sort-Object @{ Expression = "LastWriteTicks"; Descending = $true }, @{ Expression = "FullName"; Descending = $false }) | ForEach-Object {
        "{0}:{1}:{2}" -f $_.FullName, $_.LastWriteTicks, $_.Length
    }) -join "|"
}

function Get-WatchStamp {
    param([Parameter(Mandatory = $true)][pscustomobject]$Spec)

    if (-not (Test-Path -LiteralPath $Spec.Path)) {
        return "__missing__"
    }

    if ($Spec.Type -eq "file") {
        $item = Get-Item -LiteralPath $Spec.Path
        return "{0}:{1}:{2}" -f $item.FullName, $item.LastWriteTimeUtc.Ticks, $item.Length
    }

    return (Get-DirectoryWatchStamp -Spec $Spec)
}

function Get-FileContentHash {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return "__missing__"
    }

    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $hashBytes = $sha1.ComputeHash($stream)
        $hash = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
        $item = Get-Item -LiteralPath $Path
        return "{0}:{1}:{2}" -f $item.Name, $hash, $item.Length
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        $sha1.Dispose()
    }
}

function Get-StructuredDataSignature {
    if (-not (Test-Path -LiteralPath $StructuredRoot -PathType Container)) {
        return "__missing__"
    }

    return ($StructuredSignatureFiles | ForEach-Object {
        Get-FileContentHash -Path (Join-Path $StructuredRoot $_)
    }) -join "|"
}

function Test-StructuredArtifactsNeedRefresh {
    $currentStructuredSignature = Get-StructuredDataSignature
    $artifactPaths = @($MemoryLayersJsonPath, $HandoffPackJsonPath, $AutoDreamJsonPath)
    foreach ($artifactPath in $artifactPaths) {
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            return $true
        }

        $artifactPayload = $null
        try {
            $artifactPayload = Get-Content -Raw -LiteralPath $artifactPath -Encoding UTF8 | ConvertFrom-Json
        } catch {
            return $true
        }

        if ($null -eq $artifactPayload.sourceStructuredSignature -or
            [string]::IsNullOrWhiteSpace([string]$artifactPayload.sourceStructuredSignature.raw)) {
            return $true
        }

        if ([string]$artifactPayload.sourceStructuredSignature.raw -cne $currentStructuredSignature) {
            return $true
        }
    }

    return $false
}

function Invoke-BusSync {
    param([Parameter(Mandatory = $true)][string]$Reason)

    $lastSyncAt = [datetime]::MinValue
    if (Test-PowerShellScriptRunning -ScriptPath $BusScript) {
        Write-WatchdogTrace -Step "bussync.already-running" -Data @{ reason = $Reason }
        $lastSyncAt = Get-LastKnownSyncAt
    } else {
        try {
            Start-DetachedPowerShellScript `
                -ScriptPath $BusScript `
                -ArgumentList @("-Action", "SyncAll", "-Tool", "system", "-Project", "watchdog", "-Quiet") | Out-Null
            $lastSyncAt = Get-Date
            Set-LastKnownSyncAt -Value $lastSyncAt
            Write-WatchdogTrace -Step "bussync.launched" -Data @{
                reason = $Reason
                lastSyncAt = $lastSyncAt.ToString("o")
            }
        } catch {
            Write-WatchdogTrace -Step "bussync.catch" -Data @{
                reason = $Reason
                message = $_.Exception.Message
                type = if ($null -ne $_.Exception) { $_.Exception.GetType().FullName } else { "" }
            }
            Write-Warning "[watchdog] BusSync threw: $_"
        }
    }

    # Sync claude-mem observations → Obsidian structured/ (every 5th sync)
    if (-not (Test-Path variable:script:ClaudeMemCounter)) {
        $script:ClaudeMemCounter = 0
    }
    $script:ClaudeMemCounter++
    if ($script:ClaudeMemCounter % 5 -eq 0) {
        $syncScript = Resolve-BusPath -Candidates @("sync-claudemem-to-obsidian.ps1", "ops/sync-claudemem-to-obsidian.ps1")
        if (Test-Path $syncScript) {
            try {
                if (-not (Test-PowerShellScriptRunning -ScriptPath $syncScript)) {
                    Start-DetachedPowerShellScript -ScriptPath $syncScript | Out-Null
                    Write-WatchdogTrace -Step "claudememsync.launched" -Data @{ reason = $Reason }
                }
            } catch {
                Write-Warning "[watchdog] sync-claudemem-to-obsidian threw: $_"
            }
        }
    }

    Write-WatchdogTrace -Step "bussync.state.begin" -Data @{
        reason = $Reason
        lastSyncAt = if ($lastSyncAt -gt [datetime]::MinValue) { $lastSyncAt.ToString("o") } else { $null }
    }
    Write-State -Running $true -LastReason $Reason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
    Write-WatchdogTrace -Step "bussync.state.end" -Data @{
        reason = $Reason
        lastSyncAt = if ($lastSyncAt -gt [datetime]::MinValue) { $lastSyncAt.ToString("o") } else { $null }
    }
    return $lastSyncAt
}

function Invoke-RefreshGeneratedArtifacts {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if (Test-PowerShellScriptRunning -ScriptPath $BusScript) {
        Write-WatchdogTrace -Step "generatedartifacts.already-running" -Data @{ reason = $Reason }
        return $false
    }

    try {
        Start-DetachedPowerShellScript `
            -ScriptPath $BusScript `
            -ArgumentList @("-Action", "RefreshDerivedArtifacts", "-Quiet") | Out-Null
        Write-WatchdogTrace -Step "generatedartifacts.launched" -Data @{ reason = $Reason }
        return $false
    } catch {
        Write-State -Running $true -LastReason ("generated-artifacts-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Get-BlackboardDaemonProcesses {
    if (-not (Test-Path -LiteralPath $BlackboardDaemonScript -PathType Leaf)) {
        return @()
    }

    $scriptPath = (Get-Item -LiteralPath $BlackboardDaemonScript).FullName.ToLowerInvariant()
    $scriptName = [System.IO.Path]::GetFileName($scriptPath)
    $procs = @(Get-NodeScriptProcesses -ScriptPath $BlackboardDaemonScript | Where-Object {
        $cmd = [string]$_.CommandLine
        $lc = $cmd.ToLowerInvariant()
        return $lc.Contains($scriptPath) -or ($lc.Contains($scriptName) -and $lc.Contains(".ai-memory"))
    })
    if ($procs.Count -eq 0) {
        return @()
    }

    return @($procs | Sort-Object ProcessId)
}

function Test-NodeScriptRunning {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        return $false
    }

    $running = @(Get-NodeScriptProcesses -ScriptPath $ScriptPath)
    return $running.Count -gt 0
}

function Ensure-ObsidianBlackboardDaemon {
    if (-not (Test-Path -LiteralPath $BlackboardDaemonScript -PathType Leaf)) {
        return ""
    }

    $procs = @(Get-BlackboardDaemonProcesses)
    if ($procs.Count -gt 1) {
        $keep = $procs[0]
        $extras = @($procs | Select-Object -Skip 1)
        foreach ($extra in $extras) {
            try {
                Stop-Process -Id ([int]$extra.ProcessId) -Force -ErrorAction Stop
            } catch {
            }
        }
        return "blackboard-daemon-deduped:keep-pid-$([int]$keep.ProcessId),stopped-$($extras.Count)"
    }

    if ($procs.Count -eq 1) {
        return ""
    }

    # Verify WORKING.md is still accessible before spawning
    if (-not (Test-Path -LiteralPath $MD_PATH -PathType Leaf)) {
        Write-Warning "[watchdog] WORKING.md not accessible at ${MD_PATH}, skipping blackboard-daemon start"
        return "blackboard-daemon-skipped:working-md-missing"
    }

    Start-NodeProcess -ScriptPath $BlackboardDaemonScript | Out-Null
    Start-Sleep -Milliseconds 600
    $recheck = @(Get-BlackboardDaemonProcesses)
    if ($recheck.Count -gt 0) {
        return "blackboard-daemon-started:pid-$([int]$recheck[0].ProcessId)"
    }
    return "blackboard-daemon-start-failed"
}

function Invoke-OpenClawStructuredSync {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if (-not (Test-Path -LiteralPath $OpenClawSyncScript -PathType Leaf)) {
        return $false
    }

    try {
        $proc = Start-NodeProcess -ScriptPath $OpenClawSyncScript -PassThru
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds 30 `
            -Reason ("openclaw-sync:" + $Reason) `
            -LastSyncAt (Get-LastKnownSyncAt)
        if ($waitResult.timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("openclaw-sync-timeout:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }
        if ($waitResult.exitCode -ne 0) {
            Write-State -Running $true -LastReason ("openclaw-sync-exitcode-" + $waitResult.exitCode + ":" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }
        return $true
    } catch {
        Write-State -Running $true -LastReason ("openclaw-sync-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Invoke-BuildMemoryLayers {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if (-not (Test-Path -LiteralPath $BuildMemoryLayersScript -PathType Leaf)) {
        return $false
    }

    try {
        $proc = Start-NodeProcess -ScriptPath $BuildMemoryLayersScript -PassThru
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds 30 `
            -Reason ("memory-layers:" + $Reason) `
            -LastSyncAt (Get-LastKnownSyncAt)
        if ($waitResult.timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("memory-layers-timeout:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        if ($waitResult.exitCode -ne 0) {
            Write-State -Running $true -LastReason ("memory-layers-exitcode-" + $waitResult.exitCode + ":" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("memory-layers-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Invoke-BuildHandoffPack {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if (-not (Test-Path -LiteralPath $BuildHandoffPackScript -PathType Leaf)) {
        return $false
    }

    try {
        $proc = Start-NodeProcess -ScriptPath $BuildHandoffPackScript -PassThru
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds 30 `
            -Reason ("handoff-pack:" + $Reason) `
            -LastSyncAt (Get-LastKnownSyncAt)
        if ($waitResult.timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("handoff-pack-timeout:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        if ($waitResult.exitCode -ne 0) {
            Write-State -Running $true -LastReason ("handoff-pack-exitcode-" + $waitResult.exitCode + ":" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("handoff-pack-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Invoke-GenerateHygieneReport {
    if (-not (Test-Path -LiteralPath $GenerateHygieneScript -PathType Leaf)) {
        return $null
    }

    try {
        $proc = Start-NodeProcess -ScriptPath $GenerateHygieneScript -PassThru
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds 30 `
            -Reason ("hygiene-report") `
            -LastSyncAt (Get-LastKnownSyncAt)
        if ($waitResult.timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("hygiene-report-timeout") -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $null
        }

        if ($waitResult.exitCode -ne 0) {
            Write-State -Running $true -LastReason ("hygiene-report-exitcode-" + $waitResult.exitCode) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $null
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("hygiene-report-failed:" + $_) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $null
    }
}

function Invoke-MemoryArchival {
    # Read hygiene report to check archival_needed flag (Q1 fix: do NOT self-trigger, only act on report)
    $hygieneReportPath = Join-Path $GeneratedRoot "memory_hygiene_report.json"
    $archivalNeeded = $false
    if (Test-Path -LiteralPath $hygieneReportPath -PathType Leaf) {
        try {
            $report = Get-Content -Raw -LiteralPath $hygieneReportPath -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $report.tier_budget_status) {
                $archivalNeeded = [bool]$report.tier_budget_status.archival_needed
            }
        } catch {
        }
    }

    if (-not $archivalNeeded) {
        Write-WatchdogTrace -Step "archival.skip" -Data @{ reason = "archival_not_needed" }
        return $false
    }

    if (-not (Test-Path -LiteralPath $MemoryArchivalScript -PathType Leaf)) {
        Write-WatchdogTrace -Step "archival.skip" -Data @{ reason = "script_missing" }
        return $false
    }

    try {
        # Use Start-Process (non-blocking, idempotent lock protects concurrent runs)
        if (Test-SharedIsWindows) {
            Start-SharedWindowsHeadlessProcess -FilePath (Get-NodeExecutable) -ArgumentList @($MemoryArchivalScript, "--vault-root", $VaultRoot, "--trigger", "watchdog") -WorkingDirectory (Split-Path -Parent $MemoryArchivalScript) | Out-Null
        } else {
            Start-SharedBackgroundProcess -FilePath (Get-NodeExecutable) -ArgumentList @($MemoryArchivalScript, "--vault-root", $VaultRoot, "--trigger", "watchdog") -WorkingDirectory (Split-Path -Parent $MemoryArchivalScript) | Out-Null
        }
        Write-WatchdogTrace -Step "archival.launched" -Data @{ reason = "archival_needed=true" }
        return $true
    } catch {
        Write-State -Running $true -LastReason ("archival-failed:" + $_) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Invoke-MemoryDream {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [switch]$Force
    )

    if (-not (Test-Path -LiteralPath $MemoryDreamScript -PathType Leaf)) {
        return $false
    }

    try {
        $args = @()
        if ($Force) {
            $args += "-Force"
        }

        $proc = Start-SharedPowerShellFile -ScriptPath $MemoryDreamScript -ArgumentList $args -WorkingDirectory (Split-Path -Parent $MemoryDreamScript)
        $waitResult = Wait-ProcessWithHeartbeat `
            -Process $proc `
            -TimeoutSeconds 45 `
            -Reason ("memory-dream:" + $Reason) `
            -LastSyncAt (Get-LastKnownSyncAt)
        if ($waitResult.timedOut) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("memory-dream-timeout:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        if ($waitResult.exitCode -ne 0) {
            Write-State -Running $true -LastReason ("memory-dream-exitcode-" + $waitResult.exitCode + ":" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("memory-dream-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Test-ClaudeMemWorkerHealthy {
    try {
        $healthUri = "http://127.0.0.1:37778/api/health"
        $response = Invoke-WebRequest -Uri $healthUri -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($null -ne $response -and $response.StatusCode -eq 200) {
            return $true
        }
        return $false
    } catch {
        return $false
    }
}

function Invoke-ClaudeMemWorkerRestart {
    if (-not (Test-Path -LiteralPath $ClaudeMemWorkerScript -PathType Leaf)) {
        Write-WatchdogTrace -Step "claudemem.restart.skipped" -Data @{ reason = "worker-script-missing" }
        return "claudemem-restart-skipped:worker-script-missing"
    }

    # Check if bun is available
    $bunPath = Join-Path $UserHome "npm-global\bun"
    if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) {
        $bunPath = (Get-Command bun -ErrorAction SilentlyContinue).Source
    }
    if (-not $bunPath -or -not (Test-Path -LiteralPath $bunPath -PathType Leaf)) {
        Write-WatchdogTrace -Step "claudemem.restart.skipped" -Data @{ reason = "bun-not-found" }
        return "claudemem-restart-skipped:bun-not-found"
    }

    try {
        $cwd = Split-Path -Parent $ClaudeMemWorkerScript
        $proc = Start-SharedBackgroundProcess -FilePath $bunPath -ArgumentList @($ClaudeMemWorkerScript, "start") `
            -WorkingDirectory $cwd
        Start-Sleep -Seconds 5
        if (Test-ClaudeMemWorkerHealthy) {
            Write-WatchdogTrace -Step "claudemem.restart.success" -Data @{ pid = $proc.Id }
            return "claudemem-restarted:pid-$($proc.Id)"
        }
        Write-WatchdogTrace -Step "claudemem.restart.failed" -Data @{ pid = $proc.Id; reason = "health-check-still-failed" }
        return "claudemem-restart-failed:health-check-still-failed"
    } catch {
        Write-WatchdogTrace -Step "claudemem.restart.error" -Data @{ message = $_.Exception.Message }
        return "claudemem-restart-error:$($_.Exception.Message)"
    }
}

function Invoke-ClaudeMemHealthCheck {
    if ((Get-Date) -lt $script:lastClaudeMemHealthCheck.AddSeconds($ClaudeMemHealthIntervalSeconds)) {
        return $null
    }
    $script:lastClaudeMemHealthCheck = Get-Date

    if (Test-ClaudeMemWorkerHealthy) {
        return $null
    }

    Write-WatchdogTrace -Step "claudemem.health.dead" -Data @{}
    return Invoke-ClaudeMemWorkerRestart
}

function Invoke-BackgroundExtraction {
    if (-not (Test-Path -LiteralPath $BackgroundExtractionScript -PathType Leaf)) {
        return $false
    }

    if ($script:lastBgExtraction -gt [datetime]::MinValue -and
        ($script:lastBgExtraction).AddHours($BgExtractionIntervalHours) -gt (Get-Date)) {
        return $false
    }

    try {
        $result = Invoke-PowerShellFileWithTimeout `
            -ScriptPath $BackgroundExtractionScript `
            -TimeoutSeconds 90 `
            -HeartbeatReason "background-extraction"
        if ($result.timedOut) {
            Write-Warning "[watchdog] background-extraction timed out after 90s"
            return $false
        }
        if ($result.exitCode -ne 0) {
            $detail = if (-not [string]::IsNullOrWhiteSpace($result.stderr)) { $result.stderr } else { $result.stdout }
            Write-Warning ("[watchdog] background-extraction failed with exit code {0}: {1}" -f $result.exitCode, $detail)
            return $false
        }
        $script:lastBgExtraction = Get-Date
        return $true
    } catch {
        Write-Warning "[watchdog] background-extraction threw: $_"
        return $false
    }
}

function Invoke-StructuredRefreshPipeline {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [bool]$StructuredChanged = $false
    )

    $artifactsRefreshed = Invoke-RefreshGeneratedArtifacts -Reason $Reason
    if ($StructuredChanged -or $artifactsRefreshed) {
        [void](Invoke-EmbeddingsRefresh -Reason ($Reason + "-structured") -Force)
    } else {
        [void](Invoke-EmbeddingsRefresh -Reason ($Reason + "-index-check"))
    }
}

function Invoke-ArtifactCatchup {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if (-not (Test-StructuredArtifactsNeedRefresh)) {
        return $null
    }

    $structuredSignatureBefore = Get-StructuredDataSignature
    $lastSyncAt = Invoke-BusSync -Reason $Reason
    $structuredSignatureAfter = Get-StructuredDataSignature
    $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)

    if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
        Invoke-StructuredRefreshPipeline -Reason $Reason -StructuredChanged:$structuredChanged
    }

    # Background extraction: every $BgExtractionIntervalHours hours, scan for forgotten sessions
    [void](Invoke-BackgroundExtraction)

    # Generate memory hygiene report
    [void](Invoke-GenerateHygieneReport)

    # Trigger idempotent archival if hygiene report says archival_needed=true (Q1 fix: hygiene only reports)
    [void](Invoke-MemoryArchival)

    return $lastSyncAt
}

function Invoke-EmbeddingsRefresh {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [switch]$Force
    )

    if (-not (Test-Path -LiteralPath $EmbeddingsScript -PathType Leaf)) {
        return $false
    }

    $indexMissing = -not (Test-Path -LiteralPath $EmbeddingsIndexPath -PathType Leaf)
    $indexItem = if ($indexMissing) { $null } else { Get-Item -LiteralPath $EmbeddingsIndexPath }
    $structuredNeedsRefresh = $false
    if (Test-Path -LiteralPath $StructuredRoot -PathType Container) {
        $latestStructured = @(Get-ChildItem -LiteralPath $StructuredRoot -File -Filter *.jsonl -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 1)
        if ($latestStructured.Count -gt 0) {
            $structuredNeedsRefresh = $indexMissing -or ($latestStructured[0].LastWriteTimeUtc -gt $indexItem.LastWriteTimeUtc)
        }
    }

    if (-not $Force -and -not $indexMissing -and -not $structuredNeedsRefresh) {
        return $false
    }

    if (-not (Test-Path variable:script:LastEmbeddingsRunAt)) {
        $script:LastEmbeddingsRunAt = [datetime]::MinValue
    }
    $ageSeconds = ((Get-Date) - $script:LastEmbeddingsRunAt).TotalSeconds
    if ($script:LastEmbeddingsRunAt -gt [datetime]::MinValue -and $ageSeconds -lt $EmbeddingsCooldownSeconds) {
        return $false
    }
    if (Test-NodeScriptRunning -ScriptPath $EmbeddingsScript) {
        return $false
    }

    try {
        Start-NodeProcess -ScriptPath $EmbeddingsScript | Out-Null
        $script:LastEmbeddingsRunAt = Get-Date
        return $true
    } catch {
        Write-State -Running $true -LastReason ("embeddings-refresh-failed:" + $Reason) -ChangedSpecs @() -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        return $false
    }
}

function Get-ExpectedSharedMcpIds {
    $ids = @("context7", "fetch", "time", "sequential-thinking", "obsidian", "memory")
    $minimaxApiKey = $env:MINIMAX_API_KEY
    if ([string]::IsNullOrWhiteSpace($minimaxApiKey)) {
        $minimaxApiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")
    }
    if ([string]::IsNullOrWhiteSpace($minimaxApiKey)) {
        $minimaxApiKey = [Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "Machine")
    }
    if (-not [string]::IsNullOrWhiteSpace($minimaxApiKey)) {
        $ids += "MiniMax"
    }
    return $ids
}

function Get-ExpectedSharedMcpPorts {
    $ports = [ordered]@{
        context7 = 9331
        fetch = 9332
        time = 9333
        "sequential-thinking" = 9334
        obsidian = 9335
        MiniMax = 9336
        memory = 9338
    }

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($id in @(Get-ExpectedSharedMcpIds)) {
        if ($ports.Contains($id)) {
            $records.Add([pscustomobject]@{
                id = $id
                port = [int]$ports[$id]
            }) | Out-Null
        }
    }

    return @($records.ToArray())
}

function Test-SharedMcpBootstrapRunning {
    if (-not (Test-SharedIsWindows)) {
        return $false
    }

    $scriptPaths = @()
    foreach ($candidate in @($SharedMcpStartScript, (Join-Path $SharedMcpRoot "start-shared-mcp.ps1"))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $scriptPaths += (Get-Item -LiteralPath $candidate).FullName.ToLowerInvariant()
        }
    }

    if ($scriptPaths.Count -eq 0) {
        return $false
    }

    $matches = @(
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe' or Name='pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = [string]$_.CommandLine
                if ([string]::IsNullOrWhiteSpace($commandLine)) {
                    return $false
                }

                $lowered = $commandLine.ToLowerInvariant()
                if (-not $lowered.Contains("-file")) {
                    return $false
                }

                foreach ($path in @($scriptPaths)) {
                    if ($lowered.Contains($path)) {
                        return $true
                    }
                }

                return $false
            }
    )

    return $matches.Count -gt 0
}

function Ensure-SharedMcp {
    if (-not (Test-Path -LiteralPath $SharedMcpStartScript -PathType Leaf)) {
        return ""
    }

    $expected = @(Get-ExpectedSharedMcpPorts)
    $missing = New-Object System.Collections.Generic.List[string]

    foreach ($server in $expected) {
        $listenerPids = @(Get-SharedListeningProcessIds -Port ([int]$server.port) | Sort-Object -Unique)
        if ($listenerPids.Count -eq 0) {
            [void]$missing.Add([string]$server.id)
        }
    }

    if ($missing.Count -eq 0) {
        return ""
    }

    if (Test-SharedMcpBootstrapRunning) {
        return "shared-mcp-bootstrap-already-running:" + ([string]::Join(",", $missing))
    }

    try {
        if (Test-SharedIsWindows) {
            # On Windows, a direct hidden PowerShell host keeps the spawned shared MCP proxies alive
            # more reliably than the detached temp-launcher wrapper used for short-lived scripts.
            Start-SharedBackgroundProcess `
                -FilePath (Resolve-SharedPowerShellExecutable) `
                -ArgumentList (Get-SharedPowerShellFileArguments -ScriptPath $SharedMcpStartScript -ArgumentList @()) `
                -WorkingDirectory (Split-Path -Parent $SharedMcpStartScript) | Out-Null
        } else {
            Start-SharedPowerShellFile `
                -ScriptPath $SharedMcpStartScript `
                -WorkingDirectory (Split-Path -Parent $SharedMcpStartScript) | Out-Null
        }
    } catch {
        return "shared-mcp-bootstrap-failed:" + ([string]::Join(",", $missing))
    }
    return "shared-mcp-bootstrap-launched:" + ([string]::Join(",", $missing))
}

if (-not (Acquire-WatchdogLock)) {
    return
}

# Write version so supervisor can detect drift and restart
[System.IO.File]::WriteAllText($WatchdogVersionPath, $WatchdogVersion, [System.Text.UTF8Encoding]::new($false))

try {
    Write-WatchdogTrace -Step "watchdog.enter" -Data @{
        daemon = [bool]$Daemon
        once = [bool]$Once
        pollSeconds = $PollSeconds
        staleMinutes = $StaleMinutes
    }
    Write-State -Running $true -LastReason "watchdog-startup-scan" -ChangedSpecs @() -LastSyncAt (Get-LastKnownSyncAt) -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
    $stamps = @{}
    $nextStampRefresh = @{}
    foreach ($spec in $WatchSpecs) {
        $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
        $nextStampRefresh[$spec.Name] = (Get-Date).AddSeconds((Get-WatchSpecPollSeconds -Spec $spec))
    }

    $startupStructuredSignatureBefore = Get-StructuredDataSignature
    Write-WatchdogTrace -Step "startup.blackboard.begin"
    $blackboardReason = Ensure-ObsidianBlackboardDaemon
    Write-WatchdogTrace -Step "startup.blackboard.end" -Data @{ reason = $blackboardReason }
    Write-WatchdogTrace -Step "startup.openclaw.begin"
    $startupOpenClawSynced = Invoke-OpenClawStructuredSync -Reason "watchdog-startup"
    Write-WatchdogTrace -Step "startup.openclaw.end" -Data @{ synced = [bool]$startupOpenClawSynced }
    Write-WatchdogTrace -Step "startup.sharedmcp.begin"
    $sharedMcpReason = Ensure-SharedMcp
    Write-WatchdogTrace -Step "startup.sharedmcp.end" -Data @{ reason = $sharedMcpReason }
    Write-WatchdogTrace -Step "startup.claudemem.begin"
    $claudeMemReason = Invoke-ClaudeMemHealthCheck
    Write-WatchdogTrace -Step "startup.claudemem.end" -Data @{ reason = $claudeMemReason }
    Write-WatchdogTrace -Step "startup.bussync.begin"
    $lastSyncAt = Invoke-BusSync -Reason "watchdog-startup"
    Write-WatchdogTrace -Step "startup.bussync.end" -Data @{ lastSyncAt = if ($lastSyncAt -gt [datetime]::MinValue) { $lastSyncAt.ToString("o") } else { $null } }
    $startupStructuredSignatureAfter = Get-StructuredDataSignature
    $startupStructuredChanged = ($startupStructuredSignatureBefore -cne $startupStructuredSignatureAfter) -or $startupOpenClawSynced
    # Always record the baseline signature on startup — needed even when files haven't changed
    # so downstream gates (structuredSignature diff, dream consolidation) have a valid reference.
    $script:lastHeavySyncSignature = $startupStructuredSignatureAfter
    $script:lastHeavySyncAt = Get-Date
    if ($startupStructuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
        Invoke-StructuredRefreshPipeline -Reason "watchdog-startup" -StructuredChanged:$startupStructuredChanged
    } else {
        [void](Invoke-EmbeddingsRefresh -Reason "watchdog-startup-index-check")
    }
    if (-not [string]::IsNullOrWhiteSpace($blackboardReason)) {
        Write-State -Running $true -LastReason $blackboardReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature $startupStructuredSignatureAfter -HeavySyncAt $script:lastHeavySyncAt
    }
    if (-not [string]::IsNullOrWhiteSpace($sharedMcpReason)) {
        Write-State -Running $true -LastReason $sharedMcpReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature $startupStructuredSignatureAfter -HeavySyncAt $script:lastHeavySyncAt
    }
    if ($Once -and -not $Daemon) {
        Write-State -Running $true -LastReason "watchdog-once-complete" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature $startupStructuredSignatureAfter -HeavySyncAt $script:lastHeavySyncAt
        return
    }

    Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature $startupStructuredSignatureAfter -HeavySyncAt $script:lastHeavySyncAt
    while ($true) {
        Write-WatchdogTrace -Step "loop.begin"
        Start-Sleep -Seconds $PollSeconds
        Write-WatchdogTrace -Step "loop.after-sleep"
        Write-WatchdogTrace -Step "loop.blackboard.begin"
        $blackboardReason = Ensure-ObsidianBlackboardDaemon
        Write-WatchdogTrace -Step "loop.blackboard.end" -Data @{ reason = $blackboardReason }
        if (-not [string]::IsNullOrWhiteSpace($blackboardReason)) {
            Write-State -Running $true -LastReason $blackboardReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        }
        Write-WatchdogTrace -Step "loop.sharedmcp.begin"
        $sharedMcpReason = Ensure-SharedMcp
        Write-WatchdogTrace -Step "loop.sharedmcp.end" -Data @{ reason = $sharedMcpReason }
        if (-not [string]::IsNullOrWhiteSpace($sharedMcpReason)) {
            Write-State -Running $true -LastReason $sharedMcpReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        }
        Write-WatchdogTrace -Step "loop.claudemem.begin"
        $claudeMemReason = Invoke-ClaudeMemHealthCheck
        Write-WatchdogTrace -Step "loop.claudemem.end" -Data @{ reason = $claudeMemReason }
        if (-not [string]::IsNullOrWhiteSpace($claudeMemReason)) {
            Write-State -Running $true -LastReason $claudeMemReason -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
        }
        $changed = New-Object System.Collections.Generic.List[string]
        Write-WatchdogTrace -Step "loop.scan.begin"
        foreach ($spec in $WatchSpecs) {
            $scanNow = Get-Date
            if ($nextStampRefresh.ContainsKey($spec.Name) -and ([datetime]$nextStampRefresh[$spec.Name]) -gt $scanNow) {
                continue
            }

            $currentStamp = Get-WatchStamp -Spec $spec
            $nextStampRefresh[$spec.Name] = $scanNow.AddSeconds((Get-WatchSpecPollSeconds -Spec $spec))
            if ($stamps[$spec.Name] -cne $currentStamp) {
                $stamps[$spec.Name] = $currentStamp
                [void]$changed.Add($spec.Name)
            }
        }
        Write-WatchdogTrace -Step "loop.scan.end" -Data @{ changed = @($changed.ToArray()) }

        $needsStaleRefresh = $false
        if (Test-Path -LiteralPath $GlobalContextPath) {
            $age = (Get-Date) - (Get-Item -LiteralPath $GlobalContextPath).LastWriteTime
            if ($age.TotalMinutes -ge $StaleMinutes) {
                $needsStaleRefresh = $true
            }
        } else {
            $needsStaleRefresh = $true
        }

        if ($changed.Count -gt 0) {
            Write-WatchdogTrace -Step "loop.changed.begin" -Data @{ changed = @($changed.ToArray()) }
            $structuredSignatureBefore = Get-StructuredDataSignature
            $openClawChanged = @($changed | Where-Object { $OpenClawWatchSpecNames -contains $_ }).Count -gt 0
            if ($openClawChanged) {
                Write-WatchdogTrace -Step "loop.changed.openclaw.begin" -Data @{ changed = @($changed.ToArray()) }
                [void](Invoke-OpenClawStructuredSync -Reason ("watchdog-change:" + ([string]::Join(",", $changed))))
                Write-WatchdogTrace -Step "loop.changed.openclaw.end" -Data @{ changed = @($changed.ToArray()) }
            }
            $reason = "watchdog-change:" + ([string]::Join(",", $changed))
            Write-WatchdogTrace -Step "loop.changed.bussync.begin" -Data @{ reason = $reason }
            $lastSyncAt = Invoke-BusSync -Reason $reason
            Write-WatchdogTrace -Step "loop.changed.bussync.end" -Data @{ reason = $reason; lastSyncAt = if ($lastSyncAt -gt [datetime]::MinValue) { $lastSyncAt.ToString("o") } else { $null } }
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged) {
                $script:lastHeavySyncSignature = $structuredSignatureAfter
                $script:lastHeavySyncAt = Get-Date
            }
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Write-WatchdogTrace -Step "loop.changed.refresh.begin" -Data @{ reason = $reason; structuredChanged = [bool]$structuredChanged }
                Invoke-StructuredRefreshPipeline -Reason $reason -StructuredChanged:$structuredChanged
                Write-WatchdogTrace -Step "loop.changed.refresh.end" -Data @{ reason = $reason }
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason ($reason + "-index-check"))
            }
            Write-State -Running $true -LastReason $reason -ChangedSpecs $changed.ToArray() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        if (Test-StructuredArtifactsNeedRefresh) {
            $lastSyncAt = Invoke-ArtifactCatchup -Reason "watchdog-artifact-refresh"
            Write-State -Running $true -LastReason "watchdog-artifact-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        if ($needsStaleRefresh) {
            $structuredSignatureBefore = Get-StructuredDataSignature
            $lastSyncAt = Invoke-BusSync -Reason "watchdog-stale-refresh"
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged) {
                $script:lastHeavySyncSignature = $structuredSignatureAfter
                $script:lastHeavySyncAt = Get-Date
            }
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Invoke-StructuredRefreshPipeline -Reason "watchdog-stale-refresh" -StructuredChanged:$structuredChanged
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason "watchdog-stale-refresh-index-check")
            }
            Write-State -Running $true -LastReason "watchdog-stale-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt
            continue
        }

        Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt -StructuredSignature (Get-StructuredDataSignature) -HeavySyncAt $script:lastHeavySyncAt

        if (-not $Daemon) {
            break
        }
    }
} catch {
    Write-WatchdogTrace -Step "watchdog.catch" -Data @{
        message = $_.Exception.Message
        type = if ($null -ne $_.Exception) { $_.Exception.GetType().FullName } else { "" }
    }
    Write-WatchdogErrorLog -ErrorRecord $_ -Context "top-level"
    throw
} finally {
    Write-WatchdogTrace -Step "watchdog.finally"
    try {
        if (-not $KeepRunningState) {
            Write-State -Running $false -LastReason "watchdog-exit" -ChangedSpecs @()
        }
    } finally {
        Release-WatchdogLock
    }
}
