param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = "",
    [switch]$RunCliChecks
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

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

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

if ([string]::IsNullOrWhiteSpace($AiMemoryRoot)) {
    $AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Get-SharedDefaultAiMemoryRoot }
}

$expectedShared = [ordered]@{
    context7 = "http://127.0.0.1:9331/mcp"
    fetch = "http://127.0.0.1:9332/mcp"
    time = "http://127.0.0.1:9333/mcp"
    "sequential-thinking" = "http://127.0.0.1:9334/mcp"
    obsidian = "http://127.0.0.1:9335/mcp"
    memory = "http://127.0.0.1:9338/mcp"
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-JsonFileOrNull {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    if ([string]::IsNullOrWhiteSpace($content)) {
        return $null
    }

    return ($content | ConvertFrom-Json)
}

function Get-McpValidation {
    param(
        [AllowNull()]$Container,
        [Parameter(Mandatory = $true)][string]$Kind
    )

    $result = [ordered]@{
        kind = $Kind
        found = $false
        expected = @()
        missing = @()
        mismatched = @()
    }

    if ($null -eq $Container) {
        return [pscustomobject]$result
    }

    $result.found = $true
    foreach ($entry in $expectedShared.GetEnumerator()) {
        $result.expected += $entry.Key
        $property = $Container.PSObject.Properties[$entry.Key]
        if (-not $property) {
            $result.missing += $entry.Key
            continue
        }

        $value = $property.Value
        $actualUrl = if ($null -ne $value.PSObject.Properties["url"]) { [string]$value.url } else { "" }
        if ($actualUrl -ne $entry.Value) {
            $result.mismatched += [pscustomobject]@{
                name = $entry.Key
                expectedUrl = $entry.Value
                actualUrl = $actualUrl
            }
        }
    }

    return [pscustomobject]$result
}

function Get-FileCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet("json","text")] [string]$Type
    )

    $record = [ordered]@{
        path = $Path
        exists = (Test-Path -LiteralPath $Path -PathType Leaf)
        type = $Type
        valid = $false
        details = $null
    }

    if (-not $record.exists) {
        return [pscustomobject]$record
    }

    if ($Type -eq "json") {
        try {
            $parsed = Read-JsonFileOrNull -Path $Path
            $record.valid = $null -ne $parsed
            if ($record.valid) {
                $record.details = [pscustomobject]@{
                    bytes = (Get-Item -LiteralPath $Path).Length
                }
            }
        } catch {
            $record.details = $_.Exception.Message
        }
        return [pscustomobject]$record
    }

    try {
        $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
        $record.valid = -not [string]::IsNullOrWhiteSpace($content)
        $record.details = [pscustomobject]@{
            bytes = (Get-Item -LiteralPath $Path).Length
            hasSharedMarker = $content.Contains("SHARED-MEMORY-BUS")
        }
    } catch {
        $record.details = $_.Exception.Message
    }

    return [pscustomobject]$record
}

function Resolve-PreferredExecutable {
    param([Parameter(Mandatory = $true)][string]$Name)

    foreach ($candidate in @("$Name.cmd", $Name)) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    return $Name
}

function Invoke-CliCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    $previousErrorAction = $ErrorActionPreference
    $hadNativePref = $false
    $previousNativePref = $false
    try {
        $ErrorActionPreference = "Continue"
        if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
            $hadNativePref = $true
            $previousNativePref = $Global:PSNativeCommandUseErrorActionPreference
            $Global:PSNativeCommandUseErrorActionPreference = $false
        }
        if ((Test-SharedIsWindows) -and $Executable -match '\.(cmd|bat)$') {
            $cmdLine = '"' + $Executable + '" ' + ($Arguments -join ' ')
            $output = & cmd.exe /d /c $cmdLine 2>&1
        } else {
            $output = & $Executable @Arguments 2>&1
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
        if ($hadNativePref) {
            $Global:PSNativeCommandUseErrorActionPreference = $previousNativePref
        }
        Pop-Location
    }

    $text = ($output | Out-String).Trim()
    $mcpIndex = $text.IndexOf("MCP Servers")
    if ($mcpIndex -gt 0) {
        $prefixIndex = [Math]::Max(0, $mcpIndex - 12)
        $text = $text.Substring($prefixIndex).Trim()
    }
    return [pscustomobject]@{
        command = (($Executable + " " + ($Arguments -join " ")).Trim())
        workdir = $WorkingDirectory
        exitCode = $exitCode
        output = $text
        mentionsContext7 = $text -match "context7"
        mentionsSequentialThinking = $text -match "sequential-thinking"
        mentionsObsidian = $text -match "obsidian"
        mentionsTimeDisabled = $text -match "time.+disabled"
        hasSharedContext7Url = $text -match "http://127\.0\.0\.1:9331/mcp"
        hasSharedFetchUrl = $text -match "http://127\.0\.0\.1:9332/mcp"
        hasSharedTimeUrl = $text -match "http://127\.0\.0\.1:9333/mcp"
        hasSharedSequentialUrl = $text -match "http://127\.0\.0\.1:9334/mcp"
        hasSharedObsidianUrl = $text -match "http://127\.0\.0\.1:9335/mcp"
        hasSharedMiniMaxUrl = $text -match "http://127\.0\.0\.1:9336/mcp"
        hasSharedMemoryUrl = $text -match "http://127\.0\.0\.1:9338/mcp"
        hasLocalContext7 = $text -match "@upstash/context7-mcp"
        hasLocalMemory = $text -match "@modelcontextprotocol/server-memory"
    }
}

$userHome = Get-SharedUserHome
$vsCodeUserRoot = Get-SharedVsCodeUserRoot -ProductName "Code"
$report = [ordered]@{
    generatedAt = (Get-Date).ToString("s")
    aiMemoryRoot = $AiMemoryRoot
    workspaceRoot = $WorkspaceRoot
    sharedMcpStatus = $null
    sharedSkills = [ordered]@{}
    clients = [ordered]@{}
    cliChecks = @()
}

$sharedStatusPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "status-shared-mcp.ps1")
if (Test-Path -LiteralPath $sharedStatusPath -PathType Leaf) {
    try {
        $report.sharedMcpStatus = @((Invoke-SharedPowerShellFile -ScriptPath $sharedStatusPath | ConvertFrom-Json))
    } catch {
        $report.sharedMcpStatus = [pscustomobject]@{ error = $_.Exception.Message }
    }
}

$cursorGlobalPath = Join-SharedPath @($userHome, ".cursor", "mcp.json")
$vsCodeMcpPath = Join-Path $vsCodeUserRoot "mcp.json"
$vsCodeSettingsPath = Join-Path $vsCodeUserRoot "settings.json"
$copilotInstructionsPath = Join-SharedPath @($userHome, ".copilot", "instructions", "shared-memory.instructions.md")
$opencodeConfigPath = Join-SharedPath @($userHome, ".config", "opencode", "opencode.json")
$opencodeInstructionsPath = Join-SharedPath @($userHome, ".config", "opencode", "instructions", "shared-memory.md")
$opencodeAgentsPath = Join-SharedPath @($userHome, ".config", "opencode", "AGENTS.md")
$claudeConfigPath = Join-SharedPath @($userHome, ".claude.json")
$vaultRoot = Resolve-SharedObsidianVaultRoot -FallbackPath (Join-SharedPath @($userHome, "Documents", "Obsidian Vault"))
$sharedSkillsManifestPath = Join-SharedPath @($AiMemoryRoot, "shared-skills", "managed-links.json")
$sharedSkillsGuidePath = Join-SharedPath @($vaultRoot, "00-System", "ai-memory", "generated", "SHARED-SKILLS.md")
$globalPortableSkillsRoot = Join-SharedPath @($userHome, ".agents", "skills")

$sharedSkillsManifest = Read-JsonFileOrNull -Path $sharedSkillsManifestPath
$report.sharedSkills = [ordered]@{
    manifestFile = Get-FileCheck -Path $sharedSkillsManifestPath -Type json
    guideFile = Get-FileCheck -Path $sharedSkillsGuidePath -Type text
    globalPortableRootExists = Test-Path -LiteralPath $globalPortableSkillsRoot -PathType Container
    globalPortableSkillCount = if (Test-Path -LiteralPath $globalPortableSkillsRoot -PathType Container) { @((Get-ChildItem -LiteralPath $globalPortableSkillsRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') })).Count } else { 0 }
    managedLinkCount = if ($null -ne $sharedSkillsManifest -and $null -ne $sharedSkillsManifest.links) { @($sharedSkillsManifest.links).Count } else { 0 }
}

$cursorGlobal = Read-JsonFileOrNull -Path $cursorGlobalPath
$vsCodeMcp = Read-JsonFileOrNull -Path $vsCodeMcpPath
$vsCodeSettings = Read-JsonFileOrNull -Path $vsCodeSettingsPath
$opencodeConfig = Read-JsonFileOrNull -Path $opencodeConfigPath
$claudeConfig = Read-JsonFileOrNull -Path $claudeConfigPath

$report.clients.cursor = [ordered]@{
    globalMcpFile = Get-FileCheck -Path $cursorGlobalPath -Type json
    sharedMcp = Get-McpValidation -Container $(if ($null -ne $cursorGlobal) { $cursorGlobal.mcpServers } else { $null }) -Kind "cursor-global"
}

$report.clients.vscode = [ordered]@{
    globalMcpFile = Get-FileCheck -Path $vsCodeMcpPath -Type json
    settingsFile = Get-FileCheck -Path $vsCodeSettingsPath -Type json
    sharedMcp = Get-McpValidation -Container $(if ($null -ne $vsCodeMcp) { $vsCodeMcp.servers } else { $null }) -Kind "vscode-global"
    settings = [ordered]@{
        autoStart = if ($null -ne $vsCodeSettings) { $vsCodeSettings."chat.mcp.autoStart" } else { $null }
        useAgentsMdFile = if ($null -ne $vsCodeSettings) { $vsCodeSettings."chat.useAgentsMdFile" } else { $null }
        useClaudeMdFile = if ($null -ne $vsCodeSettings) { $vsCodeSettings."chat.useClaudeMdFile" } else { $null }
    }
}

$opencodeTimeEnabled = $null
if ($null -ne $opencodeConfig -and $opencodeConfig.mcp.PSObject.Properties["time"]) {
    $timeConfig = $opencodeConfig.mcp.time
    $opencodeTimeEnabled = if ($null -ne $timeConfig.PSObject.Properties["enabled"]) { [bool]$timeConfig.enabled } else { $true }
}

$report.clients.opencode = [ordered]@{
    globalConfigFile = Get-FileCheck -Path $opencodeConfigPath -Type json
    instructionsFile = Get-FileCheck -Path $opencodeInstructionsPath -Type text
    globalAgentsFile = Get-FileCheck -Path $opencodeAgentsPath -Type text
    sharedMcp = Get-McpValidation -Container $(if ($null -ne $opencodeConfig) { $opencodeConfig.mcp } else { $null }) -Kind "opencode-global"
    timeEnabled = $opencodeTimeEnabled
}

$report.clients.claude = [ordered]@{
    globalConfigFile = Get-FileCheck -Path $claudeConfigPath -Type json
    sharedMcp = Get-McpValidation -Container $(if ($null -ne $claudeConfig) { $claudeConfig.mcpServers } else { $null }) -Kind "claude-global"
}

$report.clients.copilot = [ordered]@{
    instructionsFile = Get-FileCheck -Path $copilotInstructionsPath -Type text
}

if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $workspaceCursorPath = Join-SharedPath @($WorkspaceRoot, ".cursor", "mcp.json")
    $workspaceVsCodePath = Join-SharedPath @($WorkspaceRoot, ".vscode", "mcp.json")
    $workspaceClaudePath = Join-SharedPath @($WorkspaceRoot, ".claude", "rules", "shared-memory.md")
    $workspaceAgentsPath = Join-Path $WorkspaceRoot "AGENTS.md"
    $workspaceCopilotPath = Join-SharedPath @($WorkspaceRoot, ".github", "copilot-instructions.md")
    $workspaceOpenCodePath = Join-Path $WorkspaceRoot "opencode.json"
    $workspacePortableSkillsRoot = Join-SharedPath @($WorkspaceRoot, ".agents", "skills")

    $workspaceCursor = Read-JsonFileOrNull -Path $workspaceCursorPath
    $workspaceVsCode = Read-JsonFileOrNull -Path $workspaceVsCodePath
    $workspaceOpenCode = Read-JsonFileOrNull -Path $workspaceOpenCodePath

    $report.clients.workspace = [ordered]@{
        cursorMcpFile = Get-FileCheck -Path $workspaceCursorPath -Type json
        vscodeMcpFile = Get-FileCheck -Path $workspaceVsCodePath -Type json
        claudeRuleFile = Get-FileCheck -Path $workspaceClaudePath -Type text
        agentsFile = Get-FileCheck -Path $workspaceAgentsPath -Type text
        copilotInstructionsFile = Get-FileCheck -Path $workspaceCopilotPath -Type text
        opencodeConfigFile = Get-FileCheck -Path $workspaceOpenCodePath -Type json
        cursorSharedMcp = Get-McpValidation -Container $(if ($null -ne $workspaceCursor) { $workspaceCursor.mcpServers } else { $null }) -Kind "workspace-cursor"
        vscodeSharedMcp = Get-McpValidation -Container $(if ($null -ne $workspaceVsCode) { $workspaceVsCode.servers } else { $null }) -Kind "workspace-vscode"
        opencodeSharedMcp = Get-McpValidation -Container $(if ($null -ne $workspaceOpenCode) { $workspaceOpenCode.mcp } else { $null }) -Kind "workspace-opencode"
        workspacePortableSkillsRoot = $workspacePortableSkillsRoot
        workspacePortableSkillCount = if (Test-Path -LiteralPath $workspacePortableSkillsRoot -PathType Container) { @((Get-ChildItem -LiteralPath $workspacePortableSkillsRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') })).Count } else { 0 }
    }
}

if ($RunCliChecks) {
    $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "codex") -Arguments @("mcp", "list") -WorkingDirectory $PWD.Path
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "opencode") -Arguments @("mcp", "list") -WorkingDirectory $WorkspaceRoot
    } else {
        $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "opencode") -Arguments @("mcp", "list") -WorkingDirectory $PWD.Path
    }
}

$reportDir = Join-Path $AiMemoryRoot "reports"
Ensure-Directory -Path $reportDir
$reportPath = Join-Path $reportDir "verify-client-integrations.last.json"
[System.IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 12).Trim() + "`n"), $Utf8NoBom)

$report | ConvertTo-Json -Depth 12
