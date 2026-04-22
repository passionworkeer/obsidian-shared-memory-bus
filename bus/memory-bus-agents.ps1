# bus/memory-bus-agents.ps1
# Agent registry and onboarding helpers. Dot-sourced by memory-bus.ps1.

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
function Get-CoreAgentDefinitions {
    return @(
        [pscustomobject]@{ slug = "claude-code"; displayName = "Claude Code"; preset = "claude"; nativeImport = $true },
        [pscustomobject]@{ slug = "codex"; displayName = "Codex"; preset = "codex"; nativeImport = $true },
        [pscustomobject]@{ slug = "openclaw"; displayName = "OpenClaw"; preset = "openclaw"; nativeImport = $true },
        [pscustomobject]@{ slug = "trae"; displayName = "Trae"; preset = "trae"; nativeImport = $true },
        [pscustomobject]@{ slug = "opencode"; displayName = "OpenCode"; preset = "opencode"; nativeImport = $true },
        [pscustomobject]@{ slug = "copilot"; displayName = "GitHub Copilot"; preset = "copilot"; nativeImport = $true }
    )
}

function Read-AgentRegistry {
    $defaultRegistry = @{
        version = 1
        agents = @()
    }

    if (-not (Test-Path -LiteralPath $Script:AgentRegistryPath)) {
        return $defaultRegistry
    }

    try {
        $parsed = Get-Content -Raw -LiteralPath $Script:AgentRegistryPath -Encoding utf8 | ConvertFrom-Json
    } catch {
        return $defaultRegistry
    }

    $agents = New-Object System.Collections.Generic.List[object]
    foreach ($agent in @($parsed.agents)) {
        $rawSlug = [string]$agent.slug
        if ([string]::IsNullOrWhiteSpace($rawSlug)) {
            continue
        }

        $slug = ConvertTo-AgentSlug -Name $rawSlug
        if ([string]::IsNullOrWhiteSpace($slug)) {
            continue
        }

        $displayName = ConvertTo-AgentDisplayName -Name ([string]$agent.displayName) -FallbackSlug $slug
        $presetName = if ([string]::IsNullOrWhiteSpace([string]$agent.preset)) { "generic" } else { ([string]$agent.preset).Trim() }
        $agents.Add([pscustomobject]@{
            slug = $slug
            displayName = $displayName
            preset = $presetName
            nativeImport = $false
        }) | Out-Null
    }

    $versionValue = 1
    if ($null -ne $parsed.version) {
        $parsedVersionString = [string]$parsed.version
        if (-not [string]::IsNullOrWhiteSpace($parsedVersionString)) {
            $versionRef = 0
            if ([int]::TryParse($parsedVersionString, [ref]$versionRef)) {
                $versionValue = $versionRef
            }
        }
    }

    return @{
        version = $versionValue
        agents = $agents.ToArray()
    }
}

function Write-AgentRegistry {
    param([Parameter(Mandatory = $true)][object]$Registry)

    Write-Json -Path $Script:AgentRegistryPath -Value $Registry
}

function Get-AgentDefinitions {
    $map = [ordered]@{}
    foreach ($definition in @(Get-CoreAgentDefinitions)) {
        $map[$definition.slug] = $definition
    }

    $registry = Read-AgentRegistry
    foreach ($definition in @($registry.agents)) {
        $map[$definition.slug] = $definition
    }

    return @($map.Values)
}

function Get-AgentDefinition {
    param([AllowEmptyString()][string]$Slug)

    $normalizedSlug = ConvertTo-AgentSlug -Name $Slug
    foreach ($definition in @(Get-AgentDefinitions)) {
        if ($definition.slug -eq $normalizedSlug) {
            return $definition
        }
    }

    return $null
}

function Get-AgentInboxPath {
    param([Parameter(Mandatory = $true)][string]$Slug)
    return (Join-Path $Script:InboxRoot ((ConvertTo-AgentSlug -Name $Slug) + ".md"))
}

function Get-AgentImportedPath {
    param([Parameter(Mandatory = $true)][string]$Slug)
    return (Join-Path $Script:ImportedRoot ((ConvertTo-AgentSlug -Name $Slug) + ".md"))
}

function Get-AgentStartupPath {
    param([Parameter(Mandatory = $true)][string]$Slug)
    return (Join-Path $Script:StartupRoot ((ConvertTo-AgentSlug -Name $Slug) + ".md"))
}

function Resolve-BundleAssetPath {
    param([Parameter(Mandatory = $true)][string[]]$Candidates)

    foreach ($root in @($Script:BundleHome, $Script:BusHome)) {
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

function Get-SharedMcpManifest {
    if ($null -eq $Script:SharedMcpManifestCache) {
        $manifestPath = Resolve-BundleAssetPath -Candidates @("shared-mcp\manifest.json")
        $Script:SharedMcpManifestCache = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
    }

    return $Script:SharedMcpManifestCache
}

function Get-OnboardingSharedMcpServers {
    param([switch]$IncludeOptional)

    $manifest = Get-SharedMcpManifest
    $servers = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    foreach ($server in @($manifest.servers)) {
        $serverId = [string]$server.id
        $serverMode = [string]$server.mode

        $shouldInclude = $false
        if ($serverId -eq "MiniMax") {
            $shouldInclude = $IncludeOptional
        } elseif ($serverMode -eq "shared" -or $serverId -eq "playwright") {
            $shouldInclude = $true
        }

        if ($shouldInclude -and -not $seen.ContainsKey($serverId)) {
            $servers.Add($server) | Out-Null
            $seen[$serverId] = $true
        }
    }

    return @($servers.ToArray())
}

function Get-OnboardingSharedMcpUrl {
    param([Parameter(Mandatory = $true)][object]$Server)

    $manifest = Get-SharedMcpManifest
    return ("http://{0}:{1}{2}" -f $manifest.defaults.host, [int]$Server.port, $manifest.defaults.path)
}

function Build-OnboardingObsidianStdioConfigJson {
    $obsidianMcpScript = ((Resolve-BusScriptPath -Candidates @("run-obsidian-mcp.ps1", "ops/run/run-obsidian-mcp.ps1")) -replace "\\", "/")
    $payload = [ordered]@{
        mcpServers = [ordered]@{
            obsidian = [ordered]@{
                command = (Get-SharedPowerShellCommandName)
                args = (Get-SharedPowerShellFileArguments -ScriptPath $obsidianMcpScript)
            }
        }
    }

    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

function Build-OnboardingMcpConfigJson {
    return (Build-OnboardingObsidianStdioConfigJson)
}

function Build-OnboardingSharedMcpCodexToml {
    param([switch]$IncludeOptional)

    $title = if ($IncludeOptional) {
        "# Shared MCP HTTP snippets for Codex (safe default set + optional services)"
    } else {
        "# Shared MCP HTTP snippets for Codex (safe default set)"
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($title) | Out-Null

    foreach ($server in @(Get-OnboardingSharedMcpServers -IncludeOptional:$IncludeOptional)) {
        $lines.Add("") | Out-Null
        $lines.Add(("[mcp_servers.{0}]" -f [string]$server.id)) | Out-Null
        $lines.Add(('url = "{0}"' -f (Get-OnboardingSharedMcpUrl -Server $server))) | Out-Null
        $lines.Add("startup_timeout_sec = 60") | Out-Null
    }

    return (($lines -join "`n").Trim() + "`n")
}

function Build-OnboardingSharedMcpCursorJson {
    param([switch]$IncludeOptional)

    $payload = [ordered]@{ mcpServers = [ordered]@{} }
    foreach ($server in @(Get-OnboardingSharedMcpServers -IncludeOptional:$IncludeOptional)) {
        $payload.mcpServers[[string]$server.id] = [ordered]@{
            url = (Get-OnboardingSharedMcpUrl -Server $server)
        }
    }

    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

function Build-OnboardingSharedMcpCopilotJson {
    param([switch]$IncludeOptional)

    $payload = [ordered]@{ servers = [ordered]@{} }
    foreach ($server in @(Get-OnboardingSharedMcpServers -IncludeOptional:$IncludeOptional)) {
        $payload.servers[[string]$server.id] = [ordered]@{
            type = "http"
            url = (Get-OnboardingSharedMcpUrl -Server $server)
        }
    }

    return (($payload | ConvertTo-Json -Depth 8).Trim() + "`n")
}

function Build-OnboardingSharedMcpGuide {
    $safeServers = @(Get-OnboardingSharedMcpServers)
    $optionalServers = @(Get-OnboardingSharedMcpServers -IncludeOptional | Where-Object { [string]$_.id -eq "MiniMax" })
    $safeLines = @($safeServers | ForEach-Object {
        "- ``{0}`` -> ``{1}``" -f [string]$_.id, (Get-OnboardingSharedMcpUrl -Server $_)
    })
    $optionalLines = @($optionalServers | ForEach-Object {
        "- ``{0}`` -> ``{1}``" -f [string]$_.id, (Get-OnboardingSharedMcpUrl -Server $_)
    })

    return @"
# Shared MCP Bundle

Use the HTTP snippets in this folder as the default MCP transport on Windows, macOS, and Linux.

## Recommended Default Set
$(if ($safeLines.Count -gt 0) { $safeLines -join "`n" } else { "- (none)" })

## Optional Set
$(if ($optionalLines.Count -gt 0) { $optionalLines -join "`n" } else { "- (none)" })

## File Map
- ``codex.shared-mcp.toml``: Codex HTTP MCP config
- ``cursor.shared-mcp.json``: Cursor HTTP MCP config
- ``copilot.shared-mcp.json``: GitHub Copilot HTTP MCP config
- ``*.optional.*``: optional services such as MiniMax
- ``obsidian-stdio.json``: fallback only for hosts that still need a local stdio launcher instead of the shared HTTP layer

## Rule Of Thumb
- Prefer the HTTP shared MCP snippets first
- Keep ``obsidian-stdio.json`` only as a compatibility fallback
- Add plugins only after MCP plus skill integration already works
"@.Trim() + "`n"
}

function Build-OnboardingAgentRules {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    $startupPath = Get-AgentStartupPath -Slug $Definition.slug
    $writebackPath = Get-AgentInboxPath -Slug $Definition.slug

    return @"
# $($Definition.displayName) Shared Memory Rules

You are connected to a shared human-readable memory bus backed by Obsidian.

## Read Order
Before doing substantive work, read these files in order:
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $startupPath

## Writeback Policy
- Durable user preferences, reusable workflows, and cross-project facts go to $writebackPath
- Current task progress belongs in $Script:CanonicalWorking
- Project-specific durable knowledge belongs in the relevant vault project note
- Avoid duplicates and never store secrets, raw tokens, or credentials

## Operating Defaults
- Prefer short, decomposed work over a single very long-running thread
- If the client supports subagents, split independent slices into focused subagents
- Re-check $Script:GlobalContextPath before a major handoff or after a long task
"@.Trim() + "`n"
}

function Build-OnboardingCursorRule {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    $startupPath = Get-AgentStartupPath -Slug $Definition.slug
    $writebackPath = Get-AgentInboxPath -Slug $Definition.slug

    return @"
---
description: Shared Obsidian memory bootstrap
alwaysApply: true
---

Read these files before substantive work:
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $startupPath

Write durable cross-project facts to:
- $writebackPath

Write current active task progress to:
- $Script:CanonicalWorking

Defaults:
- Prefer multi-step decomposition over one very long session
- If subagents are available, use them for independent work slices
- Never store secrets, tokens, or credentials in memory files
"@.Trim() + "`n"
}

function Build-OnboardingSkillTemplate {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    $startupPath = Get-AgentStartupPath -Slug $Definition.slug
    $writebackPath = Get-AgentInboxPath -Slug $Definition.slug

    return @"
# Shared Memory Coordination

Use this skill to keep $($Definition.displayName) aligned with the shared Obsidian memory bus.

## Read Order
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $startupPath

## Writeback
- Durable cross-project facts -> $writebackPath
- Current task state -> $Script:CanonicalWorking
- Project-specific durable notes -> the relevant project note
- Never write secrets, raw tokens, or credentials

## Best Default Stack
- Layer 1: shared HTTP MCP for ``memory``, ``obsidian``, ``context7``, ``fetch``, ``time``, ``sequential-thinking``, and shared ``playwright``
- Layer 2: this skill plus the generated bootstrap/rule files for behavior, read order, and decomposition
- Layer 3: a thin plugin adapter only if the host app needs native lifecycle hooks or UI

## Multi-Agent Default
- Prefer short focused work over one endlessly growing thread
- If the host supports subagents, split independent slices into subagents
- Re-read $Script:GlobalContextPath before a major handoff or after a long task
"@.Trim() + "`n"
}

function Build-OnboardingPluginAdapterGuide {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    return @"
# Thin Plugin Adapter

Use a plugin only as the last-mile adapter for $($Definition.displayName) when config files plus skills are not enough.

## The Plugin Should Do
- inject or point the host at ``bootstrap.md`` or ``generic/AGENTS.md``
- wire the host's MCP settings to the HTTP snippets in ``generic/``
- expose small host-native affordances such as "open WORKING.md" or "run sync now"

## The Plugin Should Not Own
- canonical memory schema
- embeddings or retrieval logic
- shared MCP lifecycle management
- durable writeback policy beyond forwarding into the same inbox targets
- duplicated copies of the skill/bootstrap text

## Best Shape
- keep the plugin thin
- keep the durable memory contract in markdown and shared skills
- keep shared tool transport in MCP config

## Escalate To A Plugin Only When
- the host cannot read a startup rule file or skill cleanly
- the host needs native menu items, settings UI, or lifecycle hooks
- config-only wiring cannot reliably inject the shared MCP endpoints
"@.Trim() + "`n"
}

function Build-OnboardingPlatformGuide {
    return @"
# Platform Strategy

## Windows
- full control plane: installer, watchdog, shared MCP startup, verification scripts
- best place to host the canonical local runtime

## macOS
- use the shared HTTP MCP snippets plus the portable skill/rule files first
- portable core flows are smoke-validated, but full local startup orchestration is still less automated than Windows

## Linux
- use the shared HTTP MCP snippets plus the portable skill/rule files first
- portable core flows are smoke-validated, but full local startup orchestration is still less automated than Windows

## Best Cross-Platform Default
- shared HTTP MCP for transport
- shared skill / AGENTS bootstrap for behavior
- thin plugin adapter only as a host-native last mile
"@.Trim() + "`n"
}

function Build-OnboardingReadme {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    $agentPackRoot = Join-Path $Script:OnboardingRoot $Definition.slug
    $startupPath = Get-AgentStartupPath -Slug $Definition.slug
    $writebackPath = Get-AgentInboxPath -Slug $Definition.slug

    return @"
# $($Definition.displayName) Onboarding Pack

This folder is the portable shared-memory pack for $($Definition.displayName).

## What to hand to the new agent
- ``generic/AGENTS.md``: universal rule file for agents that support a global instruction file
- ``generic/codex.shared-mcp.toml`` / ``cursor.shared-mcp.json`` / ``copilot.shared-mcp.json``: shared HTTP MCP snippets for the safe default set
- ``generic/*.optional.*``: optional shared MCP snippets such as MiniMax
- ``generic/obsidian-stdio.json``: fallback MCP snippet for hosts that still require a local stdio launcher
- ``generic/skills/shared-memory/SKILL.md``: portable skill template for behavior, read order, and writeback policy
- ``generic/plugin/README.md``: thin plugin-adapter contract for host-native last-mile integrations
- ``generic/platforms.md``: cross-platform recommendation for Windows, macOS, and Linux
- ``cursor/.cursor/rules/shared-memory.mdc``: ready-to-copy Cursor rule
- ``cursor/.cursor/mcp.json``: ready-to-copy Cursor HTTP MCP config snippet
- ``bootstrap.md``: generated per-agent startup file

## Canonical Memory Contract
- Human-readable source of truth: $Script:CanonicalMemory
- Active work note: $Script:CanonicalWorking
- Generated cross-tool context: $Script:GlobalContextPath
- Shared skills guide: $Script:SharedSkillsGuidePath
- Per-agent durable writeback: $writebackPath
- Per-agent startup file: $startupPath

## Expected behavior
- Read the canonical files before substantive work
- Write only durable, reusable facts into the agent inbox
- Keep project-local conclusions in the relevant project note
- Prefer shorter focused runs or subagents over one endlessly growing session
- Default to ``shared HTTP MCP + shared skill`` and add a plugin only if the host truly needs a native adapter

## Pack root
$agentPackRoot
"@.Trim() + "`n"
}

function Build-UniversalBootstrapGuide {
    return @"
# Universal Agent Bootstrap

This file is the portable contract for connecting any new AI agent to the shared Obsidian memory bus.

## Canonical Source of Truth
1. $Script:CanonicalObsidian
2. $Script:CanonicalMemory
3. $Script:CanonicalWorking
4. $Script:GlobalContextPath
5. $Script:SharedSkillsGuidePath

## Minimum Requirements For A New Agent
- It can read local files or use the Obsidian MCP server
- It can write durable facts into a markdown file inside $Script:InboxRoot
- It can accept one startup rule file or system prompt
- It should discover portable skills from `.agents/skills` and project `.agents/skills` when those folders exist

## Standard Writeback Rules
- Durable cross-project facts go to the agent-specific inbox file
- Current task state goes to $Script:CanonicalWorking
- Project-specific durable knowledge goes to the relevant vault project note
- Never store secrets, raw tokens, or credentials

## Multi-Agent Default
- If an agent supports subagents or multi-agent decomposition, prefer short focused subagents for independent task slices
- Re-read $Script:GlobalContextPath before long handoffs or after substantial work

## Recommended Architecture
- L0 canonical truth: Obsidian markdown notes
- L1 operational bus: generated startup files, inboxes, imported snapshots, event log
- L2 optional semantic accelerator: a service such as mcp-memory-service, without replacing the markdown source of truth
- Default integration bundle: shared HTTP MCP + portable skill + thin plugin adapter only when needed
"@.Trim() + "`n"
}

function Build-ArchitectureGuide {
    return @"
# Shared Memory Architecture

## Recommended Layers
- L0 Canonical Source: Obsidian markdown files are the human-readable source of truth
- L1 Shared Bus: ``generated/``, ``inbox/``, ``imported/``, and ``events/`` keep tools aligned
- L2 Semantic Accelerator: add a retriever or knowledge-graph service only as a secondary layer

## Why This Layout
- Markdown stays inspectable, editable, and tool-agnostic
- MCP gives modern clients one common read/write entrypoint
- New agents only need a rule file plus one writeback target to join the system

## External Solution Guidance
- Keep ``memory-lancedb-pro`` as an OpenClaw-side enhancement, not the global source of truth
- Keep ``OpenMemory`` and ``Mem0`` as optional app/server memory layers, not the canonical store for this setup
- Prefer ``mcp-memory-service`` if you want to add a shared semantic recall layer for Cursor, Codex, Claude Code, Copilot, and similar clients

## If You Add mcp-memory-service Later
- Treat it as an accelerator and coordination layer, not the human-edit source of truth
- Ingest from MEMORY.md, WORKING.md, inbox/, imported/, and events/ on a schedule or watcher
- Keep write-through behavior: durable facts should still land in markdown inbox files
- Use the service for semantic recall, graph traversal, remote MCP, and multi-agent routing

## Future-Proof Onboarding Contract
- Give the new agent one onboarding pack from ``generated/onboarding/<agent>/``
- Prefer the shared HTTP MCP snippets in the onboarding pack
- Keep ``obsidian-stdio.json`` only as a compatibility fallback
- Configure the agent rule file or skill to read the canonical files and write back into its inbox
- Keep plugins thin and host-native; do not move canonical memory logic into them
- Keep portable shared skills in ``~/.agents/skills`` and repo-local portable skills in ``.agents/skills``
"@.Trim() + "`n"
}

function Write-OnboardingPack {
    param([Parameter(Mandatory = $true)][pscustomobject]$Definition)

    $agentRoot = Join-Path $Script:OnboardingRoot $Definition.slug
    $genericRoot = Join-Path $agentRoot "generic"
    $skillRoot = Join-SharedPath @($genericRoot, "skills", "shared-memory")
    $pluginRoot = Join-Path $genericRoot "plugin"
    $cursorRulesRoot = Join-SharedPath @($agentRoot, "cursor", ".cursor", "rules")
    $cursorRoot = Join-SharedPath @($agentRoot, "cursor", ".cursor")
    $startupPath = Get-AgentStartupPath -Slug $Definition.slug

    Ensure-Directory -Path $agentRoot
    Ensure-Directory -Path $genericRoot
    Ensure-Directory -Path $skillRoot
    Ensure-Directory -Path $pluginRoot
    Ensure-Directory -Path $cursorRulesRoot
    Ensure-Directory -Path $cursorRoot

    Write-Text -Path (Join-Path $agentRoot "README.md") -Content (Build-OnboardingReadme -Definition $Definition)
    Write-Text -Path (Join-Path $agentRoot "bootstrap.md") -Content (Read-Text -Path $startupPath)
    Write-Text -Path (Join-Path $genericRoot "AGENTS.md") -Content (Build-OnboardingAgentRules -Definition $Definition)
    Write-Text -Path (Join-Path $genericRoot "mcp-http.md") -Content (Build-OnboardingSharedMcpGuide)
    Write-Text -Path (Join-Path $genericRoot "codex.shared-mcp.toml") -Content (Build-OnboardingSharedMcpCodexToml)
    Write-Text -Path (Join-Path $genericRoot "cursor.shared-mcp.json") -Content (Build-OnboardingSharedMcpCursorJson)
    Write-Text -Path (Join-Path $genericRoot "copilot.shared-mcp.json") -Content (Build-OnboardingSharedMcpCopilotJson)
    Write-Text -Path (Join-Path $genericRoot "codex.shared-mcp.optional.toml") -Content (Build-OnboardingSharedMcpCodexToml -IncludeOptional)
    Write-Text -Path (Join-Path $genericRoot "cursor.shared-mcp.optional.json") -Content (Build-OnboardingSharedMcpCursorJson -IncludeOptional)
    Write-Text -Path (Join-Path $genericRoot "copilot.shared-mcp.optional.json") -Content (Build-OnboardingSharedMcpCopilotJson -IncludeOptional)
    Write-Text -Path (Join-Path $genericRoot "obsidian-stdio.json") -Content (Build-OnboardingObsidianStdioConfigJson)
    Write-Text -Path (Join-Path $skillRoot "SKILL.md") -Content (Build-OnboardingSkillTemplate -Definition $Definition)
    Write-Text -Path (Join-Path $pluginRoot "README.md") -Content (Build-OnboardingPluginAdapterGuide -Definition $Definition)
    Write-Text -Path (Join-Path $genericRoot "platforms.md") -Content (Build-OnboardingPlatformGuide)
    Write-Text -Path (Join-Path $cursorRulesRoot "shared-memory.mdc") -Content (Build-OnboardingCursorRule -Definition $Definition)
    Write-Text -Path (Join-Path $cursorRoot "mcp.json") -Content (Build-OnboardingSharedMcpCursorJson)
}

function Register-AgentDefinition {
    param(
        [AllowEmptyString()][string]$Name,
        [AllowEmptyString()][string]$PresetName = "generic"
    )

    $rawName = if ([string]::IsNullOrWhiteSpace($Name)) { $Tool } else { $Name }
    $slug = ConvertTo-AgentSlug -Name $rawName
    $displayName = ConvertTo-AgentDisplayName -Name $rawName -FallbackSlug $slug
    $presetValue = if ([string]::IsNullOrWhiteSpace($PresetName)) { "generic" } else { $PresetName.Trim().ToLowerInvariant() }

    $coreDefinition = @(Get-CoreAgentDefinitions | Where-Object { $_.slug -eq $slug } | Select-Object -First 1)
    if ($coreDefinition.Count -gt 0) {
        return [pscustomobject]@{
            slug = $coreDefinition[0].slug
            displayName = $coreDefinition[0].displayName
            preset = $coreDefinition[0].preset
            nativeImport = $coreDefinition[0].nativeImport
        }
    }

    $registry = Read-AgentRegistry
    $agents = New-Object System.Collections.Generic.List[object]
    foreach ($agent in @($registry.agents | Where-Object { $_.slug -ne $slug })) {
        $agents.Add($agent) | Out-Null
    }

    $definition = [pscustomobject]@{
        slug = $slug
        displayName = $displayName
        preset = $presetValue
        nativeImport = $false
    }
    $agents.Add($definition) | Out-Null

    $registry.agents = @($agents | Sort-Object displayName, slug)
    Write-AgentRegistry -Registry $registry
    return $definition
}

function Read-SimpleKeyValueFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]$map
    }

    foreach ($line in @(Get-Content -LiteralPath $Path -Encoding utf8 -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("#")) {
            continue
        }

        $separatorIndex = $line.IndexOf(":")
        if ($separatorIndex -lt 0) {
            continue
        }

        $key = $line.Substring(0, $separatorIndex).Trim()
        $value = $line.Substring($separatorIndex + 1).Trim()
        if (-not [string]::IsNullOrWhiteSpace($key)) {
            $map[$key] = $value
        }
    }

    return [pscustomobject]$map
}
