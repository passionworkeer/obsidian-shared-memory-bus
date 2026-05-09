# bus/memory-bus-sync.ps1
# Source sync helpers. Dot-sourced by memory-bus.ps1.

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# Load utility and importer modules first so all functions are available.
. (Join-Path $PSScriptRoot "memory-bus-sync-time.ps1")
. (Join-Path $PSScriptRoot "memory-bus-sync-importers.ps1")

function Sync-ClaudeSnapshot {
    param([string]$ProjectDirectory)

    $userMd = Read-Text -Path (Join-SharedPath @($Script:ClaudeRoot, "memory", "USER.md"))
    $memoryMd = Read-Text -Path (Join-SharedPath @($Script:ClaudeRoot, "memory", "MEMORY.md"))
    $todayMd = Read-Text -Path (Join-SharedPath @($Script:ClaudeRoot, "memory", "TODAY.md"))
    $claudeMem = Get-ClaudeMemSnapshot
    $projectMemory = ""

    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $projectLocal = Join-SharedPath @($ProjectDirectory, ".claude", "memory", "MEMORY.md")
        if (Test-Path -LiteralPath $projectLocal) {
            $projectMemory = Read-Text -Path $projectLocal
        }
    }

    $content = @"
# Claude Code Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## USER.md
$(Clip-Lines -Text $userMd -MaxLines 60)

## MEMORY.md
$(Clip-Lines -Text $memoryMd -MaxLines 80)

## TODAY.md
$(Clip-Lines -Text $todayMd -MaxLines 60)

## Claude-Mem Health
$($claudeMem.health)

## Claude-Mem Stats
$($claudeMem.stats)

## Recent Claude-Mem Observations
$(Clip-Lines -Text $claudeMem.observations -MaxLines 12)

## Project Memory
$(Clip-Lines -Text $projectMemory -MaxLines 60)
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "claude-code.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Sync-OpenClawSnapshot {
    $workspace = Join-Path $Script:OpenClawRoot "workspace"
    $userMd = Read-Text -Path (Join-Path $workspace "USER.md")
    $memoryMd = Read-Text -Path (Join-Path $workspace "MEMORY.md")
    $dailyDir = Join-Path $workspace "memory"
    $sessionDir = Join-SharedPath @($Script:OpenClawRoot, "agents", "main", "sessions")
    $recentTopics = Get-OpenClawRecentTopicsSnapshot -SessionDir $sessionDir

    $dailyFiles = @()
    if (Test-Path -LiteralPath $dailyDir) {
        $dailyFiles = Get-ChildItem -LiteralPath $dailyDir -Filter "2026-*.md" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 2
    }

    $recentDaily = @()
    foreach ($file in $dailyFiles) {
        $recentDaily += "### $($file.Name)`n$(Clip-Lines -Text (Read-Text -Path $file.FullName) -MaxLines 40)"
    }

    $content = @"
# OpenClaw Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## USER.md
$(Clip-Lines -Text $userMd -MaxLines 60)

## MEMORY.md
$(Clip-Lines -Text $memoryMd -MaxLines 80)

## Recent Session Files
$(Get-RecentFilesSummary -Path $sessionDir -Filter "*.jsonl*" -MaxFiles 6)

## Recent Session Topics
$(Clip-Lines -Text $recentTopics -MaxLines 8)

## Recent Daily Logs
$(([string]::Join("`n`n", $recentDaily)).Trim())
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "openclaw.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Sync-CodexSnapshot {
    $sessionIndex = Join-Path $Script:CodexRoot "session_index.jsonl"
    $memoriesDir = Join-Path $Script:CodexRoot "memories"
    $sessionsDir = Join-Path $Script:CodexRoot "sessions"
    $historyPath = Join-Path $Script:CodexRoot "history.jsonl"
    $recentThreads = Get-CodexRecentThreadsSnapshot -SessionIndexPath $sessionIndex
    $recentPrompts = Get-CodexRecentPromptsSnapshot -HistoryPath $historyPath
    $recentTopics = Get-CodexRecentTopicsSnapshot -SessionsDir $sessionsDir
    $sessionInfo = if (Test-Path -LiteralPath $sessionIndex) {
        "session_index.jsonl updated: $((Get-Item -LiteralPath $sessionIndex).LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"))"
    } else {
        "session_index.jsonl not found"
    }
    $historyInfo = if (Test-Path -LiteralPath $historyPath) {
        "history.jsonl updated: $((Get-Item -LiteralPath $historyPath).LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"))"
    } else {
        "history.jsonl not found"
    }

    $memoryInfo = if (Test-Path -LiteralPath $memoriesDir) {
        $files = @(Get-ChildItem -LiteralPath $memoriesDir -File | Select-Object -First 5)
        if ($files.Count -gt 0) {
            ($files | ForEach-Object { "- $($_.Name)" }) -join "`n"
        } else {
            "No native memory files detected in ~/.codex/memories"
        }
    } else {
        "~/.codex/memories does not exist"
    }

    $content = @"
# Codex Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## Native State
- $sessionInfo
- $historyInfo

## Native Memory Files
$memoryInfo

## Recent Threads
$(Clip-Lines -Text $recentThreads -MaxLines 8)

## Recent Prompts
$(Clip-Lines -Text $recentPrompts -MaxLines 8)

## Recent Session Topics
$(Clip-Lines -Text $recentTopics -MaxLines 8)

## Recent Rollouts
$(Get-RecentFilesSummary -Path $sessionsDir -Filter "*.jsonl" -MaxFiles 12 -Recurse)

## Strategy
- Codex global read/write is driven by `$Script:CodexAgentsPath`
- Shared long-term storage is Obsidian, not ~/.codex/memories
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "codex.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Sync-OpenCodeSnapshot {
    param([string]$ProjectDirectory)

    $cliInfo = Get-OpenCodeCliInfo
    $cliPath = [string]$cliInfo.path
    $cliVersion = if (-not [string]::IsNullOrWhiteSpace([string]$cliInfo.version)) {
        [string]$cliInfo.version
    } else {
        "(unavailable)"
    }

    $dbInfo = if (Test-Path -LiteralPath $Script:OpenCodeDbPath) {
        $dbItem = Get-Item -LiteralPath $Script:OpenCodeDbPath
        @"
- CLI path: $(if ($cliPath) { $cliPath } else { "(not found)" })
- Version: $cliVersion
- Database path: $($dbItem.FullName)
- Database size: $($dbItem.Length) bytes
- Last updated: $($dbItem.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"))
"@.Trim()
    } else {
        @"
- CLI path: $(if ($cliPath) { $cliPath } else { "(not found)" })
- Version: $cliVersion
- Database: not found at $Script:OpenCodeDbPath
"@.Trim()
    }

    $recentSessions = Get-OpenCodeRecentSessionsSnapshot
    $recentTopics = Get-OpenCodeRecentTopicsSnapshot
    $statsSnapshot = Get-OpenCodeStatsSnapshot
    $projectConfigText = ""
    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $projectConfigText = Read-Text -Path (Join-Path $ProjectDirectory "opencode.json")
    }

    if ([string]::IsNullOrWhiteSpace($projectConfigText)) {
        $projectConfigText = "opencode.json not found in current project."
    }

    $content = @"
# OpenCode Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## CLI and Database
$dbInfo

## Recent Sessions
$(Clip-Lines -Text $recentSessions -MaxLines 10)

## Recent Session Topics
$(Clip-Lines -Text $recentTopics -MaxLines 10)

## 30-Day Stats
$(HeadTail-Lines -Text $statsSnapshot -HeadLines 50 -TailLinesCount 20)

## Project opencode.json
$(Clip-Lines -Text $projectConfigText -MaxLines 80)
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "opencode.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Sync-CopilotSnapshot {
    param([string]$ProjectDirectory)

    $summarySnapshot = Get-CopilotSessionSummaries -ProjectDirectory $ProjectDirectory
    $workspace = $summarySnapshot.workspace
    $workspaceInfo = if ($workspace) {
        @"
- Workspace path: $(if ($workspace.workspacePath) { $workspace.workspacePath } else { "(unknown)" })
- Storage path: $($workspace.storagePath)
- Chat sessions path: $($workspace.chatSessionsPath)
- Last activity: $(Get-LocalTimestampString -Value $workspace.lastActivity)
"@.Trim()
    } else {
        "No matching GitHub Copilot workspace storage detected."
    }

    $cliStateInfo = @"
- Session state root: $Script:CopilotCliSessionRoot
- Matching CLI sessions: $($summarySnapshot.cliSessionCount)
"@.Trim()
    $recentSessions = Get-CopilotRecentSessionsSnapshot -ProjectDirectory $ProjectDirectory
    $recentTopics = Get-CopilotRecentTopicsSnapshot -ProjectDirectory $ProjectDirectory
    $globalStorage = Get-CopilotGlobalStorageSnapshot
    $projectAgentsText = ""
    $projectCopilotInstructions = ""

    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $projectAgentsText = Read-Text -Path (Join-Path $ProjectDirectory "AGENTS.md")
        $projectCopilotInstructions = Read-Text -Path (Join-SharedPath @($ProjectDirectory, ".github", "copilot-instructions.md"))
    }

    if ([string]::IsNullOrWhiteSpace($projectAgentsText)) {
        $projectAgentsText = "Project AGENTS.md not found."
    }

    if ([string]::IsNullOrWhiteSpace($projectCopilotInstructions)) {
        $projectCopilotInstructions = "Project .github/copilot-instructions.md not found."
    }

    $content = @"
# GitHub Copilot Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## Workspace Detection
$workspaceInfo

## CLI Session State
$cliStateInfo

## Recent Sessions
$(Clip-Lines -Text $recentSessions -MaxLines 10)

## Recent Session Topics
$(Clip-Lines -Text $recentTopics -MaxLines 10)

## Global Storage Files
$(Clip-Lines -Text $globalStorage -MaxLines 10)

## Project AGENTS.md
$(Clip-Lines -Text $projectAgentsText -MaxLines 60)

## Project Copilot Instructions
$(Clip-Lines -Text $projectCopilotInstructions -MaxLines 60)
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "copilot.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Sync-TraeSnapshot {
    param([string]$ProjectDirectory)

    $userRules = Read-Text -Path (Join-Path $Script:TraeRulesRoot "user_rules.md")
    $projectRules = ""
    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $projectRules = Read-Text -Path (Join-Path $ProjectDirectory $Script:TraeProjectRulesRelativePath)
    }
    $mcpUser = Read-Text -Path (Join-SharedPath @((Get-SharedTraeUserRoot -ProductName "Trae"), "mcp.json"))
    $mcpCn = Read-Text -Path (Join-SharedPath @((Get-SharedTraeUserRoot -ProductName "Trae CN"), "mcp.json"))
    $historySnapshot = Get-TraeHistorySnapshot

    $content = @"
# Trae Imported Snapshot

Imported at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## User Rules
$(Clip-Lines -Text $userRules -MaxLines 80)

## Project Rules
$(Clip-Lines -Text $projectRules -MaxLines 80)

## Recent Local History
$(Clip-Lines -Text $historySnapshot -MaxLines 12)

## MCP User Config
$(Clip-Lines -Text $mcpUser -MaxLines 60)

## MCP CN Config
$(Clip-Lines -Text $mcpCn -MaxLines 60)
"@

    Write-TextIfChanged -Path (Join-Path $Script:ImportedRoot "trae.md") -Content ($content.Trim() + "`n") | Out-Null
}

function Get-InboxHighlights {
    $result = [ordered]@{}
    foreach ($definition in @(Get-AgentDefinitions)) {
        $items = @(Get-InboxSignalItems -Path (Get-AgentInboxPath -Slug $definition.slug) -MaxItems 12)
        if ($items.Count -eq 0) {
            $result[$definition.slug] = "(empty)"
            continue
        }

        $result[$definition.slug] = (($items | ForEach-Object { "- $_" }) -join "`n")
    }

    return $result
}

function Get-ImportedHighlights {
    $result = [ordered]@{}
    foreach ($definition in @(Get-AgentDefinitions)) {
        $result[$definition.slug] = Clip-Lines -Text (Read-Text -Path (Get-AgentImportedPath -Slug $definition.slug)) -MaxLines 60
    }

    return $result
}
