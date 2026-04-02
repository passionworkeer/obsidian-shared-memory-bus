param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = "",
    [string[]]$Clients = @(),
    [switch]$IncludeOptionalServers,
    [switch]$SkipPlaywright,
    [string]$ReportPath = "",
    [switch]$SkipGenerate,
    [switch]$SkipSkillSync,
    [switch]$SkipWorkspaceOverlays,
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
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

if ([string]::IsNullOrWhiteSpace($AiMemoryRoot)) {
    $AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Get-SharedDefaultAiMemoryRoot }
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Normalize-ReportPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        return (Get-Item -LiteralPath $Path -Force).FullName
    } catch {
        return [System.IO.Path]::GetFullPath($Path)
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
    $json = ($Object | ConvertTo-Json -Depth 32).Trim() + "`n"
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $Path -Encoding utf8
        if ($existing -eq $json) {
            $Report.Value.unchanged.Add($Path) | Out-Null
            return
        }
    }

    $backupPath = Backup-IfExists -Path $Path
    [System.IO.File]::WriteAllText($Path, $json, $Utf8NoBom)
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
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $Path -Encoding utf8
        if ($existing -eq $Content) {
            $Report.Value.unchanged.Add($Path) | Out-Null
            return
        }
    }

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

function Resolve-BundleAssetPath {
    param([Parameter(Mandatory = $true)][string[]]$Candidates)

    foreach ($root in @($AiMemoryRoot, $sourceRoot)) {
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

    throw ("Unable to locate required asset. Tried: {0}" -f ([string]::Join(", ", $Candidates)))
}

function Get-SharedMcpManifest {
    $manifestPath = Resolve-BundleAssetPath -Candidates @(
        (Join-Path "shared-mcp" "manifest.json"),
        "manifest.json"
    )
    return (Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json)
}

function Get-SharedMcpUrl {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Server
    )

    return ("http://{0}:{1}{2}" -f [string]$Manifest.defaults.host, [int]$Server.port, [string]$Manifest.defaults.path)
}

function Get-SelectedSharedMcpServers {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [switch]$IncludeOptional,
        [switch]$SkipPlaywrightServer
    )

    $servers = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($server in @($Manifest.servers)) {
        $serverId = [string]$server.id
        $serverMode = [string]$server.mode

        $include = $false
        if ($serverMode -eq "shared") {
            $include = $true
        } elseif ($serverId -eq "playwright") {
            $include = -not $SkipPlaywrightServer
        } elseif ($serverId -eq "MiniMax") {
            $include = $IncludeOptional
        }

        if ($include -and -not $seen.ContainsKey($serverId)) {
            $servers.Add($server) | Out-Null
            $seen[$serverId] = $true
        }
    }

    return @($servers.ToArray())
}

function New-CursorServerMap {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers
    )

    $payload = [ordered]@{}
    foreach ($server in @($Servers)) {
        $payload[[string]$server.id] = [pscustomobject]@{
            url = (Get-SharedMcpUrl -Manifest $Manifest -Server $server)
        }
    }
    return $payload
}

function New-VsCodeServerMap {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers
    )

    $payload = [ordered]@{}
    foreach ($server in @($Servers)) {
        $payload[[string]$server.id] = [pscustomobject]@{
            type = "http"
            url = (Get-SharedMcpUrl -Manifest $Manifest -Server $server)
        }
    }
    return $payload
}

function New-OpenCodeServerMap {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers
    )

    $payload = [ordered]@{}
    foreach ($server in @($Servers)) {
        $payload[[string]$server.id] = [pscustomobject]@{
            type = "remote"
            url = (Get-SharedMcpUrl -Manifest $Manifest -Server $server)
            enabled = $true
        }
    }
    return $payload
}

function New-ClaudeServerMap {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers
    )

    $payload = [ordered]@{}
    foreach ($server in @($Servers)) {
        $payload[[string]$server.id] = [pscustomobject]@{
            type = "http"
            url = (Get-SharedMcpUrl -Manifest $Manifest -Server $server)
        }
    }
    return $payload
}

function Remove-MarkedCodexBlock {
    param([Parameter(Mandatory = $true)][string]$Text)

    $pattern = '(?ms)^\# SHARED-MEMORY-BUS:START\r?\n.*?^\# SHARED-MEMORY-BUS:END\r?\n?'
    return ([regex]::Replace($Text, $pattern, ""))
}

function Remove-CodexManagedServerTables {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string[]]$ServerIds
    )

    if (@($ServerIds).Count -eq 0) {
        return $Text
    }

    $tablePattern = '(?m)^\[mcp_servers\.(?:' + (($ServerIds | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')\]\s*\r?\n(?:^(?!\[).*(?:\r?\n|$))*'
    return ([regex]::Replace($Text, $tablePattern, ""))
}

function Build-CodexManagedBlock {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# SHARED-MEMORY-BUS:START") | Out-Null
    $lines.Add("# Managed shared MCP endpoints. Re-run install-client-integrations.ps1 to refresh.") | Out-Null
    foreach ($server in @($Servers)) {
        $lines.Add("") | Out-Null
        $lines.Add(("[mcp_servers.{0}]" -f [string]$server.id)) | Out-Null
        $lines.Add(('url = "{0}"' -f (Get-SharedMcpUrl -Manifest $Manifest -Server $server))) | Out-Null
        $lines.Add("startup_timeout_sec = 60") | Out-Null
    }
    $lines.Add("") | Out-Null
    $lines.Add("# SHARED-MEMORY-BUS:END") | Out-Null
    return (($lines -join "`n").Trim() + "`n")
}

function Update-CodexConfigToml {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][object[]]$Servers,
        [ref]$Report
    )

    $existing = ""
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    }

    $managedIds = @($Servers | ForEach-Object { [string]$_.id })
    $updated = Remove-CodexManagedServerTables -Text (Remove-MarkedCodexBlock -Text $existing) -ServerIds $managedIds
    $updated = $updated.TrimEnd()
    $block = Build-CodexManagedBlock -Manifest $Manifest -Servers $Servers
    $content = if ([string]::IsNullOrWhiteSpace($updated)) { $block } else { $updated + "`n`n" + $block }
    Write-TextFile -Path $Path -Content $content -Report $Report
}

function Normalize-ClientName {
    param([Parameter(Mandatory = $true)][string]$Name)

    switch ($Name.Trim().ToLowerInvariant()) {
        "claude-code" { return "claude" }
        "claude" { return "claude" }
        "codex" { return "codex" }
        "cursor" { return "cursor" }
        "vscode" { return "vscode" }
        "vs-code" { return "vscode" }
        "copilot" { return "copilot" }
        "github-copilot" { return "copilot" }
        "opencode" { return "opencode" }
        "open-code" { return "opencode" }
        "trae" { return "trae" }
        "openclaw" { return "openclaw" }
        default { return $Name.Trim().ToLowerInvariant() }
    }
}

function Test-ClientSelected {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (@($Clients).Count -eq 0) {
        return $true
    }

    $normalized = Normalize-ClientName -Name $Name
    foreach ($client in @($Clients)) {
        if ((Normalize-ClientName -Name $client) -eq $normalized) {
            return $true
        }
    }

    return $false
}

function Invoke-ManagedBusScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptName,
        [string[]]$ArgumentList = @()
    )

    $scriptPath = Resolve-BundleAssetPath -Candidates @(
        $ScriptName,
        (Join-Path "ops" $ScriptName),
        (Join-Path "bus" $ScriptName)
    )
    return (Invoke-SharedPowerShellFile -ScriptPath $scriptPath -ArgumentList $ArgumentList)
}

$userHome = Get-SharedUserHome
$vaultRoot = Resolve-SharedObsidianVaultRoot -FallbackPath (Join-SharedPath @($userHome, "Documents", "Obsidian Vault"))
$busRoot = Join-SharedPath @($vaultRoot, "00-System", "ai-memory")
$generatedRoot = Join-Path $busRoot "generated"
$startupRoot = Join-Path $generatedRoot "tool-startup"
$canonicalObsidian = Join-SharedPath @($vaultRoot, "02-KB", "OBSIDIAN.md")
$canonicalMemory = Join-SharedPath @($vaultRoot, "02-KB", "MEMORY.md")
$canonicalWorking = Join-SharedPath @($vaultRoot, "02-KB", "WORKING.md")
$globalContext = Join-Path $generatedRoot "GLOBAL-CONTEXT.md"
$sharedSkillsGuide = Join-Path $generatedRoot "SHARED-SKILLS.md"
$cursorStartup = Join-Path $startupRoot "cursor.md"
$copilotStartup = Join-Path $startupRoot "copilot.md"
$opencodeStartup = Join-Path $startupRoot "opencode.md"
$cursorInbox = Join-SharedPath @($busRoot, "inbox", "cursor.md")
$copilotInbox = Join-SharedPath @($busRoot, "inbox", "copilot.md")
$opencodeInbox = Join-SharedPath @($busRoot, "inbox", "opencode.md")
$globalPortableSkillsRoot = Join-SharedPath @($userHome, ".agents", "skills")
$vsCodeUserRoot = Get-SharedVsCodeUserRoot -ProductName "Code"
$copilotHomeRoot = Get-SharedCopilotHomeRoot
$opencodeConfigRoot = Get-SharedOpenCodeConfigRoot
$claudeHomeRoot = Join-SharedPath @($userHome, ".claude")
$codexRoot = Join-SharedPath @($userHome, ".codex")
$traeUserRoot = Get-SharedTraeUserRoot -ProductName "Trae"
$reportRoot = Join-Path $AiMemoryRoot "reports"
Ensure-Directory -Path $reportRoot

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $reportRoot "install-client-integrations.last.json"
} else {
    $ReportPath = Normalize-ReportPath -Path $ReportPath
}

$manifest = Get-SharedMcpManifest
$servers = @(Get-SelectedSharedMcpServers -Manifest $manifest -IncludeOptional:$IncludeOptionalServers -SkipPlaywrightServer:$SkipPlaywright)
if ($servers.Count -eq 0) {
    throw "No shared MCP servers were selected for client integration."
}

$cursorServerMap = New-CursorServerMap -Manifest $manifest -Servers $servers
$vsCodeServerMap = New-VsCodeServerMap -Manifest $manifest -Servers $servers
$openCodeServerMap = New-OpenCodeServerMap -Manifest $manifest -Servers $servers
$claudeServerMap = New-ClaudeServerMap -Manifest $manifest -Servers $servers

$report = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("s")
    aiMemoryRoot = $AiMemoryRoot
    workspaceRoot = $WorkspaceRoot
    reportPath = $ReportPath
    clients = if (@($Clients).Count -eq 0) { @("codex", "claude", "cursor", "vscode", "copilot", "opencode", "trae", "openclaw") } else { @($Clients | ForEach-Object { Normalize-ClientName -Name $_ } | Sort-Object -Unique) }
    serversApplied = @($servers | ForEach-Object { [string]$_.id })
    includeOptionalServers = [bool]$IncludeOptionalServers
    includePlaywright = (-not [bool]$SkipPlaywright)
    generatedPackRoot = (Join-Path $generatedRoot "onboarding")
    updated = New-Object System.Collections.Generic.List[string]
    unchanged = New-Object System.Collections.Generic.List[string]
    backups = New-Object System.Collections.Generic.List[string]
    warnings = New-Object System.Collections.Generic.List[string]
    skippedTargets = New-Object System.Collections.Generic.List[string]
    notes = New-Object System.Collections.Generic.List[string]
}

if (-not $SkipGenerate) {
    try {
        if (Test-ClientSelected -Name "cursor") {
            Invoke-ManagedBusScript -ScriptName "register-agent.ps1" -ArgumentList @("-AgentName", "cursor", "-Preset", "cursor") | Out-Null
            $report.notes.Add("Registered or refreshed the Cursor onboarding pack before generation.") | Out-Null
        }

        $generateArgs = @("-Action", "Generate")
        if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
            $generateArgs += @("-Project", $WorkspaceRoot)
        }
        Invoke-ManagedBusScript -ScriptName "memory-bus.ps1" -ArgumentList $generateArgs | Out-Null
        $report.notes.Add("Regenerated startup files, onboarding packs, and managed text overlays from memory-bus.ps1.") | Out-Null
    } catch {
        throw ("Failed to regenerate shared-memory artifacts before applying client integrations: {0}" -f $_.Exception.Message)
    }
} elseif (-not $SkipSkillSync) {
    try {
        $syncArgs = @("-AiMemoryRoot", $AiMemoryRoot)
        if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
            $syncArgs += @("-WorkspaceRoot", $WorkspaceRoot)
        }
        Invoke-ManagedBusScript -ScriptName "sync-shared-skills.ps1" -ArgumentList $syncArgs | Out-Null
        $report.notes.Add("Refreshed the shared skills catalog because generation was skipped.") | Out-Null
    } catch {
        $report.warnings.Add(("Shared skills sync skipped after failure: {0}" -f $_.Exception.Message)) | Out-Null
    }
}

if (Test-ClientSelected -Name "cursor") {
    $cursorMcpPath = Join-SharedPath @($userHome, ".cursor", "mcp.json")
    $cursorMcp = Read-JsonFile -Path $cursorMcpPath -DefaultObject ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
    $cursorServers = Ensure-ObjectProperty -Object $cursorMcp -Name "mcpServers"
    foreach ($entry in $cursorServerMap.GetEnumerator()) {
        Set-ScalarProperty -Object $cursorServers -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $cursorMcpPath -Object $cursorMcp -Report ([ref]$report)
}

if ((Test-ClientSelected -Name "vscode") -or (Test-ClientSelected -Name "copilot")) {
    $vsCodeMcpPath = Join-SharedPath @($vsCodeUserRoot, "mcp.json")
    $vsCodeMcp = Read-JsonFile -Path $vsCodeMcpPath -DefaultObject ([pscustomobject]@{ servers = [pscustomobject]@{}; inputs = @() })
    $vsCodeServers = Ensure-ObjectProperty -Object $vsCodeMcp -Name "servers"
    foreach ($entry in $vsCodeServerMap.GetEnumerator()) {
        Set-ScalarProperty -Object $vsCodeServers -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $vsCodeMcpPath -Object $vsCodeMcp -Report ([ref]$report)

    $vsCodeSettingsPath = Join-SharedPath @($vsCodeUserRoot, "settings.json")
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
}

if (Test-ClientSelected -Name "copilot") {
    $copilotInstructionsPath = Join-SharedPath @($copilotHomeRoot, "instructions", "shared-memory.instructions.md")
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
}

if (Test-ClientSelected -Name "opencode") {
    $opencodeConfigPath = Join-SharedPath @($opencodeConfigRoot, "opencode.json")
    $opencodeConfig = Read-JsonFile -Path $opencodeConfigPath -DefaultObject ([pscustomobject]@{
        '$schema' = "https://opencode.ai/config.json"
        mcp = [pscustomobject]@{}
    })
    $opencodeMcp = Ensure-ObjectProperty -Object $opencodeConfig -Name "mcp"
    foreach ($entry in $openCodeServerMap.GetEnumerator()) {
        Set-ScalarProperty -Object $opencodeMcp -Name $entry.Key -Value $entry.Value
    }

    $opencodeInstructionFile = Join-SharedPath @($opencodeConfigRoot, "instructions", "shared-memory.md")
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

    $opencodeAgentsPath = Join-SharedPath @($opencodeConfigRoot, "AGENTS.md")
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
    foreach ($item in @("./AGENTS.md", "./instructions/shared-memory.md")) {
        if ($instructions -notcontains $item) {
            $instructions += $item
        }
    }
    Set-ScalarProperty -Object $opencodeConfig -Name "instructions" -Value $instructions
    Write-JsonFile -Path $opencodeConfigPath -Object $opencodeConfig -Report ([ref]$report)
}

if (Test-ClientSelected -Name "claude") {
    foreach ($claudeConfigPath in @(
        (Join-SharedPath @($userHome, ".claude.json")),
        (Join-SharedPath @($claudeHomeRoot, "config.json"))
    )) {
        $claudeConfig = Read-JsonFile -Path $claudeConfigPath -DefaultObject ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
        $claudeServers = Ensure-ObjectProperty -Object $claudeConfig -Name "mcpServers"
        foreach ($entry in $claudeServerMap.GetEnumerator()) {
            Set-ScalarProperty -Object $claudeServers -Name $entry.Key -Value $entry.Value
        }
        Write-JsonFile -Path $claudeConfigPath -Object $claudeConfig -Report ([ref]$report)
    }
}

if (Test-ClientSelected -Name "codex") {
    $codexConfigPath = Join-SharedPath @($codexRoot, "config.toml")
    Update-CodexConfigToml -Path $codexConfigPath -Manifest $manifest -Servers $servers -Report ([ref]$report)
}

if (Test-ClientSelected -Name "trae") {
    $traeMcpPath = Join-SharedPath @($traeUserRoot, "mcp.json")
    $traeMcp = Read-JsonFile -Path $traeMcpPath -DefaultObject ([pscustomobject]@{ servers = [pscustomobject]@{} })
    $traeServers = Ensure-ObjectProperty -Object $traeMcp -Name "servers"
    foreach ($entry in $vsCodeServerMap.GetEnumerator()) {
        Set-ScalarProperty -Object $traeServers -Name $entry.Key -Value $entry.Value
    }
    Write-JsonFile -Path $traeMcpPath -Object $traeMcp -Report ([ref]$report)
}

if (Test-ClientSelected -Name "openclaw") {
    $report.notes.Add("OpenClaw does not need a separate live MCP client config here; the shared-memory bridge is refreshed through memory-bus generation and watchdog sync.") | Out-Null
}

if ((-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) -and (-not $SkipWorkspaceOverlays)) {
    Ensure-Directory -Path $WorkspaceRoot

    if (Test-ClientSelected -Name "cursor") {
        $workspaceCursorRule = Join-SharedPath @($WorkspaceRoot, ".cursor", "rules", "shared-memory.mdc")
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

        $workspaceCursorMcpPath = Join-SharedPath @($WorkspaceRoot, ".cursor", "mcp.json")
        $workspaceCursorMcp = Read-JsonFile -Path $workspaceCursorMcpPath -DefaultObject ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
        $workspaceCursorServers = Ensure-ObjectProperty -Object $workspaceCursorMcp -Name "mcpServers"
        foreach ($entry in $cursorServerMap.GetEnumerator()) {
            Set-ScalarProperty -Object $workspaceCursorServers -Name $entry.Key -Value $entry.Value
        }
        Write-JsonFile -Path $workspaceCursorMcpPath -Object $workspaceCursorMcp -Report ([ref]$report)
    }

    if ((Test-ClientSelected -Name "vscode") -or (Test-ClientSelected -Name "copilot")) {
        $workspaceVsCodeMcpPath = Join-SharedPath @($WorkspaceRoot, ".vscode", "mcp.json")
        $workspaceVsCodeMcp = Read-JsonFile -Path $workspaceVsCodeMcpPath -DefaultObject ([pscustomobject]@{ servers = [pscustomobject]@{} })
        $workspaceVsCodeServers = Ensure-ObjectProperty -Object $workspaceVsCodeMcp -Name "servers"
        foreach ($entry in $vsCodeServerMap.GetEnumerator()) {
            Set-ScalarProperty -Object $workspaceVsCodeServers -Name $entry.Key -Value $entry.Value
        }
        Write-JsonFile -Path $workspaceVsCodeMcpPath -Object $workspaceVsCodeMcp -Report ([ref]$report)
    }

    if (Test-ClientSelected -Name "claude") {
        $workspaceClaudeRulePath = Join-SharedPath @($WorkspaceRoot, ".claude", "rules", "shared-memory.md")
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
    }

    if (Test-ClientSelected -Name "opencode") {
        $workspaceOpenCodeConfigPath = Join-Path $WorkspaceRoot "opencode.json"
        $workspaceOpenCodeConfig = Read-JsonFile -Path $workspaceOpenCodeConfigPath -DefaultObject ([pscustomobject]@{
            '$schema' = "https://opencode.ai/config.json"
            instructions = @("AGENTS.md", ".claude/rules/*.md", ".cursor/rules/*.md", ".github/copilot-instructions.md")
            mcp = [pscustomobject]@{}
        })
        $workspaceOpenCodeMcp = Ensure-ObjectProperty -Object $workspaceOpenCodeConfig -Name "mcp"
        foreach ($entry in $openCodeServerMap.GetEnumerator()) {
            Set-ScalarProperty -Object $workspaceOpenCodeMcp -Name $entry.Key -Value $entry.Value
        }

        $workspaceInstructions = @()
        if ($workspaceOpenCodeConfig.PSObject.Properties["instructions"]) {
            $workspaceInstructions = @($workspaceOpenCodeConfig.instructions)
        }
        foreach ($item in @("AGENTS.md", ".claude/rules/*.md", ".cursor/rules/*.md", ".github/copilot-instructions.md")) {
            if ($workspaceInstructions -notcontains $item) {
                $workspaceInstructions += $item
            }
        }
        Set-ScalarProperty -Object $workspaceOpenCodeConfig -Name "instructions" -Value $workspaceInstructions
        Write-JsonFile -Path $workspaceOpenCodeConfigPath -Object $workspaceOpenCodeConfig -Report ([ref]$report)
    }
} elseif (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $report.skippedTargets.Add("workspace-overlays") | Out-Null
}

$report.notes.Add(("Shared HTTP MCP endpoints applied: {0}" -f ([string]::Join(", ", @($report.serversApplied))))) | Out-Null
$report.notes.Add("Thin plugin adapters stay generated under generated/onboarding/<agent>/generic/plugin; they are documented, not force-installed.") | Out-Null
$report.notes.Add("Shared portable skills remain synchronized through sync-shared-skills.ps1 and surfaced via generated/SHARED-SKILLS.md.") | Out-Null
$report.notes.Add("install-client-integrations.ps1 is the side-effecting entrypoint; verify-client-integrations.ps1 remains the hard validation gate.") | Out-Null

Ensure-Directory -Path (Split-Path -Parent $ReportPath)
[System.IO.File]::WriteAllText($ReportPath, (($report | ConvertTo-Json -Depth 12).Trim() + "`n"), $Utf8NoBom)

$output = $report | ConvertTo-Json -Depth 12
if (-not $Quiet) {
    Write-Output $output
}
