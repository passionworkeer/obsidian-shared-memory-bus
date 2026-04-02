param(
    [switch]$Daemon,
    [switch]$Once,
    [int]$PollSeconds = 15,
    [int]$StaleMinutes = 5
)

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
$OpenClawSyncScript = Resolve-BusPath -Candidates @("sync-openclaw-to-obsidian.js", "ops/sync-openclaw-to-obsidian.js")
$BuildHandoffPackScript = Resolve-BusPath -Candidates @("build-handoff-pack.js", "ops/build-handoff-pack.js")
$BuildMemoryLayersScript = Resolve-BusPath -Candidates @("build-memory-layers.js", "ops/build-memory-layers.js")
$MemoryDreamScript = Resolve-BusPath -Candidates @("run-memory-dream.ps1", "ops/run-memory-dream.ps1")
$EmbeddingsScript = Resolve-BusPath -Candidates @("generate-embeddings.js", "bus/generate-embeddings.js")
$EmbeddingsIndexPath = Join-SharedPath @($VaultRoot, "00-System", "ai-memory", "embeddings", "index.jsonl")
$EmbeddingsCooldownSeconds = 180
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
    [pscustomobject]@{ Name = "agents-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".agents", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "codex-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".codex", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "claude-skills"; Tool = "system"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".claude", "skills")); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "codex-history"; Tool = "codex"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".codex", "history.jsonl")) },
    [pscustomobject]@{ Name = "codex-session-index"; Tool = "codex"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".codex", "session_index.jsonl")) },
    [pscustomobject]@{ Name = "codex-rollouts"; Tool = "codex"; Type = "dir"; Path = (Join-SharedPath @($UserHome, ".codex", "sessions")); Filter = "*.jsonl"; Recurse = $true; Top = 20 },
    [pscustomobject]@{ Name = "trae-user-rules"; Tool = "trae"; Type = "file"; Path = (Join-SharedPath @($UserHome, ".trae", "user_rules.md")) },
    [pscustomobject]@{ Name = "trae-history"; Tool = "trae"; Type = "dir"; Path = (Join-SharedPath @($TraeUserRoot, "History")); Filter = "entries.json"; Recurse = $true; Top = 10 },
    [pscustomobject]@{ Name = "trae-history-cn"; Tool = "trae"; Type = "dir"; Path = (Join-SharedPath @($TraeCnUserRoot, "History")); Filter = "entries.json"; Recurse = $true; Top = 10 },
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
    [pscustomobject]@{ Name = "copilot-global-files"; Tool = "copilot"; Type = "dir"; Path = $CopilotGlobalStorage; Filter = "*"; Recurse = $true; Top = 8 },
    [pscustomobject]@{ Name = "copilot-workspaces"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "workspace.json"; Recurse = $true; Top = 20 },
    [pscustomobject]@{ Name = "copilot-chat-sessions"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "*.jsonl"; Recurse = $true; Top = 12 },
    [pscustomobject]@{ Name = "copilot-cli-workspaces"; Tool = "copilot"; Type = "dir"; Path = $CopilotCliSessionRoot; Filter = "workspace.yaml"; Recurse = $true; Top = 12 },
    [pscustomobject]@{ Name = "copilot-cli-events"; Tool = "copilot"; Type = "dir"; Path = $CopilotCliSessionRoot; Filter = "events.jsonl"; Recurse = $true; Top = 12 }
)

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Get-NodeExecutable {
    return (Resolve-SharedNodeExecutable)
}

function Start-NodeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [switch]$PassThru
    )

    $parameters = @{
        FilePath = (Get-NodeExecutable)
        ArgumentList = @($ScriptPath)
        WorkingDirectory = (Split-Path -Parent $ScriptPath)
    }

    if ($PassThru) {
        $parameters.PassThru = $true
    }
    if (Test-SharedIsWindows) {
        $parameters.WindowStyle = "Hidden"
    }

    return Start-Process @parameters
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

function Write-State {
    param(
        [Parameter(Mandatory = $true)][bool]$Running,
        [string]$LastReason = "",
        [string[]]$ChangedSpecs = @(),
        [datetime]$LastSyncAt = [datetime]::MinValue
    )

    Ensure-Directory -Path (Split-Path -Parent $StatePath)
    $payload = [ordered]@{
        running = $Running
        pid = $PID
        daemon = [bool]$Daemon
        pollSeconds = $PollSeconds
        staleMinutes = $StaleMinutes
        updatedAt = (Get-Date).ToString("o")
        lastReason = $LastReason
        lastSyncAt = if ($LastSyncAt -gt [datetime]::MinValue) { $LastSyncAt.ToString("o") } else { $null }
        changedSpecs = $ChangedSpecs
        busScript = $BusScript
        globalContext = $GlobalContextPath
    }
    $tempPath = "$StatePath.tmp"
    [System.IO.File]::WriteAllText($tempPath, ($payload | ConvertTo-Json -Depth 6), $Utf8NoBom)
    Move-Item -LiteralPath $tempPath -Destination $StatePath -Force
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

    $files = @(
        Get-ChildItem -LiteralPath $Spec.Path -File -Filter $Spec.Filter -Recurse:([bool]$Spec.Recurse) |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First ([int]$Spec.Top)
    )
    if ($files.Count -eq 0) {
        return "__empty__"
    }

    return ($files | ForEach-Object {
        "{0}:{1}:{2}" -f $_.FullName, $_.LastWriteTimeUtc.Ticks, $_.Length
    }) -join "|"
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

    try {
        $syncOutput = Invoke-SharedPowerShellFile -ScriptPath $BusScript -ArgumentList @(
            "-Action", "SyncAll",
            "-Tool", "system",
            "-Project", "watchdog",
            "-Quiet"
        ) 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "[watchdog] BusSync failed with exit code $LASTEXITCODE"
        }
    } catch {
        Write-Warning "[watchdog] BusSync threw: $_"
    }

    # Sync claude-mem observations → Obsidian structured/ (every 5th sync)
    if (-not (Test-Path variable:script:ClaudeMemCounter)) {
        $script:ClaudeMemCounter = 0
    }
    $script:ClaudeMemCounter++
    if ($script:ClaudeMemCounter % 5 -eq 0) {
        $syncScript = Resolve-BusPath -Candidates @("sync-claudemem-to-obsidian.ps1", "ops/sync-claudemem-to-obsidian.ps1")
        if (Test-Path $syncScript) {
            Invoke-SharedPowerShellFile -ScriptPath $syncScript 2>$null | Out-Null
        }
    }

    $lastSyncAt = Get-Date
    Write-State -Running $true -LastReason $Reason -ChangedSpecs @() -LastSyncAt $lastSyncAt
    return $lastSyncAt
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
        if (-not (Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue)) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("openclaw-sync-timeout:" + $Reason) -ChangedSpecs @()
            return $false
        }
        if ($proc.ExitCode -ne 0) {
            Write-State -Running $true -LastReason ("openclaw-sync-exitcode-" + $proc.ExitCode + ":" + $Reason) -ChangedSpecs @()
            return $false
        }
        return $true
    } catch {
        Write-State -Running $true -LastReason ("openclaw-sync-failed:" + $Reason) -ChangedSpecs @()
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
        if (-not (Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue)) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("memory-layers-timeout:" + $Reason) -ChangedSpecs @()
            return $false
        }

        if ($proc.ExitCode -ne 0) {
            Write-State -Running $true -LastReason ("memory-layers-exitcode-" + $proc.ExitCode + ":" + $Reason) -ChangedSpecs @()
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("memory-layers-failed:" + $Reason) -ChangedSpecs @()
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
        if (-not (Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue)) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("handoff-pack-timeout:" + $Reason) -ChangedSpecs @()
            return $false
        }

        if ($proc.ExitCode -ne 0) {
            Write-State -Running $true -LastReason ("handoff-pack-exitcode-" + $proc.ExitCode + ":" + $Reason) -ChangedSpecs @()
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("handoff-pack-failed:" + $Reason) -ChangedSpecs @()
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
        if (-not (Wait-Process -Id $proc.Id -Timeout 45 -ErrorAction SilentlyContinue)) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            } catch {
            }
            Write-State -Running $true -LastReason ("memory-dream-timeout:" + $Reason) -ChangedSpecs @()
            return $false
        }

        if ($proc.ExitCode -ne 0) {
            Write-State -Running $true -LastReason ("memory-dream-exitcode-" + $proc.ExitCode + ":" + $Reason) -ChangedSpecs @()
            return $false
        }

        return $true
    } catch {
        Write-State -Running $true -LastReason ("memory-dream-failed:" + $Reason) -ChangedSpecs @()
        return $false
    }
}

function Invoke-StructuredRefreshPipeline {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [bool]$StructuredChanged = $false
    )

    $layersBuilt = Invoke-BuildMemoryLayers -Reason $Reason
    [void](Invoke-BuildHandoffPack -Reason $Reason)
    if ($StructuredChanged -or $layersBuilt) {
        [void](Invoke-EmbeddingsRefresh -Reason ($Reason + "-structured") -Force)
    } else {
        [void](Invoke-EmbeddingsRefresh -Reason ($Reason + "-index-check"))
    }
    [void](Invoke-MemoryDream -Reason $Reason)
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
        Write-State -Running $true -LastReason ("embeddings-refresh-failed:" + $Reason) -ChangedSpecs @()
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

function Ensure-SharedMcp {
    if (-not (Test-Path -LiteralPath $SharedMcpStartScript -PathType Leaf)) {
        return ""
    }

    $expected = @(Get-ExpectedSharedMcpIds)
    $missing = New-Object System.Collections.Generic.List[string]

    if (Test-Path -LiteralPath $SharedMcpStatusScript -PathType Leaf) {
        try {
            $status = Invoke-SharedPowerShellFile -ScriptPath $SharedMcpStatusScript | ConvertFrom-Json
            foreach ($id in $expected) {
                $record = @($status | Where-Object { $_.id -eq $id } | Select-Object -First 1)
                if ($record.Count -eq 0 -or -not [bool]$record[0].running) {
                    [void]$missing.Add($id)
                }
            }
        } catch {
            $missing.AddRange($expected)
        }
    } else {
        $missing.AddRange($expected)
    }

    if ($missing.Count -eq 0) {
        return ""
    }

    Invoke-SharedPowerShellFile -ScriptPath $SharedMcpStartScript | Out-Null
    return "shared-mcp-restarted:" + ([string]::Join(",", $missing))
}

if (-not (Acquire-WatchdogLock)) {
    exit 0
}

try {
    $stamps = @{}
    foreach ($spec in $WatchSpecs) {
        $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
    }

    $startupStructuredSignatureBefore = Get-StructuredDataSignature
    $blackboardReason = Ensure-ObsidianBlackboardDaemon
    $startupOpenClawSynced = Invoke-OpenClawStructuredSync -Reason "watchdog-startup"
    $sharedMcpReason = Ensure-SharedMcp
    $lastSyncAt = Invoke-BusSync -Reason "watchdog-startup"
    $startupStructuredSignatureAfter = Get-StructuredDataSignature
    $startupStructuredChanged = ($startupStructuredSignatureBefore -cne $startupStructuredSignatureAfter) -or $startupOpenClawSynced
    if ($startupStructuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
        Invoke-StructuredRefreshPipeline -Reason "watchdog-startup" -StructuredChanged:$startupStructuredChanged
    } else {
        [void](Invoke-EmbeddingsRefresh -Reason "watchdog-startup-index-check")
    }
    if (-not [string]::IsNullOrWhiteSpace($blackboardReason)) {
        Write-State -Running $true -LastReason $blackboardReason -ChangedSpecs @() -LastSyncAt $lastSyncAt
    }
    if (-not [string]::IsNullOrWhiteSpace($sharedMcpReason)) {
        Write-State -Running $true -LastReason $sharedMcpReason -ChangedSpecs @() -LastSyncAt $lastSyncAt
    }
    if ($Once -and -not $Daemon) {
        exit 0
    }

    Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt
    while ($true) {
        Start-Sleep -Seconds $PollSeconds
        $blackboardReason = Ensure-ObsidianBlackboardDaemon
        if (-not [string]::IsNullOrWhiteSpace($blackboardReason)) {
            Write-State -Running $true -LastReason $blackboardReason -ChangedSpecs @() -LastSyncAt $lastSyncAt
        }
        $sharedMcpReason = Ensure-SharedMcp
        if (-not [string]::IsNullOrWhiteSpace($sharedMcpReason)) {
            Write-State -Running $true -LastReason $sharedMcpReason -ChangedSpecs @() -LastSyncAt $lastSyncAt
        }
        $changed = New-Object System.Collections.Generic.List[string]
        foreach ($spec in $WatchSpecs) {
            $currentStamp = Get-WatchStamp -Spec $spec
            if ($stamps[$spec.Name] -cne $currentStamp) {
                $stamps[$spec.Name] = $currentStamp
                [void]$changed.Add($spec.Name)
            }
        }

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
            $structuredSignatureBefore = Get-StructuredDataSignature
            $openClawChanged = @($changed | Where-Object { $OpenClawWatchSpecNames -contains $_ }).Count -gt 0
            if ($openClawChanged) {
                [void](Invoke-OpenClawStructuredSync -Reason ("watchdog-change:" + ([string]::Join(",", $changed))))
            }
            $reason = "watchdog-change:" + ([string]::Join(",", $changed))
            $lastSyncAt = Invoke-BusSync -Reason $reason
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Invoke-StructuredRefreshPipeline -Reason $reason -StructuredChanged:$structuredChanged
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason ($reason + "-index-check"))
            }
            Write-State -Running $true -LastReason $reason -ChangedSpecs $changed.ToArray() -LastSyncAt $lastSyncAt
            continue
        }

        if ($needsStaleRefresh) {
            $structuredSignatureBefore = Get-StructuredDataSignature
            $lastSyncAt = Invoke-BusSync -Reason "watchdog-stale-refresh"
            $structuredSignatureAfter = Get-StructuredDataSignature
            $structuredChanged = ($structuredSignatureBefore -cne $structuredSignatureAfter)
            if ($structuredChanged -or (Test-StructuredArtifactsNeedRefresh)) {
                Invoke-StructuredRefreshPipeline -Reason "watchdog-stale-refresh" -StructuredChanged:$structuredChanged
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason "watchdog-stale-refresh-index-check")
            }
            Write-State -Running $true -LastReason "watchdog-stale-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt
            continue
        }

        Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt

        if (-not $Daemon) {
            break
        }
    }
} finally {
    try {
        Write-State -Running $false -LastReason "watchdog-exit" -ChangedSpecs @()
    } finally {
        Release-WatchdogLock
    }
}
