# Part of memory-bus.ps1 - extracted for size compliance
# Managed entrypoint synchronization, inbox/event writeback, mirror sync

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

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
"@.Trim() + "`n"
}

function Sync-ManagedEntrypoints {
    param([string]$ProjectDirectory)

    $codexInboxPath = Join-Path $Script:InboxRoot "codex.md"
    $traeInboxPath = Join-Path $Script:InboxRoot "trae.md"
    $claudeInboxPath = Join-Path $Script:InboxRoot "claude-code.md"
    $opencodeInboxPath = Join-Path $Script:InboxRoot "opencode.md"
    $copilotInboxPath = Join-Path $Script:InboxRoot "copilot.md"
    $hermesInboxPath = Join-Path $Script:InboxRoot "hermes-agent.md"
    $codexStartupPath = Join-Path $Script:StartupRoot "codex.md"
    $traeStartupPath = Join-Path $Script:StartupRoot "trae.md"
    $claudeStartupPath = Join-Path $Script:StartupRoot "claude-code.md"
    $opencodeStartupPath = Join-Path $Script:StartupRoot "opencode.md"
    $copilotStartupPath = Join-Path $Script:StartupRoot "copilot.md"
    $hermesStartupPath = Join-Path $Script:StartupRoot "hermes-agent.md"

$vaultAgents = @"
# Shared Memory Bus AI Collaboration Entry

This store is the canonical shared memory source for Claude Code, Codex, Trae, OpenClaw, OpenCode, GitHub Copilot, Hermes Agent, and newly onboarded agents.

## Canonical Files
- 02-KB/MEMORY.md: durable cross-session memory
- 02-KB/WORKING.md: current active work
- 00-System/ai-memory/generated/GLOBAL-CONTEXT.md: generated cross-tool context
- 00-System/ai-memory/generated/onboarding/: portable onboarding packs for future agents

## Shared Memory Bus
- 00-System/ai-memory/inbox/*.md are append-only writeback buffers per tool
- 00-System/ai-memory/imported/*.md are imported native-memory snapshots
- 00-System/ai-memory/events/*.jsonl is the append-only event log

## Rules
- Write stable, reusable facts into the appropriate tool inbox
- Keep WORKING.md focused on active work, not every transient thought
- Never store secrets, raw tokens, credentials, or private keys
"@
    Write-TextIfChanged -Path $Script:VaultAgents -Content ($vaultAgents.Trim() + "`n") | Out-Null

$codexAgents = @"
# Codex Global Shared Memory

You share a long-term memory layer with Claude Code, Trae, and OpenClaw through the shared memory bus.

## Read Order
Before doing substantive work, read these files in order:
1. $Script:CanonicalMemory
2. $Script:CanonicalWorking
3. $Script:GlobalContextPath
4. $Script:CodexMirror

## Writeback Policy
- Durable preferences, reusable methods, and cross-project facts go to $codexInboxPath
- Current-task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant project note
- Avoid duplicates and never store secrets, tokens, or credentials
- Background refresh is maintained by $Script:WatchdogScript

## Intent
- The shared memory bus is the long-term source of truth
- ~/.codex/memories is optional native state, not the canonical store
- When a fact matters across sessions or projects, write it back to the shared memory layer
"@
    Write-TextIfChanged -Path (Join-Path $Script:CodexRoot "AGENTS.md") -Content ($codexAgents.Trim() + "`n") | Out-Null

    $traeUserRules = @"
# Trae Global Shared Memory Rules

You share one long-term memory layer with Claude Code, Codex, and OpenClaw through the shared memory bus.

## Read Order
Before substantive work, read these files in order:
1. $Script:CanonicalMemory
2. $Script:CanonicalWorking
3. $Script:GlobalContextPath
4. $traeStartupPath

## Project Overlay
If the workspace contains `.trae/rules/project_rules.md`, treat it as the project-specific overlay on top of this global file.

## Writeback Policy
- Durable user preferences, cross-project facts, and reusable decisions go to $traeInboxPath
- Current-task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant project note
- Avoid duplicates and never store secrets, raw tokens, or credentials

## Tooling
- Use the shared memory MCP for search, read, and write operations when available
- If a fact is only useful for the current turn, keep it out of long-term memory
"@
    Write-TextIfChanged -Path (Join-Path $Script:TraeRulesRoot "user_rules.md") -Content ($traeUserRules.Trim() + "`n") | Out-Null

    if (-not [string]::IsNullOrWhiteSpace($ProjectDirectory)) {
        $traeProjectRules = @"
# Trae Project Shared Memory Overlay

Project root: $Script:PortableProjectRootPlaceholder

This file complements $Script:PortableTraeUserRulesPath for this workspace.

## Read Order
1. $Script:PortableTraeUserRulesPath
2. $Script:PortableCanonicalMemory
3. $Script:PortableCanonicalWorking
4. $Script:PortableGlobalContextPath
5. $Script:PortableTraeStartupPath

## Writeback Policy
- Cross-project durable facts go to $Script:PortableTraeInboxPath
- Current task progress goes to $Script:PortableCanonicalWorking
- Project-specific durable conclusions belong in the relevant project note
- Never store secrets, raw tokens, or credentials
"@
        Write-TextIfChanged -Path (Join-Path $ProjectDirectory $Script:TraeProjectRulesRelativePath) -Content ($traeProjectRules.Trim() + "`n") | Out-Null
    }

    $claudeSection = @"
## Shared Memory Bus

- Canonical long-term memory lives in the shared memory store, not only in local Claude-native stores.
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
## Shared Memory Bus

- Canonical long-term memory lives in the shared memory store, not only in local OpenCode session state.
- Before substantive work, read $Script:CanonicalMemory, $Script:CanonicalWorking, $Script:GlobalContextPath, and $opencodeStartupPath.
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
## Shared Memory Bus

- Canonical long-term memory lives in the shared memory store, not only in local Copilot session history.
- Before substantive work, read $Script:CanonicalMemory, $Script:CanonicalWorking, $Script:GlobalContextPath, and $copilotStartupPath.
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
## Shared Memory Bus

- Follow `CLAUDE.md` for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode and GitHub Copilot.
- Before substantive work, read $Script:PortableCanonicalMemory, $Script:PortableCanonicalWorking, $Script:PortableGlobalContextPath, and $Script:PortableCopilotStartupPath.
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
## Shared Memory Bus

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

    # Hermes Agent sync
    $hermesStartup = Read-Text -Path (Join-Path $Script:StartupRoot "hermes-agent.md")
    $hermesSection = @"
# Hermes Agent Shared Memory

You share a long-term memory layer with Claude Code, Codex, Trae, OpenClaw, OpenCode, and GitHub Copilot through the shared memory bus.

## Read Order
Before doing substantive work, read these files in order:
1. $Script:CanonicalMemory
2. $Script:CanonicalWorking
3. $Script:GlobalContextPath
4. $(Join-Path $Script:StartupRoot "hermes-agent.md")

## Writeback Policy
- Durable preferences, reusable methods, and cross-project facts go to $(Join-Path $Script:InboxRoot "hermes-agent.md")
- Current-task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant project note
- Avoid duplicates and never store secrets, tokens, or credentials

## Intent
- The shared memory bus is the long-term source of truth
- ~/.hermes/memories is optional native state, not the canonical store
- When a fact matters across sessions or projects, write it back to the shared memory layer
"@
    Write-Text -Path (Join-Path $Script:StartupRoot "hermes-agent.md") -Content ($hermesSection.Trim() + "`n")
}