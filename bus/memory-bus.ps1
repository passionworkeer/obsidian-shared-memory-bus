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

$Script:UserHome = Get-SharedUserHome
$Script:BusHome = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { $PSScriptRoot }
$Script:BundleHome = Split-Path -Parent $PSScriptRoot
$Script:VaultRoot = Resolve-SharedStoreRoot -FallbackPath (Join-SharedPath @($Script:UserHome, "Documents", "Obsidian Vault"))
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

# Dot-source all module files (order matters for dependency resolution)
. (Join-Path $PSScriptRoot "memory-bus-helpers.ps1")
. (Join-Path $PSScriptRoot "memory-bus-agents.ps1")
. (Join-Path $PSScriptRoot "memory-bus-sync.ps1")
. (Join-Path $PSScriptRoot "memory-bus-cache.ps1")
. (Join-Path $PSScriptRoot "memory-bus-artifacts.ps1")
. (Join-Path $PSScriptRoot "memory-bus-text.ps1")
. (Join-Path $PSScriptRoot "memory-bus-signals.ps1")
. (Join-Path $PSScriptRoot "memory-bus-optimize.ps1")
. (Join-Path $PSScriptRoot "memory-bus-sync-points.ps1")

# ---- Project resolution helpers (kept in main file) ----

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

# ---- Ensure-BusTemplates (kept in main file; orchestrates template creation) ----

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

# ---- Artifact generation (kept in main file) ----

function Generate-Artifacts {
    Optimize-CanonicalNotes

    $obsidianText = Read-Text -Path $Script:CanonicalObsidian
    $memoryText = Read-Text -Path $Script:CanonicalMemory
    $workingText = Read-Text -Path $Script:CanonicalWorking
    $vaultAgentsText = Read-Text -Path $Script:VaultAgents
    $globalContextMdText = Read-Text -Path $Script:GlobalContextPath
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

# ---- Top-level orchestration ----

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