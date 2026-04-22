param(
    [ValidateSet("Initialize", "SyncAll", "Generate", "RefreshDerivedArtifacts", "RecordEvent", "ClaudeSessionStart", "ClaudeTurnSync", "Status", "RegisterAgent")]
    [string]$Action = "SyncAll",
    [string]$Tool = "system",
    [string]$Project = "",
    [string]$Summary = "",
    [string]$AgentName = "",
    [string]$Preset = "generic",
    [switch]$Quiet
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

function Resolve-ObsidianVaultRoot {
    param([AllowEmptyString()][string]$FallbackPath = "")

    return (Resolve-SharedObsidianVaultRoot -FallbackPath $FallbackPath)
}

$Script:UserHome = Get-SharedUserHome
$Script:BusHome = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { $PSScriptRoot }
$Script:BundleHome = Split-Path -Parent $PSScriptRoot

function Resolve-BusScriptPath {
    param([Parameter(Mandatory = $true)][string[]]$Candidates)

    foreach ($root in @($Script:BusHome, $Script:BundleHome)) {
        if ([string]::IsNullOrWhiteSpace($root)) {
            continue
        }

        foreach ($candidate in @($Candidates)) {
            $path = Join-Path $root $candidate
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                return (Get-Item -LiteralPath $path).FullName
            }
        }
    }

    return (Join-Path $Script:BusHome $Candidates[0])
}

$Script:LegacyVaultRoot = Join-SharedPath @($Script:UserHome, "Documents", "Obsidian Vault")
$Script:VaultRoot = Resolve-ObsidianVaultRoot -FallbackPath $Script:LegacyVaultRoot
# 优先使用 Claude Code 实际写入的位置 (AI_MEMORY_ROOT/.ai-memory/)，与 Claude Code 一致
$Script:ClaudeMemoryRoot = Join-SharedPath @($Script:BusHome, ".ai-memory")
$Script:BusRoot = if ((Test-Path (Join-Path $Script:ClaudeMemoryRoot "structured"))) {
    $Script:ClaudeMemoryRoot
} elseif (Test-Path (Join-Path $Script:BusHome "structured")) {
    $Script:BusHome
} else {
    Join-SharedPath @($Script:VaultRoot, "00-System", "ai-memory")
}
$Script:GeneratedRoot = Join-Path $Script:BusRoot "generated"
$Script:StartupRoot = Join-Path $Script:GeneratedRoot "tool-startup"
$Script:InboxRoot = Join-Path $Script:BusRoot "inbox"
$Script:ImportedRoot = Join-Path $Script:BusRoot "imported"
$Script:EventsRoot = Join-Path $Script:BusRoot "events"
$Script:CanonicalObsidian = Join-SharedPath @($Script:VaultRoot, "02-KB", "OBSIDIAN.md")
$Script:CanonicalMemory = Join-SharedPath @($Script:VaultRoot, "02-KB", "MEMORY.md")
$Script:CanonicalWorking = Join-SharedPath @($Script:VaultRoot, "02-KB", "WORKING.md")
$Script:VaultAgents = Join-Path $Script:VaultRoot "AGENTS.md"
$Script:ClaudeRoot = Join-Path $Script:UserHome ".claude"
$Script:CodexRoot = Join-Path $Script:UserHome ".codex"
$Script:CodexAgentsPath = Join-Path $Script:CodexRoot "AGENTS.md"
$Script:CodexConfigPath = Join-Path $Script:CodexRoot "config.toml"
$Script:OpenClawRoot = Join-Path $Script:UserHome ".openclaw"
$Script:TraeRulesRoot = Join-Path $Script:UserHome ".trae"
$Script:TraeUserRulesPath = Join-Path $Script:TraeRulesRoot "user_rules.md"
$Script:TraeProjectRulesRelativePath = Join-SharedPath @(".trae", "rules", "project_rules.md")
$Script:ClaudeMirror = Join-SharedPath @($Script:ClaudeRoot, "memory", "OBSIDIAN-SHARED.md")
$Script:CodexMirror = Join-Path $Script:CodexRoot "OBSIDIAN-SHARED.md"
$Script:OpenClawSharedRoot = Join-SharedPath @($Script:OpenClawRoot, "workspace", "shared-memory")
$Script:OpenCodeSharedRoot = Get-SharedOpenCodeDataRoot
$Script:OpenCodeDbPath = Join-Path $Script:OpenCodeSharedRoot "opencode.db"
$Script:OpenCodeConfigRoot = Get-SharedOpenCodeConfigRoot
$Script:OpenCodeAgentsPath = Join-Path $Script:OpenCodeConfigRoot "AGENTS.md"
$Script:CopilotHome = Get-SharedCopilotHomeRoot
$Script:CopilotHomeInstructionsPath = Join-Path $Script:CopilotHome "copilot-instructions.md"
$Script:CopilotCliSessionRoot = Join-Path $Script:CopilotHome "session-state"
$Script:VsCodeUserRoot = Get-SharedVsCodeUserRoot -ProductName "Code"
$Script:CopilotGlobalStorage = Join-SharedPath @($Script:VsCodeUserRoot, "globalStorage", "github.copilot-chat")
$Script:CopilotWorkspaceStorageRoot = Join-SharedPath @($Script:VsCodeUserRoot, "workspaceStorage")
$Script:WatchdogScript = Resolve-BusScriptPath -Candidates @("memory-watchdog.ps1", "bus/memory-watchdog.ps1")
$Script:WatchdogStatePath = Join-Path $Script:BusHome "watchdog-state.json"
$Script:WatchdogStartupVbs = Get-SharedWatchdogStartupHookPath
$Script:GlobalContextPath = Join-Path $Script:GeneratedRoot "GLOBAL-CONTEXT.md"
$Script:GlobalJsonPath = Join-Path $Script:GeneratedRoot "GLOBAL-CONTEXT.json"
$Script:MemoryLayersGuidePath = Join-Path $Script:GeneratedRoot "MEMORY-LAYERS.md"
$Script:MemoryLayersJsonPath = Join-Path $Script:GeneratedRoot "MEMORY-LAYERS.json"
$Script:AutoDreamGuidePath = Join-Path $Script:GeneratedRoot "AUTO-DREAM.md"
$Script:AutoDreamJsonPath = Join-Path $Script:GeneratedRoot "AUTO-DREAM.json"
$Script:SharedSkillsGuidePath = Join-Path $Script:GeneratedRoot "SHARED-SKILLS.md"
$Script:SharedSkillsJsonPath = Join-Path $Script:GeneratedRoot "SHARED-SKILLS.json"
$Script:AgentRegistryPath = Join-Path $Script:BusHome "agents.json"
$Script:OnboardingRoot = Join-Path $Script:GeneratedRoot "onboarding"
$Script:UniversalArchitecturePath = Join-Path $Script:OnboardingRoot "ARCHITECTURE.md"
$Script:UniversalBootstrapPath = Join-Path $Script:OnboardingRoot "UNIVERSAL-AGENT-BOOTSTRAP.md"
$Script:SharedMcpManifestCache = $null
$Script:PortableVaultPlaceholder = "<obsidian-vault>"
$Script:PortableProjectRootPlaceholder = "<repo-root>"
$Script:PortableTraeUserRulesPath = "~/.trae/user_rules.md"
$Script:PortableCanonicalObsidian = "{0}/02-KB/OBSIDIAN.md" -f $Script:PortableVaultPlaceholder
$Script:PortableCanonicalMemory = "{0}/02-KB/MEMORY.md" -f $Script:PortableVaultPlaceholder
$Script:PortableCanonicalWorking = "{0}/02-KB/WORKING.md" -f $Script:PortableVaultPlaceholder
$Script:PortableGlobalContextPath = "{0}/00-System/ai-memory/generated/GLOBAL-CONTEXT.md" -f $Script:PortableVaultPlaceholder
$Script:PortableTraeStartupPath = "{0}/00-System/ai-memory/generated/tool-startup/trae.md" -f $Script:PortableVaultPlaceholder
$Script:PortableCopilotStartupPath = "{0}/00-System/ai-memory/generated/tool-startup/copilot.md" -f $Script:PortableVaultPlaceholder
$Script:PortableTraeInboxPath = "{0}/00-System/ai-memory/inbox/trae.md" -f $Script:PortableVaultPlaceholder
$Script:PortableOpenCodeInboxPath = "{0}/00-System/ai-memory/inbox/opencode.md" -f $Script:PortableVaultPlaceholder
$Script:PortableCopilotInboxPath = "{0}/00-System/ai-memory/inbox/copilot.md" -f $Script:PortableVaultPlaceholder
$Script:SharedSkillsSyncScript = Resolve-BusScriptPath -Candidates @("sync-shared-skills.ps1", "ops/sync/sync-shared-skills.ps1")
$Script:RefreshGeneratedArtifactsScript = Resolve-BusScriptPath -Candidates @("refresh-generated-artifacts.js", "ops/generate/refresh-generated-artifacts.js")
$Script:ClaudeMemApiBase = if ($env:CLAUDE_MEM_BASE) {
    $env:CLAUDE_MEM_BASE -replace '/+$', '' -replace '$', '/api'
} else {
    "http://127.0.0.1:37778/api"
}
$Script:BusLockTimeoutMs = 180000
$Script:StaleSyncSeconds = 20
$Script:CacheRoot = Join-Path $Script:BusHome "cache"
$Script:RuntimeCache = @{}
$Script:ProfileSync = $env:AI_MEMORY_PROFILE_SYNC -eq "1" -or $env:AI_MEMORY_PROFILE_SYNC -eq "true"

. (Join-Path $PSScriptRoot "memory-bus-helpers.ps1")
. (Join-Path $PSScriptRoot "memory-bus-agents.ps1")
. (Join-Path $PSScriptRoot "memory-bus-sync.ps1")

function Get-CacheEntry {
    param([Parameter(Mandatory = $true)][string]$Name)

    $path = Join-Path $Script:CacheRoot "$Name.json"
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    try {
        return Get-Content -Raw -LiteralPath $path -Encoding utf8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Set-CacheEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][object]$Value
    )

    Ensure-Directory -Path $Script:CacheRoot
    Write-Json -Path (Join-Path $Script:CacheRoot "$Name.json") -Value $Value
}

function With-BusLock {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [int]$TimeoutMs = $Script:BusLockTimeoutMs
    )

    $mutex = New-Object System.Threading.Mutex($false, "Global\AiMemoryBusV1")
    try {
        $lockAcquired = $false
        try {
            $lockAcquired = $mutex.WaitOne($TimeoutMs)
        } catch [System.Threading.AbandonedMutexException] {
            $lockAcquired = $true
        }

        if (-not $lockAcquired) {
            $msg = "Timed out waiting for AI memory bus lock after " + [int]($TimeoutMs / 1000) + "s. " +
                   "Another process is likely running SyncAll or Initialize. Wait for it to complete."
            Write-Error $msg
            throw "WATCHDOG_LOCK_FAILED: $msg"
        }

        & $ScriptBlock
    } finally {
        if ($lockAcquired) {
            try {
                [void]$mutex.ReleaseMutex()
            } catch {
            }
        }
        $mutex.Dispose()
    }
}

function Invoke-ProfiledStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock
    )

    if (-not $Script:ProfileSync) {
        & $ScriptBlock
        return
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $ScriptBlock
    } finally {
        $sw.Stop()
        [Console]::Error.WriteLine(("AI_MEMORY_PROFILE {0}: {1:N3}s" -f $Name, $sw.Elapsed.TotalSeconds))
    }
}

function Get-BusArtifactAgeSeconds {
    if (-not (Test-Path -LiteralPath $Script:GlobalContextPath)) {
        return [double]::PositiveInfinity
    }

    $age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $Script:GlobalContextPath).LastWriteTimeUtc).TotalSeconds
    if ($age -lt 0) {
        return 0.0
    }

    return $age
}

function Get-BusSourceNewestTimestampUtc {
    $newest = [datetime]::MinValue
    $paths = @(
        $Script:CanonicalObsidian,
        $Script:CanonicalMemory,
        $Script:CanonicalWorking,
        $Script:VaultAgents,
        $Script:SharedSkillsGuidePath,
        $Script:AgentRegistryPath
    )

    foreach ($path in @($paths)) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            $stamp = (Get-Item -LiteralPath $path).LastWriteTimeUtc
            if ($stamp -gt $newest) {
                $newest = $stamp
            }
        }
    }

    foreach ($root in @($Script:ImportedRoot, $Script:InboxRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path -LiteralPath $root)) {
            foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
                if ($item.LastWriteTimeUtc -gt $newest) {
                    $newest = $item.LastWriteTimeUtc
                }
            }
        }
    }

    return $newest
}

function Get-OptimizationSourceTimestampString {
    $newest = [datetime]::MinValue
    foreach ($root in @($Script:ImportedRoot, $Script:InboxRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path -LiteralPath $root)) {
            foreach ($item in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)) {
                if ($item.LastWriteTimeUtc -gt $newest) {
                    $newest = $item.LastWriteTimeUtc
                }
            }
        }
    }

    if ($newest -eq [datetime]::MinValue) {
        return (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }

    return $newest.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
}

function Test-BusArtifactsStale {
    param([int]$MaxAgeSeconds = $Script:StaleSyncSeconds)

    if ((Get-BusArtifactAgeSeconds) -ge [double]$MaxAgeSeconds) {
        return $true
    }

    if (-not (Test-Path -LiteralPath $Script:GlobalContextPath)) {
        return $true
    }

    $artifactStamp = (Get-Item -LiteralPath $Script:GlobalContextPath).LastWriteTimeUtc
    $sourceStamp = Get-BusSourceNewestTimestampUtc
    if ($sourceStamp -gt $artifactStamp.AddSeconds(1)) {
        return $true
    }

    return $false
}

function Sync-AllSourcesIfStale {
    param(
        [string]$ProjectPath,
        [int]$MaxAgeSeconds = $Script:StaleSyncSeconds
    )

    if (Test-BusArtifactsStale -MaxAgeSeconds $MaxAgeSeconds) {
        Sync-AllSources -ProjectPath $ProjectPath
        return $true
    }

    return $false
}

function Clip-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$MaxLines = 40
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    if ($lines.Count -le $MaxLines) {
        return ($lines -join "`n")
    }

    return ((@($lines[0..($MaxLines - 1)]) + "...") -join "`n")
}

function Tail-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$MaxLines = 40
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    if ($lines.Count -le $MaxLines) {
        return ($lines -join "`n")
    }

    $start = [Math]::Max(0, $lines.Count - $MaxLines)
    return (("..." + "`n") + (@($lines[$start..($lines.Count - 1)]) -join "`n"))
}

function HeadTail-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$HeadLines = 80,
        [int]$TailLinesCount = 80
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    $maxTotal = $HeadLines + $TailLinesCount
    if ($lines.Count -le $maxTotal) {
        return ($lines -join "`n")
    }

    $head = @($lines[0..($HeadLines - 1)])
    $tailStart = [Math]::Max(0, $lines.Count - $TailLinesCount)
    $tail = @($lines[$tailStart..($lines.Count - 1)])

    return ((($head -join "`n") + "`n...`n" + ($tail -join "`n")).Trim())
}

function Get-RecentFilesSummary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Filter = "*",
        [int]$MaxFiles = 5,
        [switch]$Recurse
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return "Path not found: $Path"
    }

    $items = @(
        Get-ChildItem -LiteralPath $Path -File -Filter $Filter -Recurse:$Recurse |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First $MaxFiles
    )

    if ($items.Count -eq 0) {
        return "No matching files found."
    }

    return ($items | ForEach-Object {
        "- {0} ({1}, {2} bytes)" -f $_.FullName, $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"), $_.Length
    }) -join "`n"
}


function Ensure-BusTemplates {
    $templates = @{
        $Script:CanonicalObsidian = @"
# Obsidian Collaboration Rules

- This vault is the canonical shared memory source for your AI tools.
- Durable cross-session knowledge belongs in 02-KB/MEMORY.md.
- Active task state belongs in 02-KB/WORKING.md.
- Generated cross-tool context lives under 00-System/ai-memory/generated/.
- Never store secrets, raw credentials, or private keys in shared memory.
"@
        $Script:CanonicalMemory = @"
# Shared Durable Memory

Write stable preferences, reusable workflows, long-lived project facts, and personal conventions here.
"@
        $Script:CanonicalWorking = @"
# Shared Working Memory

Use this note for current active work, short-lived plans, and handoff context across tools.
"@
        $Script:VaultAgents = @"
# Obsidian Vault AI Collaboration Entry

This vault is the canonical shared memory source for your connected AI tools.
"@
        (Join-Path $Script:BusRoot "README.md") = @"
# Shared AI Memory Bus

This folder is the shared memory layer for all connected AI tools.

## Layout
- generated/: machine-friendly startup context generated by the sync script
- inbox/: append-only writeback notes from each tool
- imported/: imported snapshots from native tool memory stores
- events/: append-only JSONL event log

## Rules
- Long-term human-edited memory stays in 02-KB/MEMORY.md
- Current work stays in 02-KB/WORKING.md
- Tools should write durable facts into their own inbox file first
- Never store secrets, tokens, or raw credentials here
"@
    }

    foreach ($entry in $templates.GetEnumerator()) {
        if (-not (Test-Path -LiteralPath $entry.Key)) {
            Write-Text -Path $entry.Key -Content ($entry.Value.Trim() + "`n")
        }
    }

    if (-not (Test-Path -LiteralPath $Script:AgentRegistryPath)) {
        Write-AgentRegistry -Registry ([ordered]@{
            version = 1
            agents = @()
        })
    }

    Ensure-Directory -Path $Script:OnboardingRoot
    Write-Text -Path $Script:UniversalBootstrapPath -Content (Build-UniversalBootstrapGuide)
    Write-Text -Path $Script:UniversalArchitecturePath -Content (Build-ArchitectureGuide)

    foreach ($definition in @(Get-AgentDefinitions)) {
        $inboxPath = Get-AgentInboxPath -Slug $definition.slug
        if (-not (Test-Path -LiteralPath $inboxPath)) {
            Write-Text -Path $inboxPath -Content (("# {0} Inbox`n`nAppend durable facts, reusable decisions, and cross-project preferences here.`n" -f $definition.displayName))
        }

        $importedPath = Get-AgentImportedPath -Slug $definition.slug
        if (-not (Test-Path -LiteralPath $importedPath)) {
            Write-Text -Path $importedPath -Content ("# {0} Imported Snapshot`n" -f $definition.displayName)
        }
    }
}

function Resolve-Project {
    if (-not [string]::IsNullOrWhiteSpace($Project)) {
        return $Project
    }

    try {
        $current = (Get-Location).Path
        if (-not [string]::IsNullOrWhiteSpace($current)) {
            return $current
        }
    } catch {
    }

    return ""
}

function Test-ProjectDirectory {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $false
    }

    $fullPath = (Get-Item -LiteralPath $Path).FullName
    $windowsPath = [System.IO.Path]::GetFullPath($env:WINDIR)
    if ($fullPath.StartsWith($windowsPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    foreach ($excluded in @($Script:UserHome, $Script:BusHome, $Script:VaultRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($excluded) -and
            $fullPath.Equals($excluded, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }

    foreach ($marker in @(".git", ".trae", ".claude", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "README.md")) {
        if (Test-Path -LiteralPath (Join-Path $fullPath $marker)) {
            return $true
        }
    }

    return $false
}

function Resolve-ProjectDirectory {
    param([string]$ProjectHint)

    if (Test-ProjectDirectory -Path $ProjectHint) {
        return (Get-Item -LiteralPath $ProjectHint).FullName
    }

    try {
        $current = (Get-Location).Path
        if (Test-ProjectDirectory -Path $current) {
            return (Get-Item -LiteralPath $current).FullName
        }
    } catch {
    }

    return ""
}


function Append-ToolInbox {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $path = Join-Path $Script:InboxRoot "$ToolName.md"
    Ensure-BusTemplates

    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $normalizedProject = if ([string]::IsNullOrWhiteSpace($ProjectPath)) { "global" } else { $ProjectPath }
    $line = "- [$stamp] [$normalizedProject] $Entry"
    $existing = Read-Text -Path $path
    if ($existing.Contains($line)) {
        return
    }

    Append-Text -Path $path -Content ("`n$line`n")
}

function Append-EventLog {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $eventPath = Join-Path $Script:EventsRoot ("{0}.jsonl" -f (Get-Date -Format "yyyy-MM"))
    $event = [ordered]@{
        timestamp = (Get-Date).ToString("o")
        tool = $ToolName
        project = $ProjectPath
        summary = $Entry
    } | ConvertTo-Json -Compress

    Append-Text -Path $eventPath -Content ($event + "`n")
}

function Build-StartupFile {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string]$WritebackPath,
        [Parameter(Mandatory = $true)][string]$ExtraReadPath
    )

    return @"
# $ToolName Shared Memory Bootstrap

Read in this order before doing substantive work:
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $Script:MemoryLayersGuidePath
6. $Script:AutoDreamGuidePath
7. $Script:SharedSkillsGuidePath
8. $ExtraReadPath

Writeback rules:
- Durable user preferences, cross-project facts, and reusable decisions go to $WritebackPath
- Current task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant vault project note
- Never store secrets, raw tokens, or credentials
- Avoid duplicates; append only when the fact is genuinely new

Retrieval defaults:
- Prefer the shared `memory` MCP for fuzzy cross-tool recall and historical search; use hybrid retrieval when available.
- Use the Obsidian MCP for direct note lookup, exact reads, and writeback.
"@.Trim() + "`n"
}

function Upsert-MarkedSection {
    param(
        [AllowEmptyString()][string]$ExistingText,
        [Parameter(Mandatory = $true)][string]$StartMarker,
        [Parameter(Mandatory = $true)][string]$EndMarker,
        [Parameter(Mandatory = $true)][string]$SectionBody,
        [ValidateSet("prepend", "append")][string]$Position = "append"
    )

    $normalizedExisting = Normalize-Text -Text $ExistingText
    $block = @"
$StartMarker
$SectionBody
$EndMarker
"@.Trim()

    if ($normalizedExisting.Contains($StartMarker) -and $normalizedExisting.Contains($EndMarker)) {
        $startIndex = $normalizedExisting.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
        $endIndex = $normalizedExisting.IndexOf($EndMarker, $startIndex, [System.StringComparison]::Ordinal)
        if ($startIndex -ge 0 -and $endIndex -ge 0) {
            $endIndex += $EndMarker.Length
            $prefix = $normalizedExisting.Substring(0, $startIndex).TrimEnd()
            # Split with limit=2 so we get at most 2 parts: [before, after]
            # Using Count check avoids an exception when -split returns only 1 element (no match).
            $suffix = if (($afterParts = @($normalizedExisting -split [regex]::Escape($EndMarker), 2)).Count -gt 1) { $afterParts[1] } else { "" }
            $parts = @()
            if (-not [string]::IsNullOrWhiteSpace($prefix)) { $parts += $prefix }
            $parts += $block
            if (-not [string]::IsNullOrWhiteSpace($suffix)) { $parts += $suffix }
            return ($parts -join "`n`n").Trim() + "`n"
        }
    }

    if ([string]::IsNullOrWhiteSpace($normalizedExisting)) {
        return $block + "`n"
    }

    if ($Position -eq "prepend") {
        return (($block + "`n`n" + $normalizedExisting).Trim() + "`n")
    }

    return (($normalizedExisting + "`n`n" + $block).Trim() + "`n")
}

function Get-MarkdownSectionText {
    param(
        [AllowEmptyString()][string]$Text,
        [string[]]$Headings
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized) -or $null -eq $Headings -or $Headings.Count -eq 0) {
        return ""
    }

    $sections = New-Object System.Collections.Generic.List[string]
    $buffer = New-Object System.Collections.Generic.List[string]
    $capture = $false

    foreach ($line in @($normalized -split "`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^##\s+' -or $trimmed -match '^#\s+') {
            if ($capture -and $buffer.Count -gt 0) {
                $sections.Add((($buffer.ToArray() -join "`n").Trim())) | Out-Null
                $buffer.Clear()
            }

            $capture = ($Headings -contains $trimmed)
            continue
        }

        if ($capture) {
            $buffer.Add($line) | Out-Null
        }
    }

    if ($capture -and $buffer.Count -gt 0) {
        $sections.Add((($buffer.ToArray() -join "`n").Trim())) | Out-Null
    }

    return [string]::Join("`n`n", @($sections))
}

function Convert-ToSignalItemText {
    param([AllowEmptyString()][string]$Line)

    $normalized = Normalize-Text -Text $Line
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }

    $item = ($normalized -replace '\s+', ' ').Trim()
    $item = $item -replace '^[\-\*\+]\s+', ''
    $item = $item -replace '^\d+\.\s+', ''
    if ($item -match '^(.*?)(?=- \[[0-9]{4}-[0-9]{2}-[0-9]{2})') {
        $item = $matches[1].Trim()
    }
    return $item.Trim()
}

function Test-MemoryNoiseLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if ([string]::IsNullOrWhiteSpace($item)) {
        return $true
    }

    $noisePatterns = @(
        '^(?:#|##|###)\s+',
        '^\|',
        '^\.\.\.$',
        '(?i)^Imported at:',
        '(?i)^Append durable facts, reusable decisions, and cross-project preferences here\.$',
        '(?i)SHARED-PROBE',
        '(?i)\bprobe-\d+',
        '(?i)\[cross-tool-test\]',
        '(?i)\bmarker-[a-z0-9_-]+',
        '(?i)stress-round',
        '(?i)ai-memory-pressure-test',
        '(?i)^No .* detected\.?$',
        '(?i)^No .* found\.?$',
        '(?i)^Project .* not found\.?$',
        '(?i)^OpenCode stats unavailable',
        '(?i)^opencode\.json not found',
        '(?i)^CLI path:',
        '(?i)^Database path:',
        '(?i)^Storage path:',
        '(?i)^Chat sessions path:',
        '(?i)^Session state root:',
        '(?i)^Matching CLI sessions:',
        '(?i)^Workspace path:',
        '(?i)^Last activity:',
        '(?i)^Total Cost\b',
        '(?i)^Avg Cost/Day\b',
        '(?i)^Avg Tokens/Session\b',
        '(?i)^Median Tokens/Session\b',
        '(?i)^Input\b',
        '(?i)^Output\b',
        '(?i)^Cache Read\b',
        '(?i)^Cache Write\b',
        '(?i)^Sessions\b',
        '(?i)^Messages\b',
        '(?i)^Days\b',
        '(?i)rollout-\d{4}',
        '(?i)\.jsonl\b'
    )

    foreach ($pattern in $noisePatterns) {
        if ($item -match $pattern) {
            return $true
        }
    }

    return $false
}

function Test-DurableSignalLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if (Test-MemoryNoiseLine -Line $item) {
        return $false
    }

    if ($item -match '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}') {
        return $false
    }

    if ($item -match '^[A-Za-z]:\\' -or $item -match '^".*":\s*\{?$' -or $item -match '^`?.+\.md`?$') {
        return $false
    }

    if ($item -match '(?i)(shared long-term storage|canonical|durable|writeback|read order|shared memory|workflow|strategy|obsidian|vault|claude-mem|mcp ready|initialized|worker port|database size|observations|summaries|react\b|typescript\b|vite\b|supabase|three\.js|swiftui|socket\.io)') {
        return $true
    }

    if ($item -match '(?i)^\*\*(name|timezone|os|python path|git)\*\*:') {
        return $true
    }

    return $false
}

function Test-WorkingSignalLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if (Test-MemoryNoiseLine -Line $item) {
        return $false
    }

    if ($item -match '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}') {
        return $true
    }

    if ($item -match '(?i)(current|active|working|handoff|recent|today|task|session|thread|topic|continue|verify|analyze|fix|memory)') {
        return $true
    }

    return $false
}

function Get-DedupedSignalItems {
    param(
        [string[]]$Lines,
        [int]$MaxItems = 8,
        [ValidateSet("durable", "working", "inbox")][string]$Mode = "working",
        [switch]$FromNewest
    )

    $items = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    if ($null -eq $Lines -or $Lines.Count -eq 0 -or $MaxItems -le 0) {
        return @()
    }

    $tryAdd = {
        param([AllowEmptyString()][string]$CurrentLine)

        $item = Convert-ToSignalItemText -Line $CurrentLine
        if ([string]::IsNullOrWhiteSpace($item)) {
            return
        }

        switch ($Mode) {
            "durable" {
                if (-not (Test-DurableSignalLine -Line $item)) {
                    return
                }
            }
            "working" {
                if (-not (Test-WorkingSignalLine -Line $item)) {
                    return
                }
            }
            "inbox" {
                if (Test-MemoryNoiseLine -Line $item) {
                    return
                }
            }
        }

        $key = $item.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            return
        }

        $seen[$key] = $true
        $items.Add($item) | Out-Null
    }

    if ($FromNewest) {
        for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
            & $tryAdd $Lines[$i]
            if ($items.Count -ge $MaxItems) {
                break
            }
        }
    } else {
        foreach ($line in @($Lines)) {
            & $tryAdd $line
            if ($items.Count -ge $MaxItems) {
                break
            }
        }
    }

    return $items.ToArray()
}

function Get-InboxSignalItems {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxItems = 8
    )

    $text = Read-Text -Path $Path
    $normalized = Normalize-Text -Text $text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return @()
    }

    return @(Get-DedupedSignalItems -Lines @($normalized -split "`n") -MaxItems $MaxItems -Mode "inbox" -FromNewest)
}

function Get-ImportedSignalItems {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet("durable", "working")][string]$Mode = "working",
        [int]$MaxItems = 8
    )

    $text = Read-Text -Path $Path
    $normalized = Normalize-Text -Text $text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return @()
    }

    $preferredHeadings = if ($Mode -eq "durable") {
        @(
            "## Strategy",
            "## USER.md",
            "## MEMORY.md",
            "## Claude-Mem Health",
            "## Claude-Mem Stats",
            "## Canonical Files",
            "## Writeback Policy"
        )
    } else {
        @(
            "## Recent Threads",
            "## Recent Sessions",
            "## Recent Prompts",
            "## Recent Session Topics"
        )
    }

    $candidateText = Get-MarkdownSectionText -Text $normalized -Headings $preferredHeadings
    if ([string]::IsNullOrWhiteSpace($candidateText) -and $Mode -eq "working") {
        return @()
    }

    if ([string]::IsNullOrWhiteSpace($candidateText)) {
        $candidateText = $normalized
    }

    return @(Get-DedupedSignalItems -Lines @($candidateText -split "`n") -MaxItems $MaxItems -Mode $Mode)
}

function Build-AutoOptimizedMemorySection {
    $generatedAt = Get-OptimizationSourceTimestampString
    $parts = New-Object System.Collections.Generic.List[string]
    $sourceCount = 0

    $parts.Add("## Auto-Optimized Durable Signals") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("Generated at: $generatedAt") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("This managed block keeps high-signal cross-tool memory additive and non-destructive.") | Out-Null

    foreach ($definition in @(Get-AgentDefinitions)) {
        $items = @(Get-ImportedSignalItems -Path (Get-AgentImportedPath -Slug $definition.slug) -Mode "durable" -MaxItems 6)
        if ($items.Count -eq 0) {
            continue
        }

        $sourceCount += 1
        $parts.Add("") | Out-Null
        $parts.Add(("### {0}" -f $definition.displayName)) | Out-Null
        $parts.Add("") | Out-Null
        foreach ($item in $items) {
            $parts.Add("- $item") | Out-Null
        }
    }

    if ($sourceCount -eq 0) {
        $parts.Add("") | Out-Null
        $parts.Add("- No durable signals detected yet.") | Out-Null
    }

    return (($parts.ToArray() -join "`n").Trim())
}

function Build-AutoOptimizedWorkingSection {
    $generatedAt = Get-OptimizationSourceTimestampString
    $parts = New-Object System.Collections.Generic.List[string]
    $sourceCount = 0

    $parts.Add("## Auto-Optimized Current Context") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("Generated at: $generatedAt") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("This managed block keeps the freshest cross-tool context available for session handoff.") | Out-Null

    foreach ($definition in @(Get-AgentDefinitions)) {
        $mergedItems = New-Object System.Collections.Generic.List[string]
        $seen = @{}

        foreach ($item in @(Get-ImportedSignalItems -Path (Get-AgentImportedPath -Slug $definition.slug) -Mode "working" -MaxItems 4)) {
            $key = $item.ToLowerInvariant()
            if ($seen.ContainsKey($key)) {
                continue
            }

            $seen[$key] = $true
            $mergedItems.Add($item) | Out-Null
        }

        foreach ($item in @(Get-InboxSignalItems -Path (Get-AgentInboxPath -Slug $definition.slug) -MaxItems 3)) {
            $key = $item.ToLowerInvariant()
            if ($seen.ContainsKey($key)) {
                continue
            }

            $seen[$key] = $true
            $mergedItems.Add($item) | Out-Null
        }

        if ($mergedItems.Count -eq 0) {
            continue
        }

        $sourceCount += 1
        $parts.Add("") | Out-Null
        $parts.Add(("### {0}" -f $definition.displayName)) | Out-Null
        $parts.Add("") | Out-Null
        foreach ($item in @($mergedItems | Select-Object -First 6)) {
            $parts.Add("- $item") | Out-Null
        }
    }

    if ($sourceCount -eq 0) {
        $parts.Add("") | Out-Null
        $parts.Add("- No active cross-tool context detected yet.") | Out-Null
    }

    return (($parts.ToArray() -join "`n").Trim())
}

function Optimize-CanonicalNotes {
    Ensure-BusTemplates

    $memoryExisting = Read-Text -Path $Script:CanonicalMemory
    $memoryUpdated = Upsert-MarkedSection -ExistingText $memoryExisting `
        -StartMarker "<!-- AUTO-OPTIMIZED-MEMORY:START -->" `
        -EndMarker "<!-- AUTO-OPTIMIZED-MEMORY:END -->" `
        -SectionBody (Build-AutoOptimizedMemorySection) `
        -Position "append"
    Write-TextIfChanged -Path $Script:CanonicalMemory -Content $memoryUpdated | Out-Null

    $workingExisting = Read-Text -Path $Script:CanonicalWorking
    $workingUpdated = Upsert-MarkedSection -ExistingText $workingExisting `
        -StartMarker "<!-- AUTO-OPTIMIZED-WORKING:START -->" `
        -EndMarker "<!-- AUTO-OPTIMIZED-WORKING:END -->" `
        -SectionBody (Build-AutoOptimizedWorkingSection) `
        -Position "append"
    Write-TextIfChanged -Path $Script:CanonicalWorking -Content $workingUpdated | Out-Null
}

function Sync-ManagedEntrypoints {
    param([string]$ProjectDirectory)

    $codexInboxPath = Join-Path $Script:InboxRoot "codex.md"
    $traeInboxPath = Join-Path $Script:InboxRoot "trae.md"
    $claudeInboxPath = Join-Path $Script:InboxRoot "claude-code.md"
    $opencodeInboxPath = Join-Path $Script:InboxRoot "opencode.md"
    $copilotInboxPath = Join-Path $Script:InboxRoot "copilot.md"
    $codexStartupPath = Join-Path $Script:StartupRoot "codex.md"
    $traeStartupPath = Join-Path $Script:StartupRoot "trae.md"
    $claudeStartupPath = Join-Path $Script:StartupRoot "claude-code.md"
    $opencodeStartupPath = Join-Path $Script:StartupRoot "opencode.md"
    $copilotStartupPath = Join-Path $Script:StartupRoot "copilot.md"

$vaultAgents = @"
# Obsidian Vault AI Collaboration Entry

This vault is the canonical shared memory source for Claude Code, Codex, Trae, OpenClaw, OpenCode, GitHub Copilot, and newly onboarded agents.

## Canonical Files
- 02-KB/OBSIDIAN.md: vault collaboration rules
- 02-KB/MEMORY.md: durable cross-session memory
- 02-KB/WORKING.md: current active work
- 00-System/ai-memory/generated/GLOBAL-CONTEXT.md: generated cross-tool context
- 00-System/ai-memory/generated/onboarding/: portable onboarding packs for future agents

## Shared Memory Bus
- 00-System/ai-memory/inbox/*.md are append-only writeback buffers per tool
- 00-System/ai-memory/imported/*.md are imported native-memory snapshots
- 00-System/ai-memory/events/*.jsonl is the append-only event log

## Rules
- Prefer the Obsidian MCP server for reads and writes when available
- Write stable, reusable facts into the appropriate tool inbox
- Keep WORKING.md focused on active work, not every transient thought
- Never store secrets, raw tokens, credentials, or private keys
"@
    Write-TextIfChanged -Path $Script:VaultAgents -Content ($vaultAgents.Trim() + "`n") | Out-Null

$codexAgents = @"
# Codex Global Shared Memory

You share a long-term memory layer with Claude Code, Trae, and OpenClaw through Obsidian.

## Read Order
Before doing substantive work, read these files in order:
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $Script:CodexMirror

## Tools
- The obsidian MCP server is configured in $Script:CodexConfigPath
- Prefer Obsidian MCP for search, read, and write operations

## Writeback Policy
- Durable preferences, reusable methods, and cross-project facts go to $codexInboxPath
- Current-task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant project note inside the vault
- Avoid duplicates and never store secrets, tokens, or credentials
- Background refresh is maintained by $Script:WatchdogScript

## Intent
- Obsidian is the shared long-term source of truth
- ~/.codex/memories is optional native state, not the canonical store
- When a fact matters across sessions or projects, write it back to the Obsidian shared layer
"@
    Write-TextIfChanged -Path (Join-Path $Script:CodexRoot "AGENTS.md") -Content ($codexAgents.Trim() + "`n") | Out-Null

    $traeUserRules = @"
# Trae Global Shared Memory Rules

You share one long-term memory layer with Claude Code, Codex, and OpenClaw through Obsidian.

## Read Order
Before substantive work, read these files in order:
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $traeStartupPath

## Project Overlay
If the workspace contains `.trae/rules/project_rules.md`, treat it as the project-specific overlay on top of this global file.

## Writeback Policy
- Durable user preferences, cross-project facts, and reusable decisions go to $traeInboxPath
- Current-task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant project note inside the vault
- Avoid duplicates and never store secrets, raw tokens, or credentials

## Tooling
- Prefer the Obsidian MCP server for search, read, and write operations when available
- If a fact is only useful for the current turn, keep it out of long-term memory
"@
    Write-TextIfChanged -Path (Join-Path $Script:TraeRulesRoot "user_rules.md") -Content ($traeUserRules.Trim() + "`n") | Out-Null

    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $traeProjectRules = @"
# Trae Project Shared Memory Overlay

Project root: $Script:PortableProjectRootPlaceholder

This file complements $Script:PortableTraeUserRulesPath for this workspace.

Resolve $Script:PortableVaultPlaceholder from `AI_MEMORY_OBSIDIAN_VAULT`, `OBSIDIAN_VAULT_ROOT`, or the active vault in Obsidian.

## Read Order
1. $Script:PortableTraeUserRulesPath
2. $Script:PortableCanonicalObsidian
3. $Script:PortableCanonicalMemory
4. $Script:PortableCanonicalWorking
5. $Script:PortableGlobalContextPath
6. $Script:PortableTraeStartupPath

## Writeback Policy
- Cross-project durable facts go to $Script:PortableTraeInboxPath
- Current task progress goes to $Script:PortableCanonicalWorking
- Project-specific durable conclusions belong in the relevant Obsidian project note
- Never store secrets, raw tokens, or credentials
"@
        Write-TextIfChanged -Path (Join-Path $ProjectDirectory $Script:TraeProjectRulesRelativePath) -Content ($traeProjectRules.Trim() + "`n") | Out-Null
    }

    $claudeSection = @"
## Shared Obsidian Memory Bus

- Canonical long-term memory lives in Obsidian, not only in local Claude-native stores.
- Session start injects $claudeStartupPath and the latest generated global context via hooks.
- Durable writeback target: $claudeInboxPath
- Current task tracking target: $Script:CanonicalWorking
- Never store secrets, raw tokens, or credentials in memory files.
"@
    $claudePath = Join-Path $Script:ClaudeRoot "CLAUDE.md"
    $claudeExisting = Read-Text -Path $claudePath
    $claudeUpdated = Upsert-MarkedSection -ExistingText $claudeExisting `
        -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" `
        -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" `
        -SectionBody $claudeSection `
        -Position "append"
    Write-TextIfChanged -Path $claudePath -Content $claudeUpdated | Out-Null

    $opencodeSection = @"
## Shared Obsidian Memory Bus

- Canonical long-term memory lives in Obsidian, not only in local OpenCode session state.
- Before substantive work, read $Script:CanonicalObsidian, $Script:CanonicalMemory, $Script:CanonicalWorking, $Script:GlobalContextPath, and $opencodeStartupPath.
- Durable writeback target: $opencodeInboxPath
- Current task tracking target: $Script:CanonicalWorking
- For tasks with 2 or more independent slices, prefer short-lived subagents/parallel decomposition instead of one long-running thread.
- Use matching skills from `.claude/skills`, `.agents/skills`, and repo skill folders when available.
"@
    $opencodeExisting = Read-Text -Path $Script:OpenCodeAgentsPath
    $opencodeUpdated = Upsert-MarkedSection -ExistingText $opencodeExisting `
        -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" `
        -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" `
        -SectionBody $opencodeSection `
        -Position "append"
    Write-TextIfChanged -Path $Script:OpenCodeAgentsPath -Content $opencodeUpdated | Out-Null

    $copilotHomeSection = @"
## Shared Obsidian Memory Bus

- Canonical long-term memory lives in Obsidian, not only in local Copilot session history.
- Before substantive work, read $Script:CanonicalObsidian, $Script:CanonicalMemory, $Script:CanonicalWorking, $Script:GlobalContextPath, and $copilotStartupPath.
- Durable writeback target: $copilotInboxPath
- Current task tracking target: $Script:CanonicalWorking
- For tasks with 2 or more independent slices, prefer subagents or separate focused waves instead of one long-running session.
- Use matching repo and global skills when available.
"@
    $copilotHomeExisting = Read-Text -Path $Script:CopilotHomeInstructionsPath
    $copilotHomeUpdated = Upsert-MarkedSection -ExistingText $copilotHomeExisting `
        -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" `
        -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" `
        -SectionBody $copilotHomeSection `
        -Position "append"
    Write-TextIfChanged -Path $Script:CopilotHomeInstructionsPath -Content $copilotHomeUpdated | Out-Null

    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $projectAgentsPath = Join-Path $ProjectDirectory "AGENTS.md"
        $projectAgentsSection = @"
## Shared Obsidian Memory Bus

- Follow `CLAUDE.md` for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode and GitHub Copilot.
- Resolve $Script:PortableVaultPlaceholder from `AI_MEMORY_OBSIDIAN_VAULT`, `OBSIDIAN_VAULT_ROOT`, or the active vault in Obsidian.
- Before substantive work, read $Script:PortableCanonicalObsidian, $Script:PortableCanonicalMemory, $Script:PortableCanonicalWorking, $Script:PortableGlobalContextPath, and $Script:PortableCopilotStartupPath.
- Durable writeback targets: $Script:PortableOpenCodeInboxPath (OpenCode), $Script:PortableCopilotInboxPath (GitHub Copilot)
- Current task tracking target: $Script:PortableCanonicalWorking
- For tasks with 2 or more independent slices, default to multi-agent/subagent decomposition.
- Use matching skills from `.claude/skills`, `.agents/skills`, `skills/`, and `.agents/skills/` when available.
"@
        $projectAgentsExisting = Read-Text -Path $projectAgentsPath
        $projectAgentsUpdated = Upsert-MarkedSection -ExistingText $projectAgentsExisting `
            -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" `
            -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" `
            -SectionBody $projectAgentsSection `
            -Position "append"
        Write-TextIfChanged -Path $projectAgentsPath -Content $projectAgentsUpdated | Out-Null

        $projectCopilotInstructionsPath = Join-SharedPath @($ProjectDirectory, ".github", "copilot-instructions.md")
        $projectCopilotSection = @"
## Shared Obsidian Memory Bus

- Resolve $Script:PortableVaultPlaceholder from `AI_MEMORY_OBSIDIAN_VAULT`, `OBSIDIAN_VAULT_ROOT`, or the active vault in Obsidian.
- Before long or multi-step work, consult `AGENTS.md`, $Script:PortableCanonicalMemory, $Script:PortableCanonicalWorking, $Script:PortableGlobalContextPath, and $Script:PortableCopilotStartupPath.
- Durable cross-project facts belong in $Script:PortableCopilotInboxPath.
- Current-task progress belongs in $Script:PortableCanonicalWorking.
- For tasks with 2 or more independent slices, prefer focused subagents or separate execution waves instead of one long-running context.
"@
        $projectCopilotExisting = Read-Text -Path $projectCopilotInstructionsPath
        $projectCopilotUpdated = Upsert-MarkedSection -ExistingText $projectCopilotExisting `
            -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" `
            -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" `
            -SectionBody $projectCopilotSection `
            -Position "append"
        Write-TextIfChanged -Path $projectCopilotInstructionsPath -Content $projectCopilotUpdated | Out-Null
    }
}

function Generate-Artifacts {
    Optimize-CanonicalNotes

    $obsidianText = Read-Text -Path $Script:CanonicalObsidian
    $memoryText = Read-Text -Path $Script:CanonicalMemory
    $workingText = Read-Text -Path $Script:CanonicalWorking
    $vaultAgentsText = Read-Text -Path $Script:VaultAgents
    # Read the token-budgeted GLOBAL-CONTEXT.md produced by ops/build-memory-layers.js
    $globalContextMdText = Read-Text -Path $Script:GlobalContextPath
    # Read the token-budgeted memory body produced by ops/build-memory-layers.js
    $globalContextBodyPath = Join-Path $Script:GeneratedRoot "GLOBAL-CONTEXT.body.md"
    $globalContextBodyText = if (Test-Path -LiteralPath $globalContextBodyPath) {
        Read-Text -Path $globalContextBodyPath
    } else {
        ""
    }
    $autoDreamText = Read-Text -Path $Script:AutoDreamGuidePath
    $sharedSkillsText = Read-Text -Path $Script:SharedSkillsGuidePath
    $imported = Get-ImportedHighlights
    $inboxes = Get-InboxHighlights
    $definitions = @(Get-AgentDefinitions)
    $generatedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    $importedSections = New-Object System.Collections.Generic.List[string]
    $inboxSections = New-Object System.Collections.Generic.List[string]
    $startupJson = [ordered]@{}
    $importedJson = [ordered]@{}
    $inboxJson = [ordered]@{}

    foreach ($definition in $definitions) {
        $startupPath = Get-AgentStartupPath -Slug $definition.slug
        $importedPath = Get-AgentImportedPath -Slug $definition.slug
        $inboxPath = Get-AgentInboxPath -Slug $definition.slug

        $startupText = Build-StartupFile -ToolName $definition.displayName -WritebackPath $inboxPath -ExtraReadPath $importedPath
        Write-Text -Path $startupPath -Content $startupText

        $startupJson[$definition.slug] = $startupPath
        $importedJson[$definition.slug] = $importedPath
        $inboxJson[$definition.slug] = $inboxPath

        $importedSections.Add(("### {0}`n{1}" -f $definition.displayName, $imported[$definition.slug])) | Out-Null
        $inboxSections.Add(("### {0}`n{1}" -f $definition.displayName, $inboxes[$definition.slug])) | Out-Null

        Write-OnboardingPack -Definition $definition
    }

    $globalContext = @"
# Shared AI Global Context

Generated at: $generatedAt

## Canonical Read Order
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath

## Vault Collaboration Rules
$(Clip-Lines -Text $obsidianText -MaxLines 80)

## Long-Term Memory
$(Clip-Lines -Text $memoryText -MaxLines 120)

## Current Working Context
$(Clip-Lines -Text $workingText -MaxLines 80)

## Memory Layers
$(if ([string]::IsNullOrWhiteSpace($globalContextBodyText)) { "(memory layers summary not generated yet)" } else { $globalContextBodyText })

## Auto Dream
$(if ([string]::IsNullOrWhiteSpace($autoDreamText)) { "(auto dream summary not generated yet)" } else { Clip-Lines -Text $autoDreamText -MaxLines 80 })

## Shared Skills
$(if ([string]::IsNullOrWhiteSpace($sharedSkillsText)) { "(shared skills guide not generated yet)" } else { Clip-Lines -Text $sharedSkillsText -MaxLines 120 })

## Vault Agent Entry
$(Clip-Lines -Text $vaultAgentsText -MaxLines 40)

## Imported Native Snapshots
$(if ($importedSections.Count -gt 0) { [string]::Join("`n`n", $importedSections) } else { "(no imported snapshots yet)" })

## Tool Writeback Inboxes
$(if ($inboxSections.Count -gt 0) { [string]::Join("`n`n", $inboxSections) } else { "(no inbox entries yet)" })
"@

    Write-TextIfChanged -Path $Script:GlobalContextPath -Content ($globalContext.Trim() + "`n") | Out-Null

    $jsonPayload = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        canonical = [ordered]@{
            obsidian = $Script:CanonicalObsidian
            memory = $Script:CanonicalMemory
            working = $Script:CanonicalWorking
            globalContext = $Script:GlobalContextPath
            globalContextBody = $globalContextBodyPath
            memoryLayers = $Script:MemoryLayersGuidePath
            autoDream = $Script:AutoDreamGuidePath
            sharedSkills = $Script:SharedSkillsGuidePath
        }
        registry = $Script:AgentRegistryPath
        onboardingRoot = $Script:OnboardingRoot
        sharedSkillsJson = $Script:SharedSkillsJsonPath
        startup = $startupJson
        imported = $importedJson
        inboxes = $inboxJson
    }
    Write-Json -Path $Script:GlobalJsonPath -Value $jsonPayload
}

function Sync-Mirrors {
    $sharedGlobal = Read-Text -Path $Script:GlobalContextPath
    $claudeStartup = Read-Text -Path (Join-Path $Script:StartupRoot "claude-code.md")
    $codexStartup = Read-Text -Path (Join-Path $Script:StartupRoot "codex.md")
    $openclawStartup = Read-Text -Path (Join-Path $Script:StartupRoot "openclaw.md")

    $claudeMirror = @"
# Obsidian Shared Memory Mirror

$(Normalize-Text -Text $claudeStartup)

## Shared Global Context
$(Normalize-Text -Text $sharedGlobal)
"@
    Write-Text -Path $Script:ClaudeMirror -Content ($claudeMirror.Trim() + "`n")

    $codexMirror = @"
# Obsidian Shared Memory Mirror

$(Normalize-Text -Text $codexStartup)

## Shared Global Context
$(Normalize-Text -Text $sharedGlobal)
"@
    Write-Text -Path $Script:CodexMirror -Content ($codexMirror.Trim() + "`n")

    Ensure-Directory -Path $Script:OpenClawSharedRoot
    Write-Text -Path (Join-Path $Script:OpenClawSharedRoot "STARTUP.md") -Content $openclawStartup
    Write-Text -Path (Join-Path $Script:OpenClawSharedRoot "GLOBAL-CONTEXT.md") -Content $sharedGlobal
    Write-Text -Path (Join-Path $Script:OpenClawSharedRoot "WRITEBACK.md") -Content @"
# OpenClaw Writeback Targets

- Durable facts: $(Join-Path $Script:InboxRoot "openclaw.md")
- Current tasks: $Script:CanonicalWorking
- Project notes: write to the relevant vault project note
"@
}

function Sync-AllSources {
    param([string]$ProjectPath)

    $projectDirectory = Resolve-ProjectDirectory -ProjectHint $ProjectPath
    Invoke-ProfiledStep -Name "Ensure-BusTemplates" -ScriptBlock {
        Ensure-BusTemplates
    }
    Invoke-ProfiledStep -Name "Sync-SharedSkills" -ScriptBlock {
        if (Test-Path -LiteralPath $Script:SharedSkillsSyncScript -PathType Leaf) {
            $wsArg = if ([string]::IsNullOrWhiteSpace($projectDirectory)) { "" } else { $projectDirectory }
            if (-not [string]::IsNullOrWhiteSpace($wsArg)) {
                Invoke-SharedPowerShellFile -ScriptPath $Script:SharedSkillsSyncScript -ArgumentList @(
                    "-WorkspaceRoot", $wsArg,
                    "-AiMemoryRoot", $Script:BusHome,
                    "-Quiet"
                ) 2>$null | Out-Null
            }
        }
    }
    Invoke-ProfiledStep -Name "Sync-ManagedEntrypoints" -ScriptBlock {
        Sync-ManagedEntrypoints -ProjectDirectory $projectDirectory
    }
    Invoke-ProfiledStep -Name "Sync-ClaudeSnapshot" -ScriptBlock {
        Sync-ClaudeSnapshot -ProjectDirectory $projectDirectory
    }
    Invoke-ProfiledStep -Name "Sync-CodexSnapshot" -ScriptBlock {
        Sync-CodexSnapshot
    }
    Invoke-ProfiledStep -Name "Sync-OpenClawSnapshot" -ScriptBlock {
        Sync-OpenClawSnapshot
    }
    Invoke-ProfiledStep -Name "Sync-OpenCodeSnapshot" -ScriptBlock {
        Sync-OpenCodeSnapshot -ProjectDirectory $projectDirectory
    }
    Invoke-ProfiledStep -Name "Sync-CopilotSnapshot" -ScriptBlock {
        Sync-CopilotSnapshot -ProjectDirectory $projectDirectory
    }
    Invoke-ProfiledStep -Name "Sync-TraeSnapshot" -ScriptBlock {
        Sync-TraeSnapshot -ProjectDirectory $projectDirectory
    }
    Invoke-ProfiledStep -Name "Refresh-GeneratedArtifacts" -ScriptBlock {
        [void](Invoke-GeneratedArtifactRefresh)
    }
    Invoke-ProfiledStep -Name "Generate-Artifacts" -ScriptBlock {
        Generate-Artifacts
    }
    Invoke-ProfiledStep -Name "Sync-Mirrors" -ScriptBlock {
        Sync-Mirrors
    }
}

function Get-ClaudeSessionStartOutput {
    $toolStartup = Read-Text -Path (Join-Path $Script:StartupRoot "claude-code.md")
    $globalContext = Read-Text -Path $Script:GlobalContextPath
    $payload = [ordered]@{
        continue = $true
        hookSpecificOutput = [ordered]@{
            hookEventName = "SessionStart"
            additionalContext = ((Normalize-Text -Text $toolStartup) + "`n`n" + (Normalize-Text -Text $globalContext)).Trim()
        }
    }

    return ($payload | ConvertTo-Json -Compress -Depth 8)
}

function Get-StatusObject {
    param([string]$ProjectDirectory)

    $startupMap = [ordered]@{}
    $importedMap = [ordered]@{}
    $inboxMap = [ordered]@{}
    foreach ($definition in @(Get-AgentDefinitions)) {
        $startupMap[$definition.slug] = Get-AgentStartupPath -Slug $definition.slug
        $importedMap[$definition.slug] = Get-AgentImportedPath -Slug $definition.slug
        $inboxMap[$definition.slug] = Get-AgentInboxPath -Slug $definition.slug
    }

    return [ordered]@{
        generatedAt = if (Test-Path -LiteralPath $Script:GlobalContextPath) { (Get-Item -LiteralPath $Script:GlobalContextPath).LastWriteTime.ToString("o") } else { $null }
        globalContext = $Script:GlobalContextPath
        memoryLayers = $Script:MemoryLayersGuidePath
        autoDream = $Script:AutoDreamGuidePath
        sharedSkillsGuide = $Script:SharedSkillsGuidePath
        sharedSkillsJson = $Script:SharedSkillsJsonPath
        claudeMirror = $Script:ClaudeMirror
        codexMirror = $Script:CodexMirror
        openclawMirror = Join-Path $Script:OpenClawSharedRoot "GLOBAL-CONTEXT.md"
        agentRegistry = $Script:AgentRegistryPath
        onboardingRoot = $Script:OnboardingRoot
        claudeInstructions = Join-Path $Script:ClaudeRoot "CLAUDE.md"
        codexAgents = Join-Path $Script:CodexRoot "AGENTS.md"
        opencodeAgents = $Script:OpenCodeAgentsPath
        copilotHomeInstructions = $Script:CopilotHomeInstructionsPath
        traeRules = Join-Path $Script:TraeRulesRoot "user_rules.md"
        traeProjectRules = if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) { $null } else { Join-Path $ProjectDirectory $Script:TraeProjectRulesRelativePath }
        projectAgents = if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) { $null } else { Join-Path $ProjectDirectory "AGENTS.md" }
        projectCopilotInstructions = if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) { $null } else { Join-SharedPath @($ProjectDirectory, ".github", "copilot-instructions.md") }
        vaultAgents = $Script:VaultAgents
        startup = $startupMap
        imported = $importedMap
        watchdog = [ordered]@{
            script = $Script:WatchdogScript
            state = $Script:WatchdogStatePath
            startupVbs = $Script:WatchdogStartupVbs
        }
        inboxes = $inboxMap
    }
}

$resolvedProject = Resolve-Project

switch ($Action) {
    "Initialize" {
        With-BusLock {
            Sync-AllSources -ProjectPath $resolvedProject
            if (-not $Quiet) {
                Write-Output "Initialized shared AI memory bus."
            }
        }
    }
    "SyncAll" {
        With-BusLock {
            Sync-AllSources -ProjectPath $resolvedProject
            if (-not [string]::IsNullOrWhiteSpace($Summary)) {
                Append-ToolInbox -ToolName $Tool -ProjectPath $resolvedProject -Entry $Summary
                Append-EventLog -ToolName $Tool -ProjectPath $resolvedProject -Entry $Summary
                Generate-Artifacts
                Sync-Mirrors
            }

            if (-not $Quiet) {
                Write-Output "Synced shared AI memory bus."
            }
        }
    }
    "Generate" {
        With-BusLock {
            Ensure-BusTemplates
            Generate-Artifacts
            Sync-Mirrors
            if (-not $Quiet) {
                Write-Output "Generated memory bus artifacts."
            }
        }
    }
    "RefreshDerivedArtifacts" {
        With-BusLock {
            if (-not (Invoke-GeneratedArtifactRefresh -Force)) {
                throw "STRUCTURED_SYNC_FAILED: Failed to refresh generated memory artifacts. Check watchdog-error.log for details."
            }

            if (-not $Quiet) {
                Write-Output "Refreshed derived memory artifacts."
            }
        }
    }
    "RecordEvent" {
        if ([string]::IsNullOrWhiteSpace($Summary)) {
            throw "RecordEvent requires -Summary."
        }

        With-BusLock {
            Sync-AllSourcesIfStale -ProjectPath $resolvedProject | Out-Null
            Append-ToolInbox -ToolName $Tool -ProjectPath $resolvedProject -Entry $Summary
            Append-EventLog -ToolName $Tool -ProjectPath $resolvedProject -Entry $Summary
            Generate-Artifacts
            Sync-Mirrors
        }
    }
    "ClaudeSessionStart" {
        With-BusLock {
            Sync-AllSourcesIfStale -ProjectPath $resolvedProject | Out-Null
            $json = Get-ClaudeSessionStartOutput
            [Console]::Out.Write($json)
        }
    }
    "ClaudeTurnSync" {
        With-BusLock {
            Sync-AllSourcesIfStale -ProjectPath $resolvedProject | Out-Null
            if (-not [string]::IsNullOrWhiteSpace($Summary)) {
                Append-ToolInbox -ToolName "claude-code" -ProjectPath $resolvedProject -Entry $Summary
                Append-EventLog -ToolName "claude-code" -ProjectPath $resolvedProject -Entry $Summary
                Generate-Artifacts
                Sync-Mirrors
            }
        }
    }
    "RegisterAgent" {
        $requestedName = if ([string]::IsNullOrWhiteSpace($AgentName)) { $Tool } else { $AgentName }
        if ([string]::IsNullOrWhiteSpace($requestedName) -or $requestedName -eq "system") {
            throw "RegisterAgent requires -AgentName or -Tool."
        }

        With-BusLock {
            Ensure-BusTemplates
            $definition = Register-AgentDefinition -Name $requestedName -PresetName $Preset
            Generate-Artifacts
            if (-not $definition.nativeImport) {
                Write-TextIfChanged -Path (Get-AgentImportedPath -Slug $definition.slug) -Content ("# {0} Imported Snapshot`n`nNative import not configured yet.`n" -f $definition.displayName) | Out-Null
            }
            Write-OnboardingPack -Definition $definition

            $payload = [ordered]@{
                registered = $true
                slug = $definition.slug
                displayName = $definition.displayName
                preset = $definition.preset
                startup = Get-AgentStartupPath -Slug $definition.slug
                imported = Get-AgentImportedPath -Slug $definition.slug
                inbox = Get-AgentInboxPath -Slug $definition.slug
                onboardingRoot = (Join-Path $Script:OnboardingRoot $definition.slug)
                registry = $Script:AgentRegistryPath
            }

            $payload | ConvertTo-Json -Depth 6
        }
    }
    "Status" {
        try {
            With-BusLock -TimeoutMs 5000 {
                Sync-AllSourcesIfStale -ProjectPath $resolvedProject | Out-Null
                $status = Get-StatusObject -ProjectDirectory (Resolve-ProjectDirectory -ProjectHint $resolvedProject)
                $status | ConvertTo-Json -Depth 8
            }
        } catch {
            $status = Get-StatusObject -ProjectDirectory (Resolve-ProjectDirectory -ProjectHint $resolvedProject)
            $status["staleRead"] = $true
            $status["statusWarning"] = "Status returned without waiting for the memory-bus lock."
            $status | ConvertTo-Json -Depth 8
        }
    }
}
