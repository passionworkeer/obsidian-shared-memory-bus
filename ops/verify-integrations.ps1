param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = ""
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

if ([string]::IsNullOrWhiteSpace($AiMemoryRoot)) {
    $AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Join-Path $env:USERPROFILE ".ai-memory" }
}

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

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Backup-IfExists {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "{0}.bak.{1}" -f $Path, $stamp
    Copy-Item -LiteralPath $Path -Destination $backupPath -Force
    return $backupPath
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$DefaultObject
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $DefaultObject
    }

    $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    if ([string]::IsNullOrWhiteSpace($content)) {
        return $DefaultObject
    }

    return ($content | ConvertFrom-Json)
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Object,
        [ref]$Report
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $backupPath = Backup-IfExists -Path $Path
    $json = $Object | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($Path, ($json.Trim() + "`n"), $Utf8NoBom)
    if ($backupPath) {
        $Report.Value.backups.Add($backupPath) | Out-Null
    }
    $Report.Value.updated.Add($Path) | Out-Null
}

function Write-TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content,
        [ref]$Report
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $backupPath = Backup-IfExists -Path $Path
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
    if ($backupPath) {
        $Report.Value.backups.Add($backupPath) | Out-Null
    }
    $Report.Value.updated.Add($Path) | Out-Null
}

function Ensure-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) {
        if ($property) {
            $property.Value = [pscustomobject]@{}
        } else {
            $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{})
        }
    }

    return $Object.PSObject.Properties[$Name].Value
}

function Set-ScalarProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Value
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        $property.Value = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Set-ManagedBlock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$StartMarker,
        [Parameter(Mandatory = $true)][string]$EndMarker,
        [Parameter(Mandatory = $true)][string]$Body,
        [ref]$Report
    )

    $block = ($StartMarker + "`r`n" + $Body.Trim() + "`r`n" + $EndMarker + "`r`n")
    $existing = ""
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    }

    if ($existing.Contains($StartMarker) -and $existing.Contains($EndMarker)) {
        $pattern = [regex]::Escape($StartMarker) + ".*?" + [regex]::Escape($EndMarker) + "\r?\n?"
        $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block }, [System.Text.RegularExpressions.RegexOptions]::Singleline)
        Write-TextFile -Path $Path -Content $updated -Report $Report
        return
    }

    $prefix = if ([string]::IsNullOrWhiteSpace($existing)) { "" } else { $existing.TrimEnd() + "`r`n`r`n" }
    Write-TextFile -Path $Path -Content ($prefix + $block) -Report $Report
}

$userHome = $env:USERPROFILE
$vaultRoot = Resolve-ObsidianVaultRoot -FallbackPath (Join-Path $userHome "Documents\Obsidian Vault")
$busRoot = Join-Path $vaultRoot "00-System\ai-memory"
$generatedRoot = Join-Path $busRoot "generated"
$startupRoot = Join-Path $generatedRoot "tool-startup"
$canonicalObsidian = Join-Path $vaultRoot "02-KB\OBSIDIAN.md"
$canonicalMemory = Join-Path $vaultRoot "02-KB\MEMORY.md"
$canonicalWorking = Join-Path $vaultRoot "02-KB\WORKING.md"
$globalContext = Join-Path $generatedRoot "GLOBAL-CONTEXT.md"
$sharedSkillsGuide = Join-Path $generatedRoot "SHARED-SKILLS.md"
$cursorStartup = Join-Path $startupRoot "cursor.md"
$copilotStartup = Join-Path $startupRoot "copilot.md"
$opencodeStartup = Join-Path $startupRoot "opencode.md"
$cursorInbox = Join-Path $busRoot "inbox\cursor.md"
$copilotInbox = Join-Path $busRoot "inbox\copilot.md"
$opencodeInbox = Join-Path $busRoot "inbox\opencode.md"
$globalPortableSkillsRoot = Join-Path $userHome ".agents\skills"
$sharedSkillsSyncScript = Join-Path $AiMemoryRoot "sync-shared-skills.ps1"

$safeSharedCursorServers = [ordered]@{
    context7 = [pscustomobject]@{ url = "http://127.0.0.1:9331/mcp" }
    "sequential-thinking" = [pscustomobject]@{ url = "http://127.0.0.1:9334/mcp" }
    obsidian = [pscustomobject]@{ url = "http://127.0.0.1:9335/mcp" }
}

$safeSharedVsCodeServers = [ordered]@{
    context7 = [pscustomobject]@{
        type = "http"
        url = "http://127.0.0.1:9331/mcp"
    }
    "sequential-thinking" = [pscustomobject]@{
        type = "http"
        url = "http://127.0.0.1:9334/mcp"
    }
    obsidian = [pscustomobject]@{
        type = "http"
        url = "http://127.0.0.1:9335/mcp"
    }
}

$safeSharedOpenCodeServers = [ordered]@{
    context7 = [pscustomobject]@{
        type = "remote"
        url = "http://127.0.0.1:9331/mcp"
        enabled = $true
    }
    "sequential-thinking" = [pscustomobject]@{
        type = "remote"
        url = "http://127.0.0.1:9334/mcp"
        enabled = $true
    }
    obsidian = [pscustomobject]@{
        type = "remote"
        url = "http://127.0.0.1:9335/mcp"
        enabled = $true
    }
}

$report = [pscustomobject]@{
    updated = New-Object System.Collections.Generic.List[string]
    backups = New-Object System.Collections.Generic.List[string]
    notes = New-Object System.Collections.Generic.List[string]
}

if (Test-Path -LiteralPath $sharedSkillsSyncScript -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sharedSkillsSyncScript -WorkspaceRoot $WorkspaceRoot -AiMemoryRoot $AiMemoryRoot | Out-Null
}

# Cursor user-level MCP
$cursorMcpPath = Join-Path $userHome ".cursor\mcp.json"
$cursorMcp = Read-JsonFile -Path $cursorMcpPath -DefaultObject ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
$cursorServers = Ensure-ObjectProperty -Object $cursorMcp -Name "mcpServers"
foreach ($entry in $safeSharedCursorServers.GetEnumerator()) {
    Set-ScalarProperty -Object $cursorServers -Name $entry.Key -Value $entry.Value
}
Write-JsonFile -Path $cursorMcpPath -Object $cursorMcp -Report ([ref]$report)

# VS Code / Copilot user-level MCP + instructions
$vsCodeMcpPath = Join-Path $env:APPDATA "Code\User\mcp.json"
$vsCodeMcp = Read-JsonFile -Path $vsCodeMcpPath -DefaultObject ([pscustomobject]@{ servers = [pscustomobject]@{}; inputs = @() })
$vsCodeServers = Ensure-ObjectProperty -Object $vsCodeMcp -Name "servers"
foreach ($entry in $safeSharedVsCodeServers.GetEnumerator()) {
    Set-ScalarProperty -Object $vsCodeServers -Name $entry.Key -Value $entry.Value
}
Write-JsonFile -Path $vsCodeMcpPath -Object $vsCodeMcp -Report ([ref]$report)

$vsCodeSettingsPath = Join-Path $env:APPDATA "Code\User\settings.json"
$vsCodeSettings = Read-JsonFile -Path $vsCodeSettingsPath -DefaultObject ([pscustomobject]@{})
Set-ScalarProperty -Object $vsCodeSettings -Name "chat.useAgentsMdFile" -Value $true
Set-ScalarProperty -Object $vsCodeSettings -Name "chat.useClaudeMdFile" -Value $true
Set-ScalarProperty -Object $vsCodeSettings -Name "chat.mcp.autoStart" -Value $true
$instructionLocations = Ensure-ObjectProperty -Object $vsCodeSettings -Name "chat.instructionsFilesLocations"
Set-ScalarProperty -Object $instructionLocations -Name ".github/instructions" -Value $true
Set-ScalarProperty -Object $instructionLocations -Name ".claude/rules" -Value $true
Set-ScalarProperty -Object $instructionLocations -Name "~/.copilot/instructions" -Value $true
Set-ScalarProperty -Object $instructionLocations -Name "~/.claude/rules" -Value $true
Write-JsonFile -Path $vsCodeSettingsPath -Object $vsCodeSettings -Report ([ref]$report)

$copilotInstructionsPath = Join-Path $userHome ".copilot\instructions\shared-memory.instructions.md"
$copilotInstructions = @"
---
name: Shared Memory Bus
description: Cross-workspace shared memory and decomposition defaults.
applyTo: "**"
---

Before substantive work, read:
1. $canonicalObsidian
2. $canonicalMemory
3. $canonicalWorking
4. $globalContext
5. $sharedSkillsGuide
6. $copilotStartup

Durable cross-project facts go to:
- $copilotInbox

Current active task progress goes to:
- $canonicalWorking

Defaults:
- Prefer shorter execution waves and subagents for 2 or more independent work slices.
- Reuse shared portable skills from $globalPortableSkillsRoot and repo `.agents/skills` when available.
- Reuse AGENTS.md, CLAUDE.md, .claude/rules, and .github/copilot-instructions.md when they exist.
- Never store secrets, raw tokens, or credentials in shared memory files.
"@
Write-TextFile -Path $copilotInstructionsPath -Content $copilotInstructions -Report ([ref]$report)

# OpenCode global config + instructions
$opencodeConfigPath = Join-Path $userHome ".config\opencode\opencode.json"
$opencodeConfig = Read-JsonFile -Path $opencodeConfigPath -DefaultObject ([pscustomobject]@{
    '$schema' = "https://opencode.ai/config.json"
    mcp = [pscustomobject]@{}
})
$opencodeMcp = Ensure-ObjectProperty -Object $opencodeConfig -Name "mcp"
foreach ($entry in $safeSharedOpenCodeServers.GetEnumerator()) {
    Set-ScalarProperty -Object $opencodeMcp -Name $entry.Key -Value $entry.Value
}
if ($opencodeMcp.PSObject.Properties["time"]) {
    $timeConfig = $opencodeMcp.PSObject.Properties["time"].Value
    if ($null -ne $timeConfig.PSObject.Properties["enabled"]) {
        $timeConfig.PSObject.Properties["enabled"].Value = $false
    }
}

$opencodeInstructionFile = Join-Path $userHome ".config\opencode\instructions\shared-memory.md"
$opencodeInstructionText = @"
# Shared Memory Bus

Read these before longer work:
1. $canonicalObsidian
2. $canonicalMemory
3. $canonicalWorking
4. $globalContext
5. $sharedSkillsGuide
6. $opencodeStartup

Write durable cross-project facts to:
- $opencodeInbox

Write current active task progress to:
- $canonicalWorking

Defaults:
- Prefer short-lived subagents or separate execution waves over one endlessly growing thread.
- Prefer shared portable skills from $globalPortableSkillsRoot and repo `.agents/skills` before tool-specific one-offs.
- Reuse repo instructions from AGENTS.md, .claude/rules, .cursor/rules, and .github/copilot-instructions.md when present.
- Never store secrets, raw tokens, or credentials in memory files.
"@
Write-TextFile -Path $opencodeInstructionFile -Content $opencodeInstructionText -Report ([ref]$report)

$opencodeAgentsPath = Join-Path $userHome ".config\opencode\AGENTS.md"
$opencodeAgentsBody = @"
## Shared Obsidian Memory Bus

- Canonical long-term memory lives in Obsidian, not only in local OpenCode session state.
- Before substantive work, read $canonicalObsidian, $canonicalMemory, $canonicalWorking, $globalContext, $sharedSkillsGuide, and $opencodeStartup.
- Durable writeback target: $opencodeInbox
- Current task tracking target: $canonicalWorking
- For tasks with 2 or more independent slices, prefer short-lived subagents or parallel decomposition instead of one long-running thread.
- Prefer shared portable skills from $globalPortableSkillsRoot and repo `.agents/skills` when available.
- Reuse repo instructions from AGENTS.md, .claude/rules, .cursor/rules, and .github/copilot-instructions.md when present.
- Never store secrets, raw tokens, or credentials in memory files.
"@
Set-ManagedBlock -Path $opencodeAgentsPath -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" -Body $opencodeAgentsBody -Report ([ref]$report)

$instructions = @()
if ($opencodeConfig.PSObject.Properties["instructions"]) {
    $instructions = @($opencodeConfig.instructions)
}
$wantedInstructions = @("./AGENTS.md", "./instructions/shared-memory.md")
foreach ($item in $wantedInstructions) {
    if ($instructions -notcontains $item) {
        $instructions += $item
    }
}
Set-ScalarProperty -Object $opencodeConfig -Name "instructions" -Value $instructions

if ($opencodeConfig.mcp.PSObject.Properties["time"]) {
    Set-ScalarProperty -Object $opencodeConfig.mcp.time -Name "enabled" -Value $false
}

Write-JsonFile -Path $opencodeConfigPath -Object $opencodeConfig -Report ([ref]$report)

# Workspace overlays
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    Ensure-Directory -Path $WorkspaceRoot

    $workspaceCursorRule = Join-Path $WorkspaceRoot ".cursor\rules\shared-memory.mdc"
    $workspaceCursorRuleText = @"
---
description: Shared Obsidian memory bootstrap
alwaysApply: true
---

Read these files before substantive work:
1. $canonicalObsidian
2. $canonicalMemory
3. $canonicalWorking
4. $globalContext
5. $sharedSkillsGuide
6. $cursorStartup

Write durable cross-project facts to:
- $cursorInbox

Write current active task progress to:
- $canonicalWorking

Defaults:
- Prefer multi-step decomposition over one very long session
- If subagents are available, use them for independent work slices
- Prefer shared portable skills from $globalPortableSkillsRoot and repo `.agents/skills` when they match the task
- Never store secrets, tokens, or credentials in memory files
"@
    Write-TextFile -Path $workspaceCursorRule -Content $workspaceCursorRuleText -Report ([ref]$report)

    $workspaceCursorMcpPath = Join-Path $WorkspaceRoot ".cursor\mcp.json"
    $workspaceCursorMcp = [pscustomobject]@{ mcpServers = [pscustomobject]@{} }
    foreach ($entry in $safeSharedCursorServers.GetEnumerator()) {
        Set-ScalarProperty -Object $workspaceCursorMcp.mcpServers -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $workspaceCursorMcpPath -Object $workspaceCursorMcp -Report ([ref]$report)

    $workspaceVsCodeMcpPath = Join-Path $WorkspaceRoot ".vscode\mcp.json"
    $workspaceVsCodeMcp = [pscustomobject]@{ servers = [pscustomobject]@{} }
    foreach ($entry in $safeSharedVsCodeServers.GetEnumerator()) {
        Set-ScalarProperty -Object $workspaceVsCodeMcp.servers -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $workspaceVsCodeMcpPath -Object $workspaceVsCodeMcp -Report ([ref]$report)

    $workspaceClaudeRulePath = Join-Path $WorkspaceRoot ".claude\rules\shared-memory.md"
    $workspaceClaudeRuleText = @"
---
description: Shared Obsidian memory overlay
paths:
  - "**"
---

Before longer work, read:
1. $canonicalObsidian
2. $canonicalMemory
3. $canonicalWorking
4. $globalContext
5. $sharedSkillsGuide

Use the active tool's startup file from:
- $startupRoot

Write durable cross-project facts into the active tool's inbox under:
- $busRoot\inbox

Write current active task progress to:
- $canonicalWorking

Defaults:
- Prefer shorter work waves and subagents for independent slices.
- Prefer shared portable skills from $globalPortableSkillsRoot and repo `.agents/skills` when available.
- Reuse AGENTS.md and .github/copilot-instructions.md when present.
- Never store secrets, raw tokens, or credentials in shared memory files.
"@
    Write-TextFile -Path $workspaceClaudeRulePath -Content $workspaceClaudeRuleText -Report ([ref]$report)

    $sharedAgentsBody = @"
## Shared Obsidian Memory Bus

- Follow CLAUDE.md for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode, Copilot, Cursor, and other compatible agents.
- Before substantive work, read $canonicalObsidian, $canonicalMemory, $canonicalWorking, $globalContext, $sharedSkillsGuide, and the matching startup file under $startupRoot.
- Durable writeback inboxes live under $busRoot\inbox and should be selected by active tool slug.
- Current task tracking target: $canonicalWorking
- For tasks with 2 or more independent slices, default to multi-agent or subagent decomposition.
- Use matching skills from $globalPortableSkillsRoot, .agents/skills, skills/, and personal skill folders when available.
"@
    Set-ManagedBlock -Path (Join-Path $WorkspaceRoot "AGENTS.md") -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" -Body $sharedAgentsBody -Report ([ref]$report)

    $sharedCopilotBody = @"
## Shared Obsidian Memory Bus

- Before long or multi-step work, consult AGENTS.md, $canonicalMemory, $canonicalWorking, $globalContext, and the matching startup file under $startupRoot.
- Shared portable skills are indexed in $sharedSkillsGuide and rooted at $globalPortableSkillsRoot.
- Durable cross-project facts belong in the active tool's inbox under $busRoot\inbox.
- Current-task progress belongs in $canonicalWorking.
- For tasks with 2 or more independent slices, prefer focused subagents or separate execution waves instead of one long-running context.
"@
    Set-ManagedBlock -Path (Join-Path $WorkspaceRoot ".github\copilot-instructions.md") -StartMarker "<!-- SHARED-MEMORY-BUS:START -->" -EndMarker "<!-- SHARED-MEMORY-BUS:END -->" -Body $sharedCopilotBody -Report ([ref]$report)

    $workspaceOpenCodeConfigPath = Join-Path $WorkspaceRoot "opencode.json"
    $workspaceOpenCodeConfig = [pscustomobject]@{
        '$schema' = "https://opencode.ai/config.json"
        instructions = @("AGENTS.md", ".claude/rules/*.md", ".cursor/rules/*.md", ".github/copilot-instructions.md")
        mcp = [pscustomobject]@{}
    }
    foreach ($entry in $safeSharedOpenCodeServers.GetEnumerator()) {
        Set-ScalarProperty -Object $workspaceOpenCodeConfig.mcp -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $workspaceOpenCodeConfigPath -Object $workspaceOpenCodeConfig -Report ([ref]$report)
}

$report.notes.Add("Safe shared MCP set applied: context7, sequential-thinking, obsidian.") | Out-Null
$report.notes.Add("Optional shared MCP kept out of default live integration: fetch, time, MiniMax, memory.") | Out-Null
$report.notes.Add("VS Code/Copilot user profile instructions now live from ~/.copilot/instructions.") | Out-Null
$report.notes.Add("OpenCode global config now points stable MCPs at shared HTTP URLs, keeps fetch local, and disables time.") | Out-Null
$report.notes.Add("Shared skills were synced into portable roots and indexed under generated/SHARED-SKILLS.md.") | Out-Null

$report | ConvertTo-Json -Depth 8
