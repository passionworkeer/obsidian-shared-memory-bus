param(
    [ValidateSet("Initialize", "SyncAll", "Generate", "RecordEvent", "ClaudeSessionStart", "ClaudeTurnSync", "Status", "RegisterAgent")]
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
$Script:BusRoot = Join-SharedPath @($Script:VaultRoot, "00-System", "ai-memory")
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
$Script:SharedSkillsSyncScript = Resolve-BusScriptPath -Candidates @("sync-shared-skills.ps1", "ops/sync-shared-skills.ps1")
$Script:ClaudeMemApiBase = "http://127.0.0.1:37778/api"
$Script:BusLockTimeoutMs = 180000
$Script:StaleSyncSeconds = 20
$Script:CacheRoot = Join-Path $Script:BusHome "cache"
$Script:RuntimeCache = @{}
$Script:ProfileSync = @("1", "true", "yes", "on") -contains ([string]$env:AI_MEMORY_PROFILE_SYNC).ToLowerInvariant()

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    try {
        return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
    } catch {
        return Get-Content -Raw -LiteralPath $Path
    }
}

function Normalize-Text {
    param([AllowEmptyString()][string]$Text)
    if ($null -eq $Text) {
        return ""
    }

    return (($Text -replace "`r", "") -replace "[`t ]+$", "").Trim()
}

function Write-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $tmpPath = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmpPath, $Content, $Utf8NoBom)
    Move-Item -LiteralPath $tmpPath -Destination $Path -Force
}

function Write-TextIfChanged {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content
    )

    $existing = Read-Text -Path $Path
    if ($existing -ceq $Content) {
        return $false
    }

    Write-Text -Path $Path -Content $Content
    return $true
}

function Append-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::AppendAllText($Path, $Content, $Utf8NoBom)
}

function Get-JsonFromUri {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 8
    } catch {
        return $null
    }
}

function Write-Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 12
    Write-Text -Path $Path -Content $json
}

function Get-OrAddRuntimeCache {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][scriptblock]$Factory
    )

    if ($Script:RuntimeCache.ContainsKey($Key)) {
        return $Script:RuntimeCache[$Key]
    }

    $value = & $Factory
    $Script:RuntimeCache[$Key] = $value
    return $value
}

function Get-FileStamp {
    param([AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return "__missing__"
    }

    $item = Get-Item -LiteralPath $Path
    return "{0}:{1}:{2}" -f $item.FullName, $item.LastWriteTimeUtc.Ticks, $item.Length
}

function Get-StringHash {
    param([AllowEmptyString()][string]$Text)

    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
        $hashBytes = $sha1.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha1.Dispose()
    }
}

function ConvertTo-AgentSlug {
    param([AllowEmptyString()][string]$Name)

    $candidate = [string]$Name
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return ""
    }

    $slug = $candidate.ToLowerInvariant()
    $slug = [System.Text.RegularExpressions.Regex]::Replace($slug, "[^a-z0-9]+", "-")
    $slug = $slug.Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) {
        throw "Agent name '$Name' could not be converted to a safe slug."
    }

    return $slug
}

function ConvertTo-AgentDisplayName {
    param(
        [AllowEmptyString()][string]$Name,
        [AllowEmptyString()][string]$FallbackSlug = ""
    )

    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        $trimmedName = $Name.Trim()
        if ($trimmedName -cmatch '^[a-z0-9-]+$') {
            $FallbackSlug = $trimmedName
        } else {
            return $trimmedName
        }
    }

    $slug = ConvertTo-AgentSlug -Name $FallbackSlug
    if ([string]::IsNullOrWhiteSpace($slug)) {
        return "External Agent"
    }

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($part in @($slug -split "-")) {
        if ([string]::IsNullOrWhiteSpace($part)) {
            continue
        }

        $parts.Add(($part.Substring(0, 1).ToUpperInvariant() + $part.Substring(1))) | Out-Null
    }

    if ($parts.Count -eq 0) {
        return "External Agent"
    }

    return [string]::Join(" ", $parts)
}

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
    $obsidianMcpScript = ((Resolve-BusScriptPath -Candidates @("run-obsidian-mcp.ps1", "ops/run-obsidian-mcp.ps1")) -replace "\\", "/")
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

    $mutex = New-Object System.Threading.Mutex($false, "Global\WangAiMemoryBusV1")
    try {
        $lockAcquired = $false
        try {
            $lockAcquired = $mutex.WaitOne($TimeoutMs)
        } catch [System.Threading.AbandonedMutexException] {
            $lockAcquired = $true
        }

        if (-not $lockAcquired) {
            throw "Timed out waiting for AI memory bus lock."
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

function Get-ShortSingleLine {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$MaxLength = 120
    )

    $normalized = Normalize-Text -Text $Text
    $singleLine = ($normalized -replace "`n", " ").Trim()
    if ([string]::IsNullOrWhiteSpace($singleLine)) {
        return "(empty)"
    }

    if ($singleLine.Length -le $MaxLength) {
        return $singleLine
    }

    return $singleLine.Substring(0, $MaxLength - 3) + "..."
}

function Get-ObjectPropertyValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-LocalTimestampString {
    param(
        [AllowNull()][object]$Value,
        [AllowNull()][object]$FallbackTime = $null
    )

    if ($null -ne $Value) {
        try {
            if ($Value -is [datetimeoffset]) {
                return $Value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
            }

            if ($Value -is [datetime]) {
                return ([datetimeoffset]$Value).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
            }

            return ([datetimeoffset]::Parse([string]$Value)).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
        } catch {
        }
    }

    if ($FallbackTime -is [datetimeoffset]) {
        return $FallbackTime.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
    }

    if ($FallbackTime -is [datetime]) {
        return $FallbackTime.ToString("yyyy-MM-dd HH:mm:ss")
    }

    return "unknown-time"
}

function Convert-UnixMillisecondsToLocalTimestampString {
    param(
        [AllowNull()][object]$Value,
        [AllowNull()][object]$FallbackTime = $null
    )

    if ($null -ne $Value -and -not [string]::IsNullOrWhiteSpace([string]$Value)) {
        try {
            return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$Value).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
        } catch {
        }
    }

    return Get-LocalTimestampString -Value $null -FallbackTime $FallbackTime
}

function Normalize-ComparablePath {
    param([AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    try {
        return [System.IO.Path]::GetFullPath($Path).TrimEnd("\").ToLowerInvariant()
    } catch {
        return (($Path -replace "/", "\").TrimEnd("\")).ToLowerInvariant()
    }
}

function Convert-FileUriToLocalPath {
    param([AllowEmptyString()][string]$UriValue)

    if ([string]::IsNullOrWhiteSpace($UriValue)) {
        return ""
    }

    $decoded = [System.Uri]::UnescapeDataString($UriValue)
    if ($decoded.StartsWith("file:///", [System.StringComparison]::OrdinalIgnoreCase)) {
        $path = $decoded.Substring(8)
        if ($path.StartsWith("/")) {
            $path = $path.Substring(1)
        }
        return (($path -replace "/", "\").Trim())
    }

    if ($decoded.StartsWith("file://", [System.StringComparison]::OrdinalIgnoreCase)) {
        return (($decoded.Substring(7) -replace "/", "\").Trim())
    }

    return (($decoded -replace "/", "\").Trim())
}

function Get-RelevantMessageText {
    param([AllowNull()][object[]]$ContentItems)

    $parts = New-Object System.Collections.Generic.List[object]
    foreach ($item in @($ContentItems)) {
        $text = Get-ObjectPropertyValue -Object $item -Name "text"
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        $normalized = Normalize-Text -Text ([string]$text)
        if ([string]::IsNullOrWhiteSpace($normalized)) {
            continue
        }

        if ($normalized -match '^(.*?)(?:\s+Based on this message, call .*)$') {
            $normalized = $matches[1].Trim()
        }

        if ($normalized -match '^# AGENTS\.md instructions\b') {
            continue
        }

        if ($normalized -match '^<environment_context>') {
            continue
        }

        if ($normalized -match '^Based on this message, call ') {
            continue
        }

        $parts.Add($normalized)
    }

    if ($parts.Count -eq 0) {
        return ""
    }

    return Get-ShortSingleLine -Text ([string]::Join(" ", $parts)) -MaxLength 140
}

function Invoke-OpenCodeDbJson {
    param([Parameter(Mandatory = $true)][string]$Query)

    if (-not (Test-Path -LiteralPath $Script:OpenCodeDbPath)) {
        return $null
    }

    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
        return $null
    }

    try {
        $output = & opencode db $Query --format json 2>$null
        if (-not $output) {
            return $null
        }

        return (($output -join "`n") | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-OpenCodeRecentSessionsSnapshot {
    $rows = Invoke-OpenCodeDbJson -Query "SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT 6;"
    if (-not $rows) {
        return "No OpenCode sessions found."
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($row in @($rows)) {
        $stamp = Convert-UnixMillisecondsToLocalTimestampString -Value $row.time_updated
        $title = if ($row.title) { Get-ShortSingleLine -Text $row.title -MaxLength 120 } else { "(untitled-session)" }
        $directory = if ($row.directory) { Get-ShortSingleLine -Text $row.directory -MaxLength 100 } else { "(unknown-directory)" }
        $items.Add("- [$stamp] $title ($directory)") | Out-Null
    }

    if ($items.Count -eq 0) {
        return "No OpenCode sessions found."
    }

    return ($items -join "`n")
}

function Get-OpenCodeCliInfo {
    return Get-OrAddRuntimeCache -Key "opencode-cli-info" -Factory {
        $cliCommand = Get-Command opencode -ErrorAction SilentlyContinue
        if ($null -eq $cliCommand) {
            return [pscustomobject]@{
                path = ""
                version = "(unavailable)"
                stamp = "__missing__"
            }
        }

        $cliPath = $cliCommand.Source
        $cliStamp = Get-FileStamp -Path $cliPath
        $cache = Get-CacheEntry -Name "opencode-cli-version"
        if ($cache -and $cache.path -eq $cliPath -and $cache.stamp -eq $cliStamp -and -not [string]::IsNullOrWhiteSpace([string]$cache.version)) {
            return [pscustomobject]@{
                path = $cliPath
                version = [string]$cache.version
                stamp = $cliStamp
            }
        }

        $version = "(unavailable)"
        try {
            $versionOutput = & $cliPath --version 2>$null
            if ($versionOutput) {
                $version = (($versionOutput -join "`n").Trim())
            }
        } catch {
        }

        Set-CacheEntry -Name "opencode-cli-version" -Value ([ordered]@{
            generatedAt = (Get-Date).ToString("o")
            path = $cliPath
            stamp = $cliStamp
            version = $version
        })

        return [pscustomobject]@{
            path = $cliPath
            version = $version
            stamp = $cliStamp
        }
    }
}

function Get-OpenCodeRecentTopicsSnapshot {
    $rows = Invoke-OpenCodeDbJson -Query "SELECT s.id AS session_id, s.title, m.time_created, json_extract(p.data, '$.text') AS text FROM session s JOIN message m ON m.session_id = s.id JOIN part p ON p.message_id = m.id WHERE json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' AND json_extract(p.data, '$.text') IS NOT NULL ORDER BY m.time_created DESC LIMIT 80;"
    if (-not $rows) {
        return "No OpenCode user topics found."
    }

    $topics = @{}
    foreach ($row in @($rows)) {
        $sessionId = [string]$row.session_id
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            continue
        }

        $candidate = Get-ShortSingleLine -Text ([string]$row.text) -MaxLength 140
        if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate -eq "(empty)") {
            continue
        }

        $isWeak = ($candidate.Length -le 4 -or $candidate -match "^(继续|继续继续|ok|好的|收到|嗯|测试)$")
        $entry = [pscustomobject]@{
            session_id = $sessionId
            time_created = [int64]$row.time_created
            text = $candidate
            weak = $isWeak
        }

        if (-not $topics.ContainsKey($sessionId)) {
            $topics[$sessionId] = $entry
            continue
        }

        if ($topics[$sessionId].weak -and -not $isWeak) {
            $topics[$sessionId] = $entry
        }
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($entry in @($topics.Values | Sort-Object time_created -Descending | Select-Object -First 6)) {
        $stamp = Convert-UnixMillisecondsToLocalTimestampString -Value $entry.time_created
        $items.Add("- [$stamp] $($entry.text)") | Out-Null
    }

    if ($items.Count -eq 0) {
        return "No OpenCode user topics found."
    }

    return ($items -join "`n")
}

function Get-OpenCodeStatsSnapshot {
    $cliInfo = Get-OpenCodeCliInfo
    if ([string]::IsNullOrWhiteSpace($cliInfo.path)) {
        return "OpenCode CLI not found."
    }

    $cache = Get-CacheEntry -Name "opencode-stats-30d"
    if ($cache -and $cache.generatedAt) {
        try {
            $generatedAt = [datetimeoffset]::Parse([string]$cache.generatedAt)
            if (((Get-Date).ToUniversalTime() - $generatedAt.UtcDateTime).TotalMinutes -lt 10) {
                return [string]$cache.value
            }
        } catch {
        }
    }

    try {
        $output = & $cliInfo.path stats --days 30 2>$null
        if (-not $output) {
            return "OpenCode stats unavailable."
        }

        $value = HeadTail-Lines -Text (($output -join "`n").Trim()) -HeadLines 50 -TailLinesCount 20
        Set-CacheEntry -Name "opencode-stats-30d" -Value ([ordered]@{
            generatedAt = (Get-Date).ToString("o")
            cliPath = $cliInfo.path
            cliStamp = $cliInfo.stamp
            dbStamp = Get-FileStamp -Path $Script:OpenCodeDbPath
            value = $value
        })
        return $value
    } catch {
        return "OpenCode stats unavailable: $($_.Exception.Message)"
    }
}

function Get-CopilotWorkspaceRecords {
    return Get-OrAddRuntimeCache -Key "copilot-workspace-records" -Factory {
        if (-not (Test-Path -LiteralPath $Script:CopilotWorkspaceStorageRoot)) {
            return @()
        }

        $records = New-Object System.Collections.Generic.List[object]
        foreach ($dir in @(Get-ChildItem -LiteralPath $Script:CopilotWorkspaceStorageRoot -Directory -ErrorAction SilentlyContinue)) {
            $workspaceJsonPath = Join-Path $dir.FullName "workspace.json"
            if (-not (Test-Path -LiteralPath $workspaceJsonPath)) {
                continue
            }

            try {
                $workspaceJson = Get-Content -Raw -LiteralPath $workspaceJsonPath -Encoding utf8 | ConvertFrom-Json
            } catch {
                continue
            }

            $workspacePath = ""
            foreach ($propertyName in @("folder", "workspace")) {
                $value = Get-ObjectPropertyValue -Object $workspaceJson -Name $propertyName
                if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
                    $workspacePath = Convert-FileUriToLocalPath -UriValue ([string]$value)
                    break
                }
            }

            $chatSessionsPath = Join-Path $dir.FullName "chatSessions"
            $chatFiles = @()
            if (Test-Path -LiteralPath $chatSessionsPath) {
                $chatFiles = @(
                    Get-ChildItem -LiteralPath $chatSessionsPath -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
                        Sort-Object LastWriteTime -Descending |
                        Select-Object -First 6
                )
            }

            $lastActivity = if ($chatFiles.Count -gt 0) {
                $chatFiles[0].LastWriteTime
            } else {
                (Get-Item -LiteralPath $workspaceJsonPath).LastWriteTime
            }

            $records.Add([pscustomobject]@{
                storagePath = $dir.FullName
                workspacePath = $workspacePath
                chatSessionsPath = $chatSessionsPath
                hasChatSessions = ($chatFiles.Count -gt 0)
                lastActivity = $lastActivity
            }) | Out-Null
        }

        return $records.ToArray()
    }
}

function Get-CopilotWorkspaceStoragePath {
    param([string]$ProjectDirectory)

    $records = @(
        Get-CopilotWorkspaceRecords |
            Where-Object { $_.hasChatSessions } |
            Sort-Object lastActivity -Descending
    )

    if ($records.Count -eq 0) {
        return $null
    }

    $normalizedProject = Normalize-ComparablePath -Path $ProjectDirectory
    if (-not [string]::IsNullOrWhiteSpace($normalizedProject)) {
        foreach ($record in $records) {
            $normalizedWorkspace = Normalize-ComparablePath -Path $record.workspacePath
            if ([string]::IsNullOrWhiteSpace($normalizedWorkspace)) {
                continue
            }

            if ($normalizedWorkspace -eq $normalizedProject) {
                return $record
            }

            if ($normalizedProject.StartsWith($normalizedWorkspace + "\", [System.StringComparison]::Ordinal)) {
                return $record
            }

            if ($normalizedWorkspace.StartsWith($normalizedProject + "\", [System.StringComparison]::Ordinal)) {
                return $record
            }
        }
    }

    return $records[0]
}

function Test-ProjectPathMatch {
    param(
        [AllowEmptyString()][string]$ProjectDirectory,
        [AllowEmptyString()][string[]]$CandidatePaths
    )

    $normalizedProject = Normalize-ComparablePath -Path $ProjectDirectory
    if ([string]::IsNullOrWhiteSpace($normalizedProject)) {
        return $true
    }

    foreach ($candidatePath in @($CandidatePaths)) {
        $normalizedCandidate = Normalize-ComparablePath -Path $candidatePath
        if ([string]::IsNullOrWhiteSpace($normalizedCandidate)) {
            continue
        }

        if ($normalizedCandidate -eq $normalizedProject) {
            return $true
        }

        if ($normalizedProject.StartsWith($normalizedCandidate + "\", [System.StringComparison]::Ordinal)) {
            return $true
        }

        if ($normalizedCandidate.StartsWith($normalizedProject + "\", [System.StringComparison]::Ordinal)) {
            return $true
        }
    }

    return $false
}

function Get-CopilotSessionSummaries {
    param([string]$ProjectDirectory)

    $vsCodeSnapshot = Get-CopilotVsCodeSessionSummaries -ProjectDirectory $ProjectDirectory
    $cliSummaries = Get-CopilotCliSessionSummaries -ProjectDirectory $ProjectDirectory
    $combined = @($vsCodeSnapshot.summaries) + @($cliSummaries)

    return [pscustomobject]@{
        workspace = $vsCodeSnapshot.workspace
        summaries = @($combined | Sort-Object lastRequestSortKey -Descending | Select-Object -First 8)
        cliSessionCount = @($cliSummaries).Count
    }
}

function Get-CopilotVsCodeSessionSummaries {
    param([string]$ProjectDirectory)

    $workspace = Get-CopilotWorkspaceStoragePath -ProjectDirectory $ProjectDirectory
    if ($null -eq $workspace -or -not (Test-Path -LiteralPath $workspace.chatSessionsPath)) {
        return [pscustomobject]@{
            workspace = $workspace
            summaries = @()
        }
    }

    $files = @(
        Get-ChildItem -LiteralPath $workspace.chatSessionsPath -File -Filter "*.jsonl" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 6
    )
    $sessionStamp = ($files | ForEach-Object { Get-FileStamp -Path $_.FullName }) -join "|"
    $workspaceStamp = Get-FileStamp -Path (Join-Path $workspace.storagePath "workspace.json")
    $cacheKey = "copilot-session-summaries::{0}::{1}::{2}" -f $workspace.storagePath, $workspaceStamp, $sessionStamp
    return Get-OrAddRuntimeCache -Key $cacheKey -Factory {
        $cacheName = "copilot-summaries-v2-" + (Get-StringHash -Text $workspace.storagePath)
        $cache = Get-CacheEntry -Name $cacheName
        if ($cache -and $cache.workspaceStamp -eq $workspaceStamp -and $cache.sessionStamp -eq $sessionStamp -and $cache.summaries) {
            return [pscustomobject]@{
                workspace = $workspace
                summaries = @($cache.summaries)
            }
        }

        $summaries = New-Object System.Collections.Generic.List[object]
        foreach ($file in $files) {
            $summaries.Add((Get-CopilotSessionSummary -Path $file.FullName)) | Out-Null
        }

        $value = [pscustomobject]@{
            workspace = $workspace
            summaries = $summaries.ToArray()
        }
        Set-CacheEntry -Name $cacheName -Value ([ordered]@{
            generatedAt = (Get-Date).ToString("o")
            workspacePath = $workspace.storagePath
            workspaceStamp = $workspaceStamp
            sessionStamp = $sessionStamp
            summaries = $value.summaries
        })
        return $value
    }
}

function Get-CopilotSessionSummaryCacheName {
    param([Parameter(Mandatory = $true)][string]$Path)

    return "copilot-session-summary-v1-" + (Get-StringHash -Text $Path)
}

function Get-CopilotCliSessionSummaries {
    param([string]$ProjectDirectory)

    $cacheKey = "copilot-cli-session-summaries::{0}" -f (Normalize-ComparablePath -Path $ProjectDirectory)
    return Get-OrAddRuntimeCache -Key $cacheKey -Factory {
        if (-not (Test-Path -LiteralPath $Script:CopilotCliSessionRoot)) {
            return @()
        }

        $items = New-Object System.Collections.Generic.List[object]
        foreach ($sessionDir in @(
            Get-ChildItem -LiteralPath $Script:CopilotCliSessionRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 12
        )) {
            $workspaceYamlPath = Join-Path $sessionDir.FullName "workspace.yaml"
            if (-not (Test-Path -LiteralPath $workspaceYamlPath)) {
                continue
            }

            $meta = Read-SimpleKeyValueFile -Path $workspaceYamlPath
            $candidatePaths = @([string]$meta.git_root, [string]$meta.cwd)
            if (-not (Test-ProjectPathMatch -ProjectDirectory $ProjectDirectory -CandidatePaths $candidatePaths)) {
                continue
            }

            $eventsPath = Join-Path $sessionDir.FullName "events.jsonl"
            $topic = if (-not [string]::IsNullOrWhiteSpace([string]$meta.summary)) {
                Get-ShortSingleLine -Text ([string]$meta.summary) -MaxLength 140
            } else {
                "(no request text found)"
            }
            $model = "unknown"
            $sortTimestamp = [DateTimeOffset]$sessionDir.LastWriteTime
            try {
                if (-not [string]::IsNullOrWhiteSpace([string]$meta.updated_at)) {
                    $sortTimestamp = [DateTimeOffset]::Parse([string]$meta.updated_at)
                }
            } catch {
            }

            if (Test-Path -LiteralPath $eventsPath) {
                foreach ($line in @(Get-Content -LiteralPath $eventsPath -Encoding utf8 -Tail 40 -ErrorAction SilentlyContinue)) {
                    if ([string]::IsNullOrWhiteSpace($line)) {
                        continue
                    }

                    try {
                        $row = $line | ConvertFrom-Json
                    } catch {
                        continue
                    }

                    if ($row.type -eq "session.model_change") {
                        $newModel = Get-ObjectPropertyValue -Object $row.data -Name "newModel"
                        if (-not [string]::IsNullOrWhiteSpace([string]$newModel)) {
                            $model = [string]$newModel
                        }
                        continue
                    }

                    if ($row.type -eq "user.message") {
                        $candidateText = [string](Get-ObjectPropertyValue -Object $row.data -Name "content")
                        if (-not [string]::IsNullOrWhiteSpace($candidateText)) {
                            $topic = Get-ShortSingleLine -Text $candidateText -MaxLength 140
                        }
                        try {
                            $sortTimestamp = [DateTimeOffset]::Parse([string]$row.timestamp)
                        } catch {
                        }
                    }
                }
            }

            $items.Add([pscustomobject]@{
                source = "cli"
                sessionId = if (-not [string]::IsNullOrWhiteSpace([string]$meta.id)) { [string]$meta.id } else { $sessionDir.Name }
                createdAt = Get-LocalTimestampString -Value ([string]$meta.created_at) -FallbackTime $sessionDir.CreationTime
                lastRequestAt = Get-LocalTimestampString -Value $sortTimestamp -FallbackTime $sessionDir.LastWriteTime
                lastRequestSortKey = $sortTimestamp.ToUnixTimeMilliseconds()
                mode = "cli"
                model = $model
                topic = $topic
            }) | Out-Null
        }

        return @($items | Sort-Object lastRequestSortKey -Descending | Select-Object -First 6)
    }
}

function Get-CopilotSessionSummary {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fileItem = Get-Item -LiteralPath $Path
    $tailReadThresholdBytes = 1MB
    $fileStamp = Get-FileStamp -Path $Path
    $cacheName = Get-CopilotSessionSummaryCacheName -Path $Path
    $cache = Get-CacheEntry -Name $cacheName
    if ($cache -and $cache.fileStamp -eq $fileStamp -and $cache.summary) {
        return [pscustomobject]$cache.summary
    }

    $summary = [ordered]@{
        sessionId = [System.IO.Path]::GetFileNameWithoutExtension($Path)
        createdAt = Get-LocalTimestampString -Value $fileItem.CreationTime
        lastRequestAt = Get-LocalTimestampString -Value $fileItem.LastWriteTime
        lastRequestSortKey = ([DateTimeOffset]$fileItem.LastWriteTime).ToUnixTimeMilliseconds()
        mode = "unknown"
        model = "unknown"
        topic = ""
        source = "vscode"
    }

    if ($fileItem.Length -gt $tailReadThresholdBytes) {
        $summary.topic = "(large Copilot session skipped for fast sync)"
        return [pscustomobject]$summary
    }

    $initialText = ""
    foreach ($line in @(Get-Content -LiteralPath $Path -Encoding utf8 -TotalCount 16 -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $row = $line | ConvertFrom-Json
        } catch {
            continue
        }

        if ((Get-ObjectPropertyValue -Object $row -Name "kind") -ne 0) {
            continue
        }

        $payload = Get-ObjectPropertyValue -Object $row -Name "v"
        $summary.sessionId = if ($payload.sessionId) { [string]$payload.sessionId } else { $summary.sessionId }
        $summary.createdAt = Convert-UnixMillisecondsToLocalTimestampString -Value (Get-ObjectPropertyValue -Object $payload -Name "creationDate") -FallbackTime $fileItem.CreationTime

        $inputState = Get-ObjectPropertyValue -Object $payload -Name "inputState"
        $modeObject = Get-ObjectPropertyValue -Object $inputState -Name "mode"
        $selectedModel = Get-ObjectPropertyValue -Object $inputState -Name "selectedModel"
        $modeCandidate = Get-ObjectPropertyValue -Object $modeObject -Name "id"
        $modelCandidate = Get-ObjectPropertyValue -Object $selectedModel -Name "identifier"
        if (-not [string]::IsNullOrWhiteSpace([string]$modeCandidate)) {
            $summary.mode = [string]$modeCandidate
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$modelCandidate)) {
            $summary.model = [string]$modelCandidate
        }

        $initialText = [string](Get-ObjectPropertyValue -Object $inputState -Name "inputText")
        break
    }

    if ($fileItem.Length -le $tailReadThresholdBytes) {
        foreach ($line in @(Get-Content -LiteralPath $Path -Encoding utf8 -Tail 240 -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            try {
                $row = $line | ConvertFrom-Json
            } catch {
                continue
            }

            if ((Get-ObjectPropertyValue -Object $row -Name "kind") -ne 2) {
                continue
            }

            $pathKeys = @((Get-ObjectPropertyValue -Object $row -Name "k"))
            if ($pathKeys.Count -eq 0 -or $pathKeys[0] -ne "requests") {
                continue
            }

            $requests = @()
            $rowValue = Get-ObjectPropertyValue -Object $row -Name "v"
            if ($rowValue -is [System.Array]) {
                $requests = @($rowValue)
            } elseif ($null -ne $rowValue) {
                $requests = @($rowValue)
            }

            foreach ($request in $requests) {
                $message = Get-ObjectPropertyValue -Object $request -Name "message"
                $candidateText = [string](Get-ObjectPropertyValue -Object $message -Name "text")
                if ([string]::IsNullOrWhiteSpace($candidateText)) {
                    $parts = @((Get-ObjectPropertyValue -Object $message -Name "parts"))
                    foreach ($part in $parts) {
                        $partText = [string](Get-ObjectPropertyValue -Object $part -Name "text")
                        if (-not [string]::IsNullOrWhiteSpace($partText)) {
                            $candidateText = $partText
                            break
                        }
                    }
                }

                if (-not [string]::IsNullOrWhiteSpace($candidateText)) {
                    $summary.topic = Get-ShortSingleLine -Text $candidateText -MaxLength 140
                    $summary.lastRequestAt = Convert-UnixMillisecondsToLocalTimestampString -Value (Get-ObjectPropertyValue -Object $request -Name "timestamp") -FallbackTime $fileItem.LastWriteTime
                    try {
                        $summary.lastRequestSortKey = [DateTimeOffset]::FromUnixTimeMilliseconds([int64](Get-ObjectPropertyValue -Object $request -Name "timestamp")).ToUnixTimeMilliseconds()
                    } catch {
                    }
                }

                $modeInfo = Get-ObjectPropertyValue -Object $request -Name "modeInfo"
                $modeCandidate = Get-ObjectPropertyValue -Object $modeInfo -Name "modeId"
                $modelCandidate = Get-ObjectPropertyValue -Object $request -Name "modelId"
                if (-not [string]::IsNullOrWhiteSpace([string]$modeCandidate)) {
                    $summary.mode = [string]$modeCandidate
                }
                if (-not [string]::IsNullOrWhiteSpace([string]$modelCandidate)) {
                    $summary.model = [string]$modelCandidate
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($summary.topic) -and -not [string]::IsNullOrWhiteSpace($initialText)) {
        $summary.topic = Get-ShortSingleLine -Text $initialText -MaxLength 140
    }

    if ([string]::IsNullOrWhiteSpace($summary.topic)) {
        $summary.topic = "(no request text found)"
    }

    $result = [pscustomobject]$summary
    Set-CacheEntry -Name $cacheName -Value ([ordered]@{
        generatedAt = (Get-Date).ToString("o")
        fileStamp = $fileStamp
        summary = $result
    })
    return $result
}

function Get-CopilotRecentSessionsSnapshot {
    param([string]$ProjectDirectory)

    $snapshot = Get-CopilotSessionSummaries -ProjectDirectory $ProjectDirectory
    if ($null -eq $snapshot.workspace -or @($snapshot.summaries).Count -eq 0) {
        return "No GitHub Copilot chatSessions directory detected."
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($summary in @($snapshot.summaries)) {
        $items.Add("- [$($summary.lastRequestAt)] [$($summary.source)] $($summary.sessionId) [mode=$($summary.mode); model=$($summary.model)]") | Out-Null
    }

    if ($items.Count -eq 0) {
        return "No GitHub Copilot chat sessions found."
    }

    return ($items -join "`n")
}

function Get-CopilotRecentTopicsSnapshot {
    param([string]$ProjectDirectory)

    $snapshot = Get-CopilotSessionSummaries -ProjectDirectory $ProjectDirectory
    if ($null -eq $snapshot.workspace -or @($snapshot.summaries).Count -eq 0) {
        return "No GitHub Copilot chatSessions directory detected."
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($summary in @($snapshot.summaries)) {
        $items.Add("- [$($summary.lastRequestAt)] [$($summary.source)] $($summary.topic)") | Out-Null
    }

    if ($items.Count -eq 0) {
        return "No GitHub Copilot chat sessions found."
    }

    return ($items -join "`n")
}

function Get-CopilotGlobalStorageSnapshot {
    if (-not (Test-Path -LiteralPath $Script:CopilotGlobalStorage)) {
        return "GitHub Copilot global storage not found."
    }

    return Get-RecentFilesSummary -Path $Script:CopilotGlobalStorage -MaxFiles 6 -Recurse
}

function Get-CodexRecentThreadsSnapshot {
    param([Parameter(Mandatory = $true)][string]$SessionIndexPath)

    if (-not (Test-Path -LiteralPath $SessionIndexPath)) {
        return "session_index.jsonl not found"
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($line in @(Get-Content -LiteralPath $SessionIndexPath -Encoding utf8 -Tail 8 -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $row = $line | ConvertFrom-Json
        } catch {
            continue
        }

        $stamp = if ($row.updated_at) {
            try {
                ([datetimeoffset]::Parse($row.updated_at)).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
            } catch {
                $row.updated_at
            }
        } else {
            "unknown-time"
        }

        $title = if ($row.thread_name) { Get-ShortSingleLine -Text $row.thread_name -MaxLength 120 } else { "(untitled-thread)" }
        $items.Add("- [$stamp] $title")
    }

    if ($items.Count -eq 0) {
        return "No recent threads found."
    }

    return ($items -join "`n")
}

function Get-CodexRecentTopicsSnapshot {
    param([Parameter(Mandatory = $true)][string]$SessionsDir)

    if (-not (Test-Path -LiteralPath $SessionsDir)) {
        return "sessions directory not found"
    }

    $rollouts = @(
        Get-ChildItem -LiteralPath $SessionsDir -Filter "rollout-*.jsonl" -File -Recurse |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 10
    )

    if ($rollouts.Count -eq 0) {
        return "No rollout files found."
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($file in $rollouts) {
        $topic = ""
        $stamp = Get-LocalTimestampString -Value $file.LastWriteTime

        foreach ($line in @(Get-Content -LiteralPath $file.FullName -Encoding utf8 -TotalCount 160 -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            try {
                $row = $line | ConvertFrom-Json
            } catch {
                continue
            }

            if ((Get-ObjectPropertyValue -Object $row -Name "type") -ne "response_item") {
                continue
            }

            $payload = Get-ObjectPropertyValue -Object $row -Name "payload"
            if ((Get-ObjectPropertyValue -Object $payload -Name "type") -ne "message") {
                continue
            }

            if ((Get-ObjectPropertyValue -Object $payload -Name "role") -ne "user") {
                continue
            }

            $candidate = Get-RelevantMessageText -ContentItems (Get-ObjectPropertyValue -Object $payload -Name "content")
            if ([string]::IsNullOrWhiteSpace($candidate)) {
                continue
            }

            $topic = $candidate
            $stamp = Get-LocalTimestampString -Value (Get-ObjectPropertyValue -Object $row -Name "timestamp") -FallbackTime $file.LastWriteTime
            break
        }

        if ([string]::IsNullOrWhiteSpace($topic)) {
            $topic = "(no user topic found in $($file.Name))"
        }

        $items.Add("- [$stamp] $topic")
    }

    return ($items -join "`n")
}

function Get-CodexRecentPromptsSnapshot {
    param([Parameter(Mandatory = $true)][string]$HistoryPath)

    if (-not (Test-Path -LiteralPath $HistoryPath)) {
        return "history.jsonl not found"
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($line in @(Get-Content -LiteralPath $HistoryPath -Encoding utf8 -Tail 8 -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $row = $line | ConvertFrom-Json
        } catch {
            continue
        }

        $stamp = if ($row.ts) {
            try {
                ([DateTimeOffset]::FromUnixTimeSeconds([int64]$row.ts)).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
            } catch {
                "unknown-time"
            }
        } else {
            "unknown-time"
        }

        $prompt = if ($row.text) { Get-ShortSingleLine -Text $row.text -MaxLength 120 } else { "(empty-prompt)" }
        $items.Add("- [$stamp] $prompt")
    }

    if ($items.Count -eq 0) {
        return "No recent prompts found."
    }

    return ($items -join "`n")
}

function Get-OpenClawRecentTopicsSnapshot {
    param([Parameter(Mandatory = $true)][string]$SessionDir)

    if (-not (Test-Path -LiteralPath $SessionDir)) {
        return "session directory not found"
    }

    $sessionFiles = @(
        Get-ChildItem -LiteralPath $SessionDir -Filter "*.jsonl" -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 6
    )

    if ($sessionFiles.Count -eq 0) {
        return "No session files found."
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($file in $sessionFiles) {
        $topic = ""
        $stamp = Get-LocalTimestampString -Value $file.LastWriteTime

        foreach ($line in @(Get-Content -LiteralPath $file.FullName -Encoding utf8 -TotalCount 160 -ErrorAction SilentlyContinue)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            try {
                $row = $line | ConvertFrom-Json
            } catch {
                continue
            }

            if ((Get-ObjectPropertyValue -Object $row -Name "type") -ne "message") {
                continue
            }

            $message = Get-ObjectPropertyValue -Object $row -Name "message"
            if ((Get-ObjectPropertyValue -Object $message -Name "role") -ne "user") {
                continue
            }

            $candidate = Get-RelevantMessageText -ContentItems (Get-ObjectPropertyValue -Object $message -Name "content")
            if ([string]::IsNullOrWhiteSpace($candidate)) {
                continue
            }

            $topic = $candidate
            $stamp = Get-LocalTimestampString -Value (Get-ObjectPropertyValue -Object $row -Name "timestamp") -FallbackTime $file.LastWriteTime
            break
        }

        if ([string]::IsNullOrWhiteSpace($topic)) {
            $topic = "(no user topic found in $($file.Name))"
        }

        $items.Add("- [$stamp] $topic")
    }

    return ($items -join "`n")
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

function Get-ClaudeMemSnapshot {
    $health = Get-JsonFromUri -Uri ($Script:ClaudeMemApiBase + "/health")
    $stats = Get-JsonFromUri -Uri ($Script:ClaudeMemApiBase + "/stats")
    $observations = Get-JsonFromUri -Uri ($Script:ClaudeMemApiBase + "/observations?limit=5")

    $healthText = "(unavailable)"
    if ($health) {
        $healthText = @"
- Status: $(if ($health.status) { $health.status } else { "unknown" })
- Version: $(if ($health.version) { $health.version } else { "unknown" })
- Initialized: $(if ($health.initialized -ne $null) { $health.initialized } else { "unknown" })
- MCP ready: $(if ($health.mcpReady -ne $null) { $health.mcpReady } else { "unknown" })
"@.Trim()
    }

    $statsText = "(unavailable)"
    if ($stats) {
        $statsText = @"
- Worker port: $(if ($stats.worker.port -ne $null) { $stats.worker.port } else { "unknown" })
- Database path: $(if ($stats.database.path) { $stats.database.path } else { "unknown" })
- Database size: $(if ($stats.database.size -ne $null) { $stats.database.size } else { "unknown" }) bytes
- Observations: $(if ($stats.database.observations -ne $null) { $stats.database.observations } else { "unknown" })
- Sessions: $(if ($stats.database.sessions -ne $null) { $stats.database.sessions } else { "unknown" })
- Summaries: $(if ($stats.database.summaries -ne $null) { $stats.database.summaries } else { "unknown" })
"@.Trim()
    }

    $observationText = "(unavailable)"
    if ($observations -and $observations.items) {
        $entries = @()
        foreach ($item in @($observations.items)) {
            $created = if ($item.created_at) { $item.created_at } else { "unknown-time" }
            $project = if ($item.project) { $item.project } else { "unknown-project" }
            $type = if ($item.type) { $item.type } else { "note" }
            $title = if ($item.title) { $item.title } else { "(untitled)" }
            $entries += "- [$created] [$project] [$type] $title"
        }

        if ($entries.Count -gt 0) {
            $observationText = $entries -join "`n"
        }
    }

    return [ordered]@{
        health = $healthText
        stats = $statsText
        observations = $observationText
    }
}

function Convert-TraeResourceToDisplay {
    param([AllowEmptyString()][string]$Resource)

    if ([string]::IsNullOrWhiteSpace($Resource)) {
        return "(unknown-resource)"
    }

    $decoded = [System.Uri]::UnescapeDataString($Resource)
    if ($decoded.StartsWith("file:///", [System.StringComparison]::OrdinalIgnoreCase)) {
        $path = $decoded.Substring(8)
        if ($path.Length -ge 2 -and $path[1] -eq ":") {
            return ($path.Substring(0, 1).ToUpperInvariant() + $path.Substring(1)) -replace "/", "\"
        }
        return $path -replace "/", "\"
    }

    if ($decoded.StartsWith("vscode-userdata:/", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $decoded.Replace("vscode-userdata:/", "")
    }

    return $decoded
}

function Get-TraeHistorySnapshot {
    $roots = @(
        @{ label = "Trae"; path = Join-SharedPath @((Get-SharedTraeUserRoot -ProductName "Trae"), "History") },
        @{ label = "Trae CN"; path = Join-SharedPath @((Get-SharedTraeUserRoot -ProductName "Trae CN"), "History") }
    )

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root.path)) {
            continue
        }

        foreach ($dir in @(Get-ChildItem -LiteralPath $root.path -Directory -ErrorAction SilentlyContinue)) {
            $entryPath = Join-Path $dir.FullName "entries.json"
            if (-not (Test-Path -LiteralPath $entryPath)) {
                continue
            }

            try {
                $entryJson = Get-Content -Raw -LiteralPath $entryPath -Encoding utf8 | ConvertFrom-Json
            } catch {
                continue
            }

            if (-not $entryJson.entries) {
                continue
            }

            $timestamps = @($entryJson.entries | ForEach-Object { [int64]$_.timestamp })
            if ($timestamps.Count -eq 0) {
                continue
            }

            $lastTimestamp = ($timestamps | Measure-Object -Maximum).Maximum
            $records.Add([pscustomobject]@{
                source = $root.label
                resource = Convert-TraeResourceToDisplay -Resource $entryJson.resource
                revisions = @($entryJson.entries).Count
                lastTimestamp = [int64]$lastTimestamp
            })
        }
    }

    if ($records.Count -eq 0) {
        return "(no local Trae history found)"
    }

    $lines = @()
    foreach ($record in @($records | Sort-Object lastTimestamp -Descending | Select-Object -First 6)) {
        $stamp = [DateTimeOffset]::FromUnixTimeMilliseconds($record.lastTimestamp).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
        $lines += "- [$($record.source)] [$stamp] $($record.resource) ($($record.revisions) revisions)"
    }

    return $lines -join "`n"
}

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
            $prefix = $normalizedExisting.Substring(0, $startIndex).Trim()
            $suffix = $normalizedExisting.Substring($endIndex).Trim()
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
    $memoryLayersText = Read-Text -Path $Script:MemoryLayersGuidePath
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
$(if ([string]::IsNullOrWhiteSpace($memoryLayersText)) { "(memory layers summary not generated yet)" } else { Clip-Lines -Text $memoryLayersText -MaxLines 80 })

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
