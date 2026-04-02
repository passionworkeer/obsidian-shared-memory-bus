param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = "",
    [switch]$RunCliChecks,
    [switch]$RunRuntimeChecks
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

function Get-MemoryStatusSnapshot {
    $payload = @{
        jsonrpc = "2.0"
        id = "verify-memory-status"
        method = "tools/call"
        params = @{
            name = "memory_status"
            arguments = @{}
        }
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:9338/mcp" -Method Post -TimeoutSec 20 -ContentType "application/json" -Body $payload
        $errorProperty = $response.PSObject.Properties["error"]
        if ($null -ne $errorProperty -and $null -ne $response.error) {
            return [pscustomobject]@{
                error = [string]$response.error.message
            }
        }

        $content = @()
        if ($null -ne $response.result -and $null -ne $response.result.content) {
            $content = @($response.result.content)
        }
        if ($content.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$content[0].text)) {
            return [pscustomobject]@{
                error = "memory_status returned no content"
            }
        }

        return ($content[0].text | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{
            error = $_.Exception.Message
        }
    }
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
        $output = & $Executable @Arguments 2>&1
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

function Get-ClientProbePrompt {
    return 'Use the shared MCP memory tool. First call memory_status and read watchdog.status, watchdog.pid, watchdog.updatedAt, and memoryIntegrity.status from the nested response. Then call search_shared_memory with query ''shared memory read order'', mode ''hybrid'', route ''mixed'', limit 1. Set searchObservedResult to true if the search returns at least one result, otherwise false. Return only one strict minified JSON object with exactly these flat keys: client, watchdogStatus, watchdogPid, watchdogUpdatedAt, memoryIntegrityStatus, searchObservedResult. All values must be plain string, number, or boolean scalars. No markdown, no code fences, no commentary.'
}

function Test-JsonProbeShape {
    param([AllowNull()]$Object)

    return (
        $null -ne $Object -and
        $null -ne $Object.PSObject.Properties["watchdogStatus"] -and
        $null -ne $Object.PSObject.Properties["watchdogPid"] -and
        $null -ne $Object.PSObject.Properties["memoryIntegrityStatus"]
    )
}

function Get-JsonProbeCandidates {
    param([Parameter(Mandatory = $true)][string]$Text)

    $candidates = New-Object System.Collections.Generic.List[string]

    function Add-JsonProbeCandidate {
        param([AllowEmptyString()][string]$Value)

        if ([string]::IsNullOrWhiteSpace($Value)) {
            return
        }

        $variants = @(
            $Value.Trim(),
            ($Value.Trim() -replace '^[`]+', '' -replace '[`]+$', '').Trim(),
            ($Value.Trim() -replace '^```(?:json)?\s*', '' -replace '\s*```$', '').Trim()
        )

        foreach ($variant in $variants) {
            if (-not [string]::IsNullOrWhiteSpace($variant) -and -not $candidates.Contains($variant)) {
                $candidates.Add($variant) | Out-Null
            }
        }
    }

    function Add-JsonCandidatesFromObject {
        param([AllowNull()]$Object)

        if ($null -eq $Object) {
            return
        }

        if ($Object -is [string]) {
            Add-JsonProbeCandidate -Value $Object
            return
        }

        if ($Object -is [System.Collections.IEnumerable] -and -not ($Object -is [psobject])) {
            foreach ($item in $Object) {
                Add-JsonCandidatesFromObject -Object $item
            }
            return
        }

        if (Test-JsonProbeShape -Object $Object) {
            try {
                Add-JsonProbeCandidate -Value (($Object | ConvertTo-Json -Compress -Depth 16).Trim())
            } catch {
            }
        }

        foreach ($propertyName in @("result", "text", "message", "output", "response", "stdout", "part")) {
            $property = $Object.PSObject.Properties[$propertyName]
            if ($null -ne $property) {
                Add-JsonCandidatesFromObject -Object $property.Value
            }
        }

        $contentProperty = $Object.PSObject.Properties["content"]
        if ($null -ne $contentProperty) {
            Add-JsonCandidatesFromObject -Object $contentProperty.Value
        }

        $itemsProperty = $Object.PSObject.Properties["items"]
        if ($null -ne $itemsProperty) {
            Add-JsonCandidatesFromObject -Object $itemsProperty.Value
        }
    }

    Add-JsonProbeCandidate -Value $Text
    try {
        $outerJson = $Text | ConvertFrom-Json -ErrorAction Stop
        Add-JsonCandidatesFromObject -Object $outerJson
    } catch {
    }

    foreach ($line in @($Text -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        Add-JsonProbeCandidate -Value $line
        try {
            $lineJson = $line | ConvertFrom-Json -ErrorAction Stop
            Add-JsonCandidatesFromObject -Object $lineJson
        } catch {
        }
    }

    foreach ($candidate in @($candidates.ToArray())) {
        foreach ($match in [regex]::Matches($candidate, '\{[^{}]+\}')) {
            Add-JsonProbeCandidate -Value $match.Value
        }
    }

    return $candidates.ToArray()
}

function ConvertFrom-JsonProbePayload {
    param([Parameter(Mandatory = $true)][string]$Text)

    $fallback = $null
    foreach ($candidate in @(Get-JsonProbeCandidates -Text $Text)) {
        try {
            $parsed = ($candidate | ConvertFrom-Json -ErrorAction Stop)
            if ($null -eq $fallback) {
                $fallback = $parsed
            }
            if (Test-JsonProbeShape -Object $parsed) {
                return $parsed
            }
        } catch {
        }
    }

    if ($null -ne $fallback) {
        return $fallback
    }

    throw "No valid flat JSON object found in client output"
}

function Convert-NativeOutputToText {
    param([AllowNull()]$Output)

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($Output)) {
        if ($null -eq $item) {
            continue
        }

        $value = ""
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $targetText = ""
            if ($null -ne $item.TargetObject) {
                $targetText = [string]$item.TargetObject
            }

            $messageText = ""
            if ($null -ne $item.Exception) {
                $messageText = [string]$item.Exception.Message
            }

            if (-not [string]::IsNullOrWhiteSpace($targetText)) {
                $value = $targetText
            } elseif (-not [string]::IsNullOrWhiteSpace($messageText)) {
                $value = $messageText
            } else {
                $value = $item.ToString()
            }
        } else {
            $value = [string]$item
        }

        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $lines.Add($value) | Out-Null
        }
    }

    return (($lines -join [Environment]::NewLine).Trim())
}

function Invoke-ClientRuntimeProbe {
    param(
        [Parameter(Mandatory = $true)][string]$ClientId,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [AllowNull()]$ExpectedMemoryHealth
    )

    $record = [ordered]@{
        clientId = $ClientId
        command = (($Executable + " " + ($Arguments -join " ")).Trim())
        workingDirectory = $WorkingDirectory
        exitCode = -1
        ok = $false
        hasProbeJson = $false
        watchdogStatus = ""
        watchdogPid = 0
        watchdogUpdatedAt = ""
        memoryIntegrityStatus = ""
        searchObservedResult = $false
        watchdogStatusMatches = $false
        watchdogPidMatches = $false
        memoryIntegrityMatches = $false
        pass = $false
        outputPreview = ""
        errors = @()
    }

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
        $output = & $Executable @Arguments 2>&1
        $record.exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
        if ($hadNativePref) {
            $Global:PSNativeCommandUseErrorActionPreference = $previousNativePref
        }
        Pop-Location
    }

    $text = Convert-NativeOutputToText -Output $output
    $sanitizedText = [regex]::Replace($text, "\x1b\[[0-9;]*[A-Za-z]", "")
    $record.ok = ($record.exitCode -eq 0)

    if ($text.Length -gt 240) {
        $record.outputPreview = $text.Substring(0, 240)
    } else {
        $record.outputPreview = $text
    }

    try {
        $parsed = ConvertFrom-JsonProbePayload -Text $sanitizedText
        $record.hasProbeJson =
            ($null -ne $parsed.PSObject.Properties["watchdogStatus"]) -and
            ($null -ne $parsed.PSObject.Properties["watchdogPid"]) -and
            ($null -ne $parsed.PSObject.Properties["memoryIntegrityStatus"])
        if ($record.hasProbeJson) {
            $record.watchdogStatus = [string]$parsed.watchdogStatus
            $record.watchdogPid = [int]$parsed.watchdogPid
            $record.watchdogUpdatedAt = [string]$parsed.watchdogUpdatedAt
            $record.memoryIntegrityStatus = [string]$parsed.memoryIntegrityStatus
            if ($null -ne $parsed.PSObject.Properties["searchObservedResult"]) {
                if ($parsed.searchObservedResult -is [bool]) {
                    $record.searchObservedResult = [bool]$parsed.searchObservedResult
                } elseif ($parsed.searchObservedResult -is [string]) {
                    $record.searchObservedResult = ([string]$parsed.searchObservedResult).Trim().ToLowerInvariant() -eq "true"
                } else {
                    $record.searchObservedResult = ($null -ne $parsed.searchObservedResult)
                }
            }
        }
    } catch {
        $record.errors += ("runtime-probe-json-parse-failed: " + $_.Exception.Message)
    }

    if (-not $record.ok) {
        $record.errors += ("command-exit-" + $record.exitCode)
    }
    if (-not $record.hasProbeJson) {
        $record.errors += "missing-runtime-probe-json"
    }

    if ($null -ne $ExpectedMemoryHealth -and $null -eq $ExpectedMemoryHealth.PSObject.Properties["error"]) {
        $expectedWatchdogStatus = [string]$ExpectedMemoryHealth.watchdog.status
        $expectedWatchdogPid = [int]$ExpectedMemoryHealth.watchdog.pid
        $expectedMemoryIntegrityStatus = [string]$ExpectedMemoryHealth.memoryIntegrity.status
        $record.watchdogStatusMatches = ($record.watchdogStatus -eq $expectedWatchdogStatus)
        $record.watchdogPidMatches = ($record.watchdogPid -eq $expectedWatchdogPid)
        $record.memoryIntegrityMatches = ($record.memoryIntegrityStatus -eq $expectedMemoryIntegrityStatus)
        if (-not $record.watchdogStatusMatches) {
            $record.errors += "watchdog-status-mismatch"
        }
        if (-not $record.watchdogPidMatches) {
            $record.errors += "watchdog-pid-mismatch"
        }
        if (-not $record.memoryIntegrityMatches) {
            $record.errors += "memory-integrity-mismatch"
        }
        if (-not $record.searchObservedResult) {
            $record.errors += "search-observed-result-false"
        }
        $record.pass = (
            $record.ok -and
            $record.hasProbeJson -and
            $record.watchdogStatusMatches -and
            $record.watchdogPidMatches -and
            $record.memoryIntegrityMatches -and
            $record.searchObservedResult
        )
    } else {
        $record.pass = ($record.ok -and $record.hasProbeJson)
    }

    return [pscustomobject]$record
}

function Test-FileCheckPass {
    param([AllowNull()]$Check)

    return (
        $null -ne $Check -and
        $null -ne $Check.PSObject.Properties["exists"] -and
        [bool]$Check.exists -and
        [bool]$Check.valid
    )
}

function Test-McpValidationPass {
    param([AllowNull()]$Validation)

    return (
        $null -ne $Validation -and
        $null -ne $Validation.PSObject.Properties["found"] -and
        [bool]$Validation.found -and
        @($Validation.missing).Count -eq 0 -and
        @($Validation.mismatched).Count -eq 0
    )
}

$userHome = Get-SharedUserHome
$vsCodeUserRoot = Get-SharedVsCodeUserRoot -ProductName "Code"
$report = [ordered]@{
    generatedAt = (Get-Date).ToString("s")
    aiMemoryRoot = $AiMemoryRoot
    workspaceRoot = $WorkspaceRoot
    sharedMcpStatus = $null
    memoryHealth = $null
    sharedSkills = [ordered]@{}
    clients = [ordered]@{}
    cliChecks = @()
    runtimeChecks = @()
}

$sharedStatusPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "status-shared-mcp.ps1")
if (Test-Path -LiteralPath $sharedStatusPath -PathType Leaf) {
    try {
        $report.sharedMcpStatus = @((Invoke-SharedPowerShellFile -ScriptPath $sharedStatusPath | ConvertFrom-Json))
    } catch {
        $report.sharedMcpStatus = [pscustomobject]@{ error = $_.Exception.Message }
    }
}

$report.memoryHealth = Get-MemoryStatusSnapshot

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
        $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "claude") -Arguments @("mcp", "list") -WorkingDirectory $WorkspaceRoot
    } else {
        $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "opencode") -Arguments @("mcp", "list") -WorkingDirectory $PWD.Path
        $report.cliChecks += Invoke-CliCheck -Executable (Resolve-PreferredExecutable -Name "claude") -Arguments @("mcp", "list") -WorkingDirectory $PWD.Path
    }
}

if ($RunRuntimeChecks) {
    $clientWorkspace = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $PWD.Path } else { $WorkspaceRoot }
    $clientPrompt = Get-ClientProbePrompt
    $report.runtimeChecks += Invoke-ClientRuntimeProbe -ClientId "codex" -Executable (Resolve-PreferredExecutable -Name "codex") -Arguments @("exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", $clientWorkspace, $clientPrompt) -WorkingDirectory $clientWorkspace -ExpectedMemoryHealth $report.memoryHealth
    $report.runtimeChecks += Invoke-ClientRuntimeProbe -ClientId "claude" -Executable (Resolve-PreferredExecutable -Name "claude") -Arguments @("-p", "--permission-mode", "bypassPermissions", "--output-format", "json", $clientPrompt) -WorkingDirectory $clientWorkspace -ExpectedMemoryHealth $report.memoryHealth
    $report.runtimeChecks += Invoke-ClientRuntimeProbe -ClientId "opencode" -Executable (Resolve-PreferredExecutable -Name "opencode") -Arguments @("run", "--dir", $clientWorkspace, "--format", "json", "--print-logs", "false", "--log-level", "ERROR", $clientPrompt) -WorkingDirectory $clientWorkspace -ExpectedMemoryHealth $report.memoryHealth
}

$summaryErrors = New-Object System.Collections.Generic.List[string]

$sharedMcpStatusPass = $true
if ($null -eq $report.sharedMcpStatus -or $null -ne $report.sharedMcpStatus.PSObject.Properties["error"]) {
    $sharedMcpStatusPass = $false
    $summaryErrors.Add("shared-mcp-status-unavailable") | Out-Null
} else {
    $requiredSharedServers = @($report.sharedMcpStatus | Where-Object { [string]$_.mode -eq "shared" })
    if ($requiredSharedServers.Count -eq 0) {
        $sharedMcpStatusPass = $false
        $summaryErrors.Add("shared-mcp-status-empty") | Out-Null
    } else {
        foreach ($server in $requiredSharedServers) {
            if (-not [bool]$server.running) {
                $sharedMcpStatusPass = $false
                $summaryErrors.Add("shared-mcp-not-running:$([string]$server.id)") | Out-Null
            }
        }
    }
}

$memoryHealthPass = $true
$claudeMemPass = $true
if ($null -eq $report.memoryHealth -or $null -ne $report.memoryHealth.PSObject.Properties["error"]) {
    $memoryHealthPass = $false
    $claudeMemPass = $false
    $summaryErrors.Add("memory-status-unavailable") | Out-Null
} else {
    if ([string]$report.memoryHealth.watchdog.status -ne "running") {
        $memoryHealthPass = $false
        $summaryErrors.Add("watchdog-not-running") | Out-Null
    }
    if ([string]$report.memoryHealth.memoryIntegrity.status -ne "ok") {
        $memoryHealthPass = $false
        $summaryErrors.Add("memory-integrity-not-ok") | Out-Null
    }
    if (-not [bool]$report.memoryHealth.claudeMem.ok) {
        $claudeMemPass = $false
        $summaryErrors.Add("claude-mem-health-not-ok") | Out-Null
    }
}

$sharedSkillsPass = (
    (Test-FileCheckPass -Check $report.sharedSkills.manifestFile) -and
    (Test-FileCheckPass -Check $report.sharedSkills.guideFile)
)
if (-not $sharedSkillsPass) {
    $summaryErrors.Add("shared-skills-artifacts-invalid") | Out-Null
}

$cursorPass = (
    (Test-FileCheckPass -Check $report.clients.cursor.globalMcpFile) -and
    (Test-McpValidationPass -Validation $report.clients.cursor.sharedMcp)
)
if (-not $cursorPass) {
    $summaryErrors.Add("cursor-global-integration-invalid") | Out-Null
}

$vscodePass = (
    (Test-FileCheckPass -Check $report.clients.vscode.globalMcpFile) -and
    (Test-FileCheckPass -Check $report.clients.vscode.settingsFile) -and
    (Test-McpValidationPass -Validation $report.clients.vscode.sharedMcp)
)
if (-not $vscodePass) {
    $summaryErrors.Add("vscode-global-integration-invalid") | Out-Null
}

$opencodePass = (
    (Test-FileCheckPass -Check $report.clients.opencode.globalConfigFile) -and
    (Test-FileCheckPass -Check $report.clients.opencode.instructionsFile) -and
    (Test-FileCheckPass -Check $report.clients.opencode.globalAgentsFile) -and
    (Test-McpValidationPass -Validation $report.clients.opencode.sharedMcp)
)
if (-not $opencodePass) {
    $summaryErrors.Add("opencode-global-integration-invalid") | Out-Null
}

$claudePass = (
    (Test-FileCheckPass -Check $report.clients.claude.globalConfigFile) -and
    (Test-McpValidationPass -Validation $report.clients.claude.sharedMcp)
)
if (-not $claudePass) {
    $summaryErrors.Add("claude-global-integration-invalid") | Out-Null
}

$copilotPass = (Test-FileCheckPass -Check $report.clients.copilot.instructionsFile)
if (-not $copilotPass) {
    $summaryErrors.Add("copilot-instructions-invalid") | Out-Null
}

$workspacePass = $true
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $workspacePass = (
        (Test-FileCheckPass -Check $report.clients.workspace.cursorMcpFile) -and
        (Test-FileCheckPass -Check $report.clients.workspace.vscodeMcpFile) -and
        (Test-FileCheckPass -Check $report.clients.workspace.claudeRuleFile) -and
        (Test-FileCheckPass -Check $report.clients.workspace.agentsFile) -and
        (Test-FileCheckPass -Check $report.clients.workspace.copilotInstructionsFile) -and
        (Test-FileCheckPass -Check $report.clients.workspace.opencodeConfigFile) -and
        (Test-McpValidationPass -Validation $report.clients.workspace.cursorSharedMcp) -and
        (Test-McpValidationPass -Validation $report.clients.workspace.vscodeSharedMcp) -and
        (Test-McpValidationPass -Validation $report.clients.workspace.opencodeSharedMcp)
    )
    if (-not $workspacePass) {
        $summaryErrors.Add("workspace-integration-invalid") | Out-Null
    }
}

$cliChecksPass = $true
if ($RunCliChecks) {
    $cliChecksPass = (@($report.cliChecks).Count -gt 0)
    if (-not $cliChecksPass) {
        $summaryErrors.Add("cli-checks-empty") | Out-Null
    }
    foreach ($check in @($report.cliChecks)) {
        $checkPass = (
            [int]$check.exitCode -eq 0 -and
            [bool]$check.hasSharedContext7Url -and
            [bool]$check.hasSharedFetchUrl -and
            [bool]$check.hasSharedTimeUrl -and
            [bool]$check.hasSharedSequentialUrl -and
            [bool]$check.hasSharedObsidianUrl -and
            [bool]$check.hasSharedMemoryUrl -and
            -not [bool]$check.hasLocalContext7 -and
            -not [bool]$check.hasLocalMemory
        )
        if (-not $checkPass) {
            $cliChecksPass = $false
            $summaryErrors.Add("cli-check-failed:$([string]$check.command)") | Out-Null
        }
    }
}

$runtimeChecksPass = $true
if ($RunRuntimeChecks) {
    $runtimeChecksPass = (@($report.runtimeChecks).Count -gt 0)
    if (-not $runtimeChecksPass) {
        $summaryErrors.Add("runtime-checks-empty") | Out-Null
    }
    foreach ($check in @($report.runtimeChecks)) {
        if (-not [bool]$check.pass) {
            $runtimeChecksPass = $false
            $summaryErrors.Add("runtime-check-failed:$([string]$check.clientId)") | Out-Null
        }
    }
}

$report.summary = [ordered]@{
    sharedMcpStatusPass = $sharedMcpStatusPass
    memoryHealthPass = $memoryHealthPass
    claudeMemPass = $claudeMemPass
    sharedSkillsPass = $sharedSkillsPass
    cursorPass = $cursorPass
    vscodePass = $vscodePass
    opencodePass = $opencodePass
    claudePass = $claudePass
    copilotPass = $copilotPass
    workspacePass = $workspacePass
    cliChecksPass = $cliChecksPass
    runtimeChecksPass = $runtimeChecksPass
    errorCount = $summaryErrors.Count
    errors = $summaryErrors.ToArray()
    overallPass = (
        $sharedMcpStatusPass -and
        $memoryHealthPass -and
        $claudeMemPass -and
        $sharedSkillsPass -and
        $cursorPass -and
        $vscodePass -and
        $opencodePass -and
        $claudePass -and
        $copilotPass -and
        $workspacePass -and
        (-not $RunCliChecks -or $cliChecksPass) -and
        (-not $RunRuntimeChecks -or $runtimeChecksPass)
    )
}

$reportDir = Join-Path $AiMemoryRoot "reports"
Ensure-Directory -Path $reportDir
$reportPath = Join-Path $reportDir "verify-client-integrations.last.json"
[System.IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 12).Trim() + "`n"), $Utf8NoBom)

$report | ConvertTo-Json -Depth 12
if (-not [bool]$report.summary.overallPass) {
    exit 1
}
