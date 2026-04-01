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

function Resolve-ObsidianVaultRoot {
    param([AllowEmptyString()][string]$FallbackPath = "")

    foreach ($overridePath in @($env:AI_MEMORY_OBSIDIAN_VAULT, $env:OBSIDIAN_VAULT_ROOT)) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    $obsidianConfigPath = Join-Path $env:APPDATA "obsidian\obsidian.json"
    if (Test-Path -LiteralPath $obsidianConfigPath) {
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

    foreach ($candidate in @($FallbackPath, (Join-Path $env:USERPROFILE "Documents\Obsidian Vault"))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return $FallbackPath
}

$UserHome = $env:USERPROFILE
$AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { $PSScriptRoot }
$BusScript = Join-Path $AiMemoryRoot "memory-bus.ps1"
$StatePath = Join-Path $AiMemoryRoot "watchdog-state.json"
$SharedMcpRoot = Join-Path $AiMemoryRoot "shared-mcp"
$SharedMcpStartScript = Join-Path $SharedMcpRoot "start-default-shared-mcp.ps1"
$SharedMcpStatusScript = Join-Path $SharedMcpRoot "status-shared-mcp.ps1"
$VaultRoot = Resolve-ObsidianVaultRoot -FallbackPath (Join-Path $UserHome "Documents\Obsidian Vault")
$GlobalContextPath = Join-Path $VaultRoot "00-System\ai-memory\generated\GLOBAL-CONTEXT.md"
$StructuredRoot = Join-Path $VaultRoot "00-System\ai-memory\structured"
$BlackboardDaemonScript = Join-Path $AiMemoryRoot "obsidian-blackboard-daemon.js"
$OpenClawSyncScript = Join-Path $AiMemoryRoot "sync-openclaw-to-obsidian.js"
$EmbeddingsScript = Join-Path $AiMemoryRoot "generate-embeddings.js"
$EmbeddingsIndexPath = Join-Path $VaultRoot "00-System\ai-memory\embeddings\index.jsonl"
$EmbeddingsCooldownSeconds = 180
$OpenClawWatchSpecNames = @("openclaw-sessions", "openclaw-memory", "openclaw-user", "openclaw-memory-md")
$OpenCodeDbPath = Join-Path $UserHome ".local\share\opencode\opencode.db"
$CopilotGlobalStorage = Join-Path $env:APPDATA "Code\User\globalStorage\github.copilot-chat"
$CopilotWorkspaceStorage = Join-Path $env:APPDATA "Code\User\workspaceStorage"
$WatchSpecs = @(
    [pscustomobject]@{ Name = "claude-user"; Tool = "claude-code"; Type = "file"; Path = (Join-Path $UserHome ".claude\memory\USER.md") },
    [pscustomobject]@{ Name = "claude-memory"; Tool = "claude-code"; Type = "file"; Path = (Join-Path $UserHome ".claude\memory\MEMORY.md") },
    [pscustomobject]@{ Name = "claude-today"; Tool = "claude-code"; Type = "file"; Path = (Join-Path $UserHome ".claude\memory\TODAY.md") },
    [pscustomobject]@{ Name = "claude-mem-db"; Tool = "claude-code"; Type = "file"; Path = (Join-Path $UserHome ".claude-mem\claude-mem.db") },
    [pscustomobject]@{ Name = "agents-skills"; Tool = "system"; Type = "dir"; Path = (Join-Path $UserHome ".agents\skills"); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "codex-skills"; Tool = "system"; Type = "dir"; Path = (Join-Path $UserHome ".codex\skills"); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "claude-skills"; Tool = "system"; Type = "dir"; Path = (Join-Path $UserHome ".claude\skills"); Filter = "SKILL.md"; Recurse = $true; Top = 250 },
    [pscustomobject]@{ Name = "codex-history"; Tool = "codex"; Type = "file"; Path = (Join-Path $UserHome ".codex\history.jsonl") },
    [pscustomobject]@{ Name = "codex-session-index"; Tool = "codex"; Type = "file"; Path = (Join-Path $UserHome ".codex\session_index.jsonl") },
    [pscustomobject]@{ Name = "codex-rollouts"; Tool = "codex"; Type = "dir"; Path = (Join-Path $UserHome ".codex\sessions"); Filter = "*.jsonl"; Recurse = $true; Top = 20 },
    [pscustomobject]@{ Name = "trae-user-rules"; Tool = "trae"; Type = "file"; Path = (Join-Path $UserHome ".trae\user_rules.md") },
    [pscustomobject]@{ Name = "trae-history"; Tool = "trae"; Type = "dir"; Path = (Join-Path $env:APPDATA "Trae\User\History"); Filter = "entries.json"; Recurse = $true; Top = 10 },
    [pscustomobject]@{ Name = "trae-history-cn"; Tool = "trae"; Type = "dir"; Path = (Join-Path $env:APPDATA "Trae CN\User\History"); Filter = "entries.json"; Recurse = $true; Top = 10 },
    [pscustomobject]@{ Name = "trae-mcp-user"; Tool = "trae"; Type = "file"; Path = (Join-Path $env:APPDATA "Trae\User\mcp.json") },
    [pscustomobject]@{ Name = "trae-mcp-cn"; Tool = "trae"; Type = "file"; Path = (Join-Path $env:APPDATA "Trae CN\User\mcp.json") },
    [pscustomobject]@{ Name = "openclaw-sessions"; Tool = "openclaw"; Type = "dir"; Path = (Join-Path $UserHome ".openclaw\agents\main\sessions"); Filter = "*.jsonl*"; Recurse = $false; Top = 10 },
    [pscustomobject]@{ Name = "openclaw-memory"; Tool = "openclaw"; Type = "dir"; Path = (Join-Path $UserHome ".openclaw\workspace\memory"); Filter = "*.md"; Recurse = $false; Top = 6 },
    [pscustomobject]@{ Name = "openclaw-user"; Tool = "openclaw"; Type = "file"; Path = (Join-Path $UserHome ".openclaw\workspace\USER.md") },
    [pscustomobject]@{ Name = "openclaw-memory-md"; Tool = "openclaw"; Type = "file"; Path = (Join-Path $UserHome ".openclaw\workspace\MEMORY.md") },
    [pscustomobject]@{ Name = "opencode-db"; Tool = "opencode"; Type = "file"; Path = $OpenCodeDbPath },
    [pscustomobject]@{ Name = "copilot-global-files"; Tool = "copilot"; Type = "dir"; Path = $CopilotGlobalStorage; Filter = "*"; Recurse = $true; Top = 8 },
    [pscustomobject]@{ Name = "copilot-workspaces"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "workspace.json"; Recurse = $true; Top = 20 },
    [pscustomobject]@{ Name = "copilot-chat-sessions"; Tool = "copilot"; Type = "dir"; Path = $CopilotWorkspaceStorage; Filter = "*.jsonl"; Recurse = $true; Top = 12 },
    [pscustomobject]@{ Name = "copilot-cli-workspaces"; Tool = "copilot"; Type = "dir"; Path = (Join-Path $UserHome ".copilot\session-state"); Filter = "workspace.yaml"; Recurse = $true; Top = 12 },
    [pscustomobject]@{ Name = "copilot-cli-events"; Tool = "copilot"; Type = "dir"; Path = (Join-Path $UserHome ".copilot\session-state"); Filter = "events.jsonl"; Recurse = $true; Top = 12 }
)

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
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
    [System.IO.File]::WriteAllText($StatePath, ($payload | ConvertTo-Json -Depth 6), $Utf8NoBom)
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

function Invoke-BusSync {
    param([Parameter(Mandatory = $true)][string]$Reason)

    try {
        $syncOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BusScript -Action SyncAll -Tool system -Project "watchdog" -Quiet 2>&1
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
$syncScript = Join-Path $AiMemoryRoot "sync-claudemem-to-obsidian.ps1"
        if (Test-Path $syncScript) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript 2>$null | Out-Null
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
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $cmd = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) {
            return $false
        }
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

    $full = (Get-Item -LiteralPath $ScriptPath).FullName.ToLowerInvariant()
    $name = [System.IO.Path]::GetFileName($full)
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $cmd = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) {
            return $false
        }
        $lc = $cmd.ToLowerInvariant()
        return $lc.Contains($full) -or $lc.Contains($name)
    })
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

    $nodePath = "node.exe"
    try {
        $nodeCmd = Get-Command node.exe -ErrorAction Stop
        if ($nodeCmd.Source) {
            $nodePath = $nodeCmd.Source
        }
    } catch {
    }

    Start-Process -FilePath $nodePath -ArgumentList @($BlackboardDaemonScript) -WorkingDirectory (Split-Path -Parent $BlackboardDaemonScript) -WindowStyle Hidden
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
        $nodePath = "node.exe"
        try {
            $nodeCmd = Get-Command node.exe -ErrorAction Stop
            if ($nodeCmd.Source) {
                $nodePath = $nodeCmd.Source
            }
        } catch {
        }
        $proc = Start-Process -FilePath $nodePath -ArgumentList @($OpenClawSyncScript) -WorkingDirectory (Split-Path -Parent $OpenClawSyncScript) -PassThru -WindowStyle Hidden
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
        $nodePath = "node.exe"
        try {
            $nodeCmd = Get-Command node.exe -ErrorAction Stop
            if ($nodeCmd.Source) {
                $nodePath = $nodeCmd.Source
            }
        } catch {
        }
        Start-Process -FilePath $nodePath -ArgumentList @($EmbeddingsScript) -WorkingDirectory (Split-Path -Parent $EmbeddingsScript) -WindowStyle Hidden
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
            $status = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SharedMcpStatusScript | ConvertFrom-Json
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

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SharedMcpStartScript | Out-Null
    return "shared-mcp-restarted:" + ([string]::Join(",", $missing))
}

# PID-file based lock (skip stuck named mutex)
$statePath = Join-Path $AiMemoryRoot "watchdog-state.json"
if (Test-Path $statePath) {
    try {
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        $existingPid = [int]$state.pid
        if ($existingPid -gt 0) {
            $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($proc) {
                "[{0}] Another watchdog already running PID:{1} - exiting" -f (Get-Date -Format "HH:mm:ss"), $existingPid | Out-Null
                exit 0
            }
        }
    } catch {}
}

try {
    $stamps = @{}
    foreach ($spec in $WatchSpecs) {
        $stamps[$spec.Name] = Get-WatchStamp -Spec $spec
    }

    $blackboardReason = Ensure-ObsidianBlackboardDaemon
    $startupOpenClawSynced = Invoke-OpenClawStructuredSync -Reason "watchdog-startup"
    if ($startupOpenClawSynced) {
        [void](Invoke-EmbeddingsRefresh -Reason "openclaw-structured-sync-startup" -Force)
    } else {
        [void](Invoke-EmbeddingsRefresh -Reason "startup-index-check")
    }
    $sharedMcpReason = Ensure-SharedMcp
    $lastSyncAt = Invoke-BusSync -Reason "watchdog-startup"
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
            $openClawChanged = @($changed | Where-Object { $OpenClawWatchSpecNames -contains $_ }).Count -gt 0
            if ($openClawChanged) {
                $openClawSynced = Invoke-OpenClawStructuredSync -Reason ("watchdog-change:" + ([string]::Join(",", $changed)))
                if ($openClawSynced) {
                    [void](Invoke-EmbeddingsRefresh -Reason "openclaw-structured-sync-change" -Force)
                }
            } else {
                [void](Invoke-EmbeddingsRefresh -Reason "watchdog-change-index-check")
            }
            $reason = "watchdog-change:" + ([string]::Join(",", $changed))
            $lastSyncAt = Invoke-BusSync -Reason $reason
            Write-State -Running $true -LastReason $reason -ChangedSpecs $changed.ToArray() -LastSyncAt $lastSyncAt
            continue
        }

        if ($needsStaleRefresh) {
            [void](Invoke-EmbeddingsRefresh -Reason "watchdog-stale-refresh-index-check")
            $lastSyncAt = Invoke-BusSync -Reason "watchdog-stale-refresh"
            Write-State -Running $true -LastReason "watchdog-stale-refresh" -ChangedSpecs @() -LastSyncAt $lastSyncAt
            continue
        }

        Write-State -Running $true -LastReason "watchdog-idle" -ChangedSpecs @() -LastSyncAt $lastSyncAt

        if (-not $Daemon) {
            break
        }
    }
} finally {
    Write-State -Running $false -LastReason "watchdog-exit" -ChangedSpecs @()
    # mutex guard removed - no mutex to release
}
