param(
    [string[]]$Only,
    [switch]$IncludeOptional,
    [switch]$ForceRestart
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Split-Path -Parent $root
$helperPath = @(
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $root"
}

. $helperPath

$manifestPath = Join-Path $root "manifest.json"
$statePath = Join-Path $root "state.json"
$fallbackLogRoot = Join-Path $root "logs"
$proxyScriptPath = Join-Path $root "singleton-stdio-mcp-proxy.mjs"

# Resolve central log root (~/.ai-memory/logs/), falling back to shared-mcp/logs.
# Source the standalone helper if available; otherwise use the fallback.
$logPathHelper = Join-Path $sourceRoot (Join-Path "scripts" "Get-LogPath.ps1")
$logRoot = $fallbackLogRoot
if (Test-Path -LiteralPath $logPathHelper -PathType Leaf) {
    . $logPathHelper
    try {
        $centralLogRoot = Get-LogRoot
        if (-not [string]::IsNullOrWhiteSpace($centralLogRoot) -and (Test-Path -LiteralPath $centralLogRoot -PathType Container)) {
            $logRoot = $centralLogRoot
        }
    } catch {
        # Fall back to shared-mcp/logs — logging must never block startup.
    }
}

# Append a timestamped line to the daily start log. Silently ignores failures.
function Write-StartupLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Level = "INFO"
    )
    try {
        $dailyLogPath = if (Get-Command Get-DailyLogPath -ErrorAction SilentlyContinue) {
            Get-DailyLogPath -Prefix "start"
        } else {
            Join-Path $logRoot ("start-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
        }
        $line = "[{0}] [{1}] {2}" -f (Get-Date).ToString("o"), $Level, $Message
        Add-Content -Path $dailyLogPath -Value $line -Encoding UTF8
    } catch {
        # Logging must never crash the caller.
    }
}
$stateMutexName = Get-SharedMutexName -BaseName "AiMcpStateV1"

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return @{}
    }

    try {
        $content = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8
        $parsed = $content | ConvertFrom-Json
        $map = @{}
        foreach ($property in @($parsed.PSObject.Properties)) {
            $entry = @{}
            foreach ($child in @($property.Value.PSObject.Properties)) {
                $entry[$child.Name] = $child.Value
            }
            $map[$property.Name] = $entry
        }
        return $map
    } catch {
        $backup = "$statePath.corrupt.$(Get-Date -Format 'yyyyMMddHHmmss')"
        try { Move-Item -LiteralPath $statePath -Destination $backup -Force } catch {}
        Write-Warning "[shared-mcp] state.json was corrupt, backed up to $backup"
        return @{}
    }
}

function Write-State {
    param([Parameter(Mandatory = $true)][hashtable]$State)

    $tempPath = "$statePath.tmp"
    $json = $State | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tempPath -Destination $statePath -Force
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) {
        return $false
    }

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Standalone PID probe used during state-file zombie cleanup.
function Test-PidAlive {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Normalize-RequestedIds {
    param([string[]]$Ids)

    $normalized = New-Object System.Collections.Generic.List[string]
    foreach ($raw in @($Ids)) {
        if ($null -eq $raw) {
            continue
        }
        foreach ($part in ([string]$raw).Split(",")) {
            $clean = $part.Trim()
            if (-not [string]::IsNullOrWhiteSpace($clean)) {
                $normalized.Add($clean) | Out-Null
            }
        }
    }

    return @($normalized | Select-Object -Unique)
}

function Test-Health {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 5
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

# MCP protocol version: "2024-11-05"
# Hardcoded in 3 places: manifest.json, start-shared-mcp.ps1, singleton-stdio-mcp-proxy.mjs.
# Must update all files together when the MCP protocol version changes.
function Test-McpInitialize {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 5
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    $payload = @{
        jsonrpc = "2.0"
        id = "health-check"
        method = "initialize"
        params = @{
            protocolVersion = "2024-11-05"
            capabilities = @{
                roots = @{
                    listChanged = $true
                }
                sampling = @{}
            }
            clientInfo = @{
                name = "shared-mcp-health"
                version = "1.0.0"
            }
        }
    } | ConvertTo-Json -Depth 8 -Compress

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body $payload -UseBasicParsing
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    } catch {
        return $false
    }
}

function Get-ServerUrl {
    param($Server)

    $path = if ($Server.PSObject.Properties.Name -contains "path" -and -not [string]::IsNullOrWhiteSpace([string]$Server.path)) {
        [string]$Server.path
    } else {
        [string]$manifest.defaults.path
    }

    return "http://{0}:{1}{2}" -f $manifest.defaults.host, (Get-EffectiveServerPort -Server $Server), $path
}

function Get-ServerHealthUrl {
    param($Server)

    $path = if ($Server.PSObject.Properties.Name -contains "healthPath" -and -not [string]::IsNullOrWhiteSpace([string]$Server.healthPath)) {
        [string]$Server.healthPath
    } else {
        [string]$manifest.defaults.healthPath
    }

    return "http://{0}:{1}{2}" -f $manifest.defaults.host, (Get-EffectiveServerPort -Server $Server), $path
}

function Test-ServerReady {
    param(
        $Server,
        [string]$Url,
        [string]$HealthUrl,
        [int]$TimeoutSeconds = 5
    )

    $probeType = if ($Server.PSObject.Properties.Name -contains "probeType") {
        [string]$Server.probeType
    } else {
        "http-get"
    }

    switch ($probeType) {
        "mcp-initialize" {
            return Test-McpInitialize -Url $Url -TimeoutSeconds $TimeoutSeconds
        }
        default {
            return Test-Health -Url $HealthUrl -TimeoutSeconds $TimeoutSeconds
        }
    }
}

function Get-ServerReadyTimeoutSeconds {
    param(
        $Server,
        [int]$Default = 5
    )

    $candidate = $Default
    if ($null -ne $Server -and $Server.PSObject.Properties.Name -contains "startupProbeTimeoutSeconds") {
        $raw = [string]$Server.startupProbeTimeoutSeconds
        $parsed = 0
        if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
            $candidate = $parsed
        }
    }

    return [Math]::Min([Math]::Max($candidate, 1), 60)
}

function Get-ServerStartupProbeAttempts {
    param(
        $Server,
        [int]$Default = 30
    )

    $candidate = $Default
    if ($null -ne $Server -and $Server.PSObject.Properties.Name -contains "startupProbeAttempts") {
        $raw = [string]$Server.startupProbeAttempts
        $parsed = 0
        if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
            $candidate = $parsed
        }
    }

    return [Math]::Min([Math]::Max($candidate, 1), 180)
}

function Get-EffectiveServerPort {
    param($Server)

    if ($null -eq $Server -or -not ($Server.PSObject.Properties.Name -contains "port")) {
        return 0
    }

    $configuredPort = [int]$Server.port
    if ($configuredPort -le 0) {
        return 0
    }

    $manifestBasePort = [int]$manifest.defaults.basePort
    if ($manifestBasePort -le 0 -or $basePort -le 0 -or $basePort -eq $manifestBasePort) {
        return $configuredPort
    }

    return [int]($basePort + ($configuredPort - $manifestBasePort))
}

function ConvertTo-ShellLiteral {
    param([AllowEmptyString()][string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    if (Test-SharedIsWindows) {
        return '"' + ([string]$Value -replace '"', '\"') + '"'
    }

    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $replacement = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    $escapedValue = [string]$Value -replace [regex]::Escape($singleQuote), $replacement
    return "'$escapedValue'"
}

function Split-CommandLineTokens {
    param([AllowEmptyString()][string]$CommandText)

    $tokens = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($CommandText)) {
        return @()
    }

    $matches = [regex]::Matches($CommandText, '"([^"]*)"|[^\s"]+')
    foreach ($match in @($matches)) {
        if ($match.Groups.Count -gt 1 -and $match.Groups[1].Success) {
            $tokens.Add([string]$match.Groups[1].Value) | Out-Null
        } else {
            $tokens.Add([string]$match.Value) | Out-Null
        }
    }

    return @($tokens)
}

function Resolve-WindowsCommandTokenPath {
    param([AllowEmptyString()][string]$Token)

    if ([string]::IsNullOrWhiteSpace($Token)) {
        return ""
    }

    if (Test-Path -LiteralPath $Token -PathType Leaf) {
        return (Get-Item -LiteralPath $Token).FullName
    }

    $command = Get-Command $Token -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        return [string]$command.Source
    }

    return ""
}

function Resolve-WindowsCmdShimLaunchSpec {
    param(
        [Parameter(Mandatory = $true)][string]$CommandPath,
        [string[]]$PassThroughArgs = @(),
        [Parameter(Mandatory = $true)][string]$FallbackNodeExecutable
    )

    if (-not (Test-Path -LiteralPath $CommandPath -PathType Leaf)) {
        return $null
    }

    $content = ""
    try {
        $content = Get-Content -Raw -LiteralPath $CommandPath -Encoding utf8
    } catch {
        return $null
    }

    $match = [regex]::Match(
        $content,
        '"%_prog%"\s+"%(?:dp0|~dp0)%\\([^"\r\n]+\.(?:js|mjs|cjs))"',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) {
        return $null
    }

    $scriptRelativePath = [string]$match.Groups[1].Value
    $scriptPath = Join-Path (Split-Path -Parent $CommandPath) ($scriptRelativePath -replace '\\', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        return $null
    }

    $bundledNodePath = Join-Path (Split-Path -Parent $CommandPath) "node.exe"
    $effectiveNodeExecutable = if (Test-Path -LiteralPath $bundledNodePath -PathType Leaf) {
        $bundledNodePath
    } else {
        $FallbackNodeExecutable
    }

    return [pscustomobject]@{
        filePath = $effectiveNodeExecutable
        argumentList = @($scriptPath) + @($PassThroughArgs)
    }
}

function Resolve-WindowsCommandLaunchSpec {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$FallbackNodeExecutable
    )

    $tokens = @(Split-CommandLineTokens -CommandText $Command)
    if ($tokens.Count -eq 0) {
        throw "Command produced no launch tokens: $Command"
    }

    $firstToken = [string]$tokens[0]
    $passThroughArgs = @($tokens | Select-Object -Skip 1)
    $resolvedTokenPath = Resolve-WindowsCommandTokenPath -Token $firstToken
    $effectiveFirstToken = if (-not [string]::IsNullOrWhiteSpace($resolvedTokenPath)) {
        $resolvedTokenPath
    } else {
        $firstToken
    }

    if ($effectiveFirstToken -match '\.(js|mjs|cjs)$') {
        return [pscustomobject]@{
            filePath = $FallbackNodeExecutable
            argumentList = @($effectiveFirstToken) + @($passThroughArgs)
        }
    }

    if ($effectiveFirstToken -match '\.(cmd|bat)$') {
        $shimLaunchSpec = Resolve-WindowsCmdShimLaunchSpec -CommandPath $effectiveFirstToken -PassThroughArgs $passThroughArgs -FallbackNodeExecutable $FallbackNodeExecutable
        if ($null -ne $shimLaunchSpec) {
            return $shimLaunchSpec
        }

        return [pscustomobject]@{
            filePath = "cmd.exe"
            argumentList = @("/d", "/s", "/c", $Command)
        }
    }

    return [pscustomobject]@{
        filePath = $effectiveFirstToken
        argumentList = $passThroughArgs
    }
}

function Resolve-ManagedRuntimeFile {
    param([Parameter(Mandatory = $true)][string[]]$RelativeCandidates)

    foreach ($basePath in @($sourceRoot, $root)) {
        foreach ($relativePath in @($RelativeCandidates)) {
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                continue
            }

            $candidate = Join-Path $basePath $relativePath
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Get-Item -LiteralPath $candidate).FullName
            }
        }
    }

    throw "Unable to resolve runtime file from candidates: $([string]::Join(', ', $RelativeCandidates))"
}

function Get-ServerCommandTemplates {
    param(
        [Parameter(Mandatory = $true)]$Server,
        [Parameter(Mandatory = $true)][string]$BaseProperty
    )

    $propertyNames = if (Test-SharedIsWindows) {
        @("${BaseProperty}CandidatesWindows", "${BaseProperty}Windows", "${BaseProperty}Candidates", $BaseProperty)
    } else {
        @("${BaseProperty}CandidatesPosix", "${BaseProperty}Posix", "${BaseProperty}Candidates", $BaseProperty)
    }

    $values = New-Object System.Collections.Generic.List[string]
    foreach ($propertyName in @($propertyNames)) {
        if ($Server.PSObject.Properties.Name -contains $propertyName) {
            $rawValue = $Server.$propertyName
            if ($rawValue -is [System.Collections.IEnumerable] -and -not ($rawValue -is [string])) {
                foreach ($item in @($rawValue)) {
                    $value = [string]$item
                    if (-not [string]::IsNullOrWhiteSpace($value)) {
                        $values.Add($value) | Out-Null
                    }
                }
                continue
            }

            $value = [string]$rawValue
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $values.Add($value) | Out-Null
            }
        }
    }

    return @($values | Select-Object -Unique)
}

function Get-CommandTemplateExecutable {
    param([AllowEmptyString()][string]$Command)

    if ([string]::IsNullOrWhiteSpace($Command)) {
        return ""
    }

    $quotedMatch = [regex]::Match($Command, '^\s*"([^"]+)"')
    if ($quotedMatch.Success) {
        return $quotedMatch.Groups[1].Value
    }

    $plainMatch = [regex]::Match($Command, '^\s*([^\s]+)')
    if ($plainMatch.Success) {
        return $plainMatch.Groups[1].Value
    }

    return ""
}

function Test-CommandTemplateAvailable {
    param([AllowEmptyString()][string]$Command)

    $executable = Get-CommandTemplateExecutable -Command $Command
    if ([string]::IsNullOrWhiteSpace($executable)) {
        return $false
    }

    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        return $true
    }

    $command = Get-Command $executable -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $command
}

function Resolve-PreferredCommandTemplate {
    param(
        [string[]]$Templates,
        $Server = $null
    )

    $resolvedTemplates = New-Object System.Collections.Generic.List[string]
    foreach ($template in @($Templates)) {
        if ([string]::IsNullOrWhiteSpace([string]$template)) {
            continue
        }
        $resolved = Resolve-CommandTemplate -Template ([string]$template) -Server $Server
        if (-not [string]::IsNullOrWhiteSpace($resolved)) {
            $resolvedTemplates.Add($resolved) | Out-Null
        }
    }

    foreach ($resolved in @($resolvedTemplates)) {
        if (Test-CommandTemplateAvailable -Command $resolved) {
            return $resolved
        }
    }

    if ($resolvedTemplates.Count -gt 0) {
        return $resolvedTemplates[0]
    }

    return ""
}

function Resolve-SharedPythonExecutable {
    $resolved = Resolve-SharedPythonRuntime -Major 3 -Minor 10
    if (-not [string]::IsNullOrWhiteSpace($resolved)) {
        return $resolved
    }

    throw "Unable to resolve a usable Python 3.10+ runtime for shared fetch/time MCP services. Set AI_MEMORY_MCP_PYTHON or AI_MEMORY_PYTHON to a working interpreter and reinstall the bundle."
}

function Resolve-SharedUvxExecutable {
    foreach ($commandName in @("uvx.exe", "uvx")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and -not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
            return [string]$command.Source
        }
    }

    return ""
}

function Resolve-SharedFetchTimeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$ModuleName,
        [Parameter(Mandatory = $true)][string]$PackageName
    )

    $python = Resolve-SharedPythonRuntime -Major 3 -Minor 10
    if (-not [string]::IsNullOrWhiteSpace($python)) {
        $probeScript = @'
import importlib.util
import sys

sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)
'@
        try {
            & $python -c $probeScript $ModuleName 1>$null 2>$null
            if ($LASTEXITCODE -eq 0) {
                return "{0} -m {1}" -f (ConvertTo-ShellLiteral $python), $ModuleName
            }
        } catch {
        }
    }

    $uvx = Resolve-SharedUvxExecutable
    if (-not [string]::IsNullOrWhiteSpace($uvx)) {
        return "{0} {1}" -f (ConvertTo-ShellLiteral $uvx), $PackageName
    }

    throw "Unable to resolve a healthy Python runtime or uvx for shared MCP package $PackageName."
}

function Resolve-CommandTemplate {
    param(
        [Parameter(Mandatory = $true)][string]$Template,
        $Server = $null
    )

    if ([string]::IsNullOrWhiteSpace($Template)) {
        return ""
    }

    $replacements = [ordered]@{
        "{{host}}" = [string]$manifest.defaults.host
        "{{port}}" = if ($null -ne $Server) { [string](Get-EffectiveServerPort -Server $Server) } else { "" }
        "{{powershell}}" = (ConvertTo-ShellLiteral (Resolve-SharedPowerShellExecutable))
        "{{node}}" = (ConvertTo-ShellLiteral (Resolve-SharedNodeExecutable))
        "{{python}}" = (ConvertTo-ShellLiteral (Resolve-SharedPythonExecutable))
        "{{obsidianRunner}}" = (ConvertTo-ShellLiteral (Resolve-ManagedRuntimeFile -RelativeCandidates @(
                    "run-obsidian-mcp.ps1",
                    (Join-Path "ops" (Join-Path "run" "run-obsidian-mcp.ps1")),
                    (Join-Path "ops" "run-obsidian-mcp.ps1")
                )))
        "{{minimaxRunner}}" = (ConvertTo-ShellLiteral (Resolve-ManagedRuntimeFile -RelativeCandidates @(
                    "run-minimax-mcp.ps1",
                    (Join-Path "ops" (Join-Path "run" "run-minimax-mcp.ps1")),
                    (Join-Path "ops" "run-minimax-mcp.ps1")
                )))
        "{{omniMemoryServer}}" = (ConvertTo-ShellLiteral (Resolve-ManagedRuntimeFile -RelativeCandidates @(
                    (Join-Path "shared-mcp" "omni-memory-server.js"),
                    "omni-memory-server.js"
                )))
    }

    $resolved = $Template
    foreach ($entry in $replacements.GetEnumerator()) {
        $resolved = $resolved.Replace([string]$entry.Key, [string]$entry.Value)
    }

    return $resolved
}

function Resolve-StdioCommand {
    param([Parameter(Mandatory = $true)]$Server)

    switch ([string]$Server.id) {
        "fetch" {
            return Resolve-SharedFetchTimeCommand -ModuleName "mcp_server_fetch" -PackageName "mcp-server-fetch"
        }
        "time" {
            return Resolve-SharedFetchTimeCommand -ModuleName "mcp_server_time" -PackageName "mcp-server-time"
        }
    }

    $templates = Get-ServerCommandTemplates -Server $Server -BaseProperty "stdioCommand"
    if (@($templates).Count -eq 0) {
        return ""
    }

    return Resolve-PreferredCommandTemplate -Templates $templates -Server $Server
}

function Resolve-LaunchCommand {
    param([Parameter(Mandatory = $true)]$Server)

    $templates = Get-ServerCommandTemplates -Server $Server -BaseProperty "launchCommand"
    if (@($templates).Count -eq 0) {
        return ""
    }

    return Resolve-PreferredCommandTemplate -Templates $templates -Server $Server
}

function Get-EnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    return Get-SharedEnvValue -Name $Name
}

function Add-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Environment,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = Get-EnvironmentValue -Name $Name
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $Environment[$Name] = $value
    }
}

function Resolve-StdioEnvironment {
    param($Server)

    $envMap = @{}
    if ([string]$Server.id -eq "MiniMax") {
        foreach ($name in @("MINIMAX_API_HOST", "MINIMAX_API_KEY", "MINIMAX_MCP_COMMAND")) {
            Add-EnvironmentValue -Environment $envMap -Name $name
        }
    }

    # I-HIGH-1 stage 3 (PR17 commit 5): 把原来只匹配 id -eq "memory" 的特殊处理
    # 扩展为匹配所有以 "memory-" 开头的 server (memory-retrieval/bridge/dream/mgmt)
    # 与 legacy "memory" 条目,统一继承 memory 专属 env 转发集合。
    if ([string]$Server.id -eq "memory" -or [string]$Server.id -like "memory-*") {
        foreach ($name in @(
                "AI_MEMORY_ROOT",
                "AI_MEMORY_PWSH",
                "AI_MEMORY_RUNTIME_CONFIG_PATH",
                "AI_MEMORY_EMBED_ADAPTER",
                "AI_MEMORY_EMBED_BACKEND",
                "AI_MEMORY_EMBED_BASE_URL",
                "AI_MEMORY_EMBED_API_KEY",
                "AI_MEMORY_EMBED_API_KEY_ENV",
                "AI_MEMORY_EMBED_MODEL",
                "AI_MEMORY_EMBED_PROFILE",
                "AI_MEMORY_EMBED_PROVIDER",
                "AI_MEMORY_EMBED_TIMEOUT_MS",
                "AI_MEMORY_EMBED_TIMEOUT_SECONDS",
                "AI_MEMORY_EMBED_REQUEST_DELAY_MS",
                "AI_MEMORY_EMBED_DELAY_MS",
                "AI_MEMORY_EMBED_BATCH_SIZE",
                "AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK",
                "AI_MEMORY_PYTHON",
                "UV_COMMAND",
                "AI_MEMORY_STORE",
                "AI_MEMORY_STORE_ROOT",
                "AI_MEMORY_OBSIDIAN_VAULT",
                "OBSIDIAN_VAULT_ROOT",
                "CLAUDE_MEM_BASE",
                "OPENCLAW_HOME",
                "OPENCLAW_BLACKBOARD_DB"
            )) {
            Add-EnvironmentValue -Environment $envMap -Name $name
        }

        # Stage 3 注入: AI_MEMORY_SERVER_MODE 与 AI_MEMORY_METRICS_PORT
        # 若用户环境未设置,回退到 manifest.json stdioEnv 默认值 (这是 4-server split 的关键)。
        foreach ($name in @("AI_MEMORY_SERVER_MODE", "AI_MEMORY_METRICS_PORT")) {
            $value = Get-EnvironmentValue -Name $name
            if ([string]::IsNullOrWhiteSpace($value) -and $Server.PSObject.Properties.Name -contains "stdioEnv" -and $null -ne $Server.stdioEnv -and $Server.stdioEnv.PSObject.Properties.Name -contains $name) {
                $value = [string]$Server.stdioEnv.$name
            }
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $envMap[$name] = $value
            }
        }
    }

    return $envMap
}

function Start-ManagedHttpProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{},
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][string]$StderrPath
    )

    if (Test-SharedIsWindows) {
        $launchSpec = Resolve-WindowsCommandLaunchSpec -Command $Command -FallbackNodeExecutable $nodeExecutable
        return Start-SharedBackgroundProcess -FilePath ([string]$launchSpec.filePath) -ArgumentList @($launchSpec.argumentList) -Environment $Environment -WorkingDirectory $root -StdoutPath $StdoutPath -StderrPath $StderrPath
    }

    return Start-SharedShellProcess -Command $Command -Environment $Environment -WorkingDirectory $root -StdoutPath $StdoutPath -StderrPath $StderrPath
}

function Start-ProxyProcess {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [hashtable]$Environment = @{},
        [Parameter(Mandatory = $true)][string]$StdoutPath,
        [Parameter(Mandatory = $true)][string]$StderrPath
    )

    if (Test-SharedIsWindows) {
        return Start-SharedBackgroundProcess `
            -FilePath $NodeExecutable `
            -ArgumentList $ArgumentList `
            -Environment $Environment `
            -WorkingDirectory $root `
            -StdoutPath $StdoutPath `
            -StderrPath $StderrPath
    }

    return Start-SharedShellProcess `
        -Command (ConvertTo-SharedProcessCommand -FilePath $NodeExecutable -ArgumentList $ArgumentList) `
        -Environment $Environment `
        -WorkingDirectory $root `
        -StdoutPath $StdoutPath `
        -StderrPath $StderrPath
}

Ensure-Directory -Path $logRoot
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json

$envBasePortRaw = [Environment]::GetEnvironmentVariable("AI_MEMORY_BASE_PORT")
$envBasePort = 0
if (-not [string]::IsNullOrWhiteSpace($envBasePortRaw)) {
    $envBasePort = [int]$envBasePortRaw
}
$manifestBasePort = $manifest.defaults.basePort
if ($envBasePort -gt 0) {
    $basePort = $envBasePort
} else {
    $basePort = $manifestBasePort
}

$nodeExecutable = Resolve-SharedNodeExecutable
$mutex = New-Object System.Threading.Mutex($false, $stateMutexName)
$mutexAcquired = $false
try {
    $mutexAcquired = $mutex.WaitOne(0)
    if (-not $mutexAcquired) {
        [pscustomobject]@{
            id = "shared-mcp"
            status = "state-lock-busy"
        } | ConvertTo-Json -Depth 4
        exit 0
    }
    $mutexAcquired = $true
} catch [System.Threading.AbandonedMutexException] {
    $mutexAcquired = $true
}

# Scavenge zombie / stale entries from state.json before starting servers.
# Iterates every recorded entry: if the PID is dead, marks it and re-probes the port.
function Clean-StateFile {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State,
        [Parameter(Mandatory = $true)]$Manifest
    )

    $dirty = $false
    $now = (Get-Date).ToString("o")

    foreach ($entry in @($State.GetEnumerator())) {
        $serverId = [string]$entry.Key
        $record = $entry.Value

        if (-not $record.ContainsKey("pid")) {
            continue
        }

        $recordedPid = [int]$record["pid"]
        if ($recordedPid -le 0) {
            continue
        }

        if (Test-PidAlive -ProcessId $recordedPid) {
            # PID is alive -- nothing to do.
            continue
        }

        # PID is dead. Mark it and re-probe the port.
        $port = 0
        # Look up effective port from manifest first so AI_MEMORY_BASE_PORT is honored
        # even when state.json was written before the base port changed.
        foreach ($srv in @($Manifest.servers)) {
            if ([string]$srv.id -eq $serverId -and $srv.PSObject.Properties.Name -contains "port") {
                $port = Get-EffectiveServerPort -Server $srv
                break
            }
        }
        if ($port -le 0 -and $record.ContainsKey("port")) {
            $port = [int]$record["port"]
        }

        $record["status"] = "dead"
        $record["notes"] = "PID $recordedPid was dead at startup, re-probing"
        $dirty = $true

        if ($port -gt 0) {
            $listenerPids = @(Get-SharedListeningProcessIds -Port $port)
            if ($listenerPids.Count -gt 0) {
                $freshPid = [int]$listenerPids[0]
                $record["pid"] = $freshPid
                $record["status"] = "adopted"
                $record["notes"] = "PID $recordedPid was dead at startup, adopted fresh PID $freshPid on port $port"
                Write-Output "[shared-mcp] State cleanup: $serverId -- dead PID $recordedPid replaced with live PID $freshPid"
            } else {
                Write-Output "[shared-mcp] State cleanup: $serverId -- dead PID $recordedPid recorded, port $port is free"
            }
        } else {
            Write-Output "[shared-mcp] State cleanup: $serverId -- dead PID $recordedPid recorded, no port to re-probe"
        }
    }

    return $dirty
}

try {
    Write-StartupLog -Message "shared-mcp startup begin (PID=$PID, logRoot=$logRoot)"
    $state = Read-State

    # Clean zombie PID entries before starting servers.
    $stateWasDirty = Clean-StateFile -State $state -Manifest $manifest
    if ($stateWasDirty) {
        Write-State -State $state
    }

    $requested = @(Normalize-RequestedIds -Ids $Only)
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($server in @($manifest.servers)) {
        if ($server.mode -eq "isolated") {
            continue
        }

        $isExplicitlyRequested = $requested.Count -gt 0 -and $requested -contains [string]$server.id
        if ($server.mode -eq "optional" -and -not $IncludeOptional -and -not $isExplicitlyRequested) {
            continue
        }
        if ($requested.Count -gt 0 -and -not $isExplicitlyRequested) {
            continue
        }

        $port = Get-EffectiveServerPort -Server $server
        $url = Get-ServerUrl -Server $server
        $healthUrl = Get-ServerHealthUrl -Server $server
        $readyTimeoutSeconds = Get-ServerReadyTimeoutSeconds -Server $server
        $startupProbeAttempts = Get-ServerStartupProbeAttempts -Server $server
        $existing = $state[[string]$server.id]
        $existingPid = 0
        if ($existing -and $existing.ContainsKey("pid")) {
            $existingPid = [int]$existing["pid"]
        }

        $listenerPids = @(Get-SharedListeningProcessIds -Port $port | Select-Object -Unique)

        if ($ForceRestart) {
            foreach ($pidToStop in @($listenerPids | Select-Object -Unique)) {
                if ([int]$pidToStop -gt 0) {
                    Stop-SharedProcessTree -ProcessId ([int]$pidToStop)
                }
            }
            Start-Sleep -Milliseconds 750
            $listenerPids = @(Get-SharedListeningProcessIds -Port $port | Select-Object -Unique)
        }

        if ($listenerPids.Count -gt 1) {
            foreach ($pidToStop in @($listenerPids | Select-Object -Unique)) {
                if ([int]$pidToStop -gt 0) {
                    Stop-SharedProcessTree -ProcessId ([int]$pidToStop)
                }
            }
            Start-Sleep -Milliseconds 750
            $listenerPids = @(Get-SharedListeningProcessIds -Port $port | Select-Object -Unique)
        }

        $listenerPid = if ($listenerPids.Count -gt 0) { [int]$listenerPids[0] } else { 0 }
        $listenerHealthy = $false
        if ($listenerPid -gt 0) {
            $listenerHealthy = Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl -TimeoutSeconds $readyTimeoutSeconds
            if (-not $listenerHealthy) {
                foreach ($pidToStop in @($listenerPids | Select-Object -Unique)) {
                    if ([int]$pidToStop -gt 0) {
                        Stop-SharedProcessTree -ProcessId ([int]$pidToStop)
                    }
                }
                Start-Sleep -Milliseconds 750
                $listenerPids = @(Get-SharedListeningProcessIds -Port $port | Select-Object -Unique)
                $listenerPid = if ($listenerPids.Count -gt 0) { [int]$listenerPids[0] } else { 0 }
                $listenerHealthy = $listenerPid -gt 0 -and (Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl -TimeoutSeconds $readyTimeoutSeconds)
            }
        }

        if ($listenerPid -le 0 -and -not $ForceRestart -and $existingPid -gt 0 -and (Test-PidAlive -ProcessId $existingPid)) {
            Stop-SharedProcessTree -ProcessId $existingPid
            Start-Sleep -Milliseconds 500
        }

        if ($listenerPid -gt 0 -and $listenerHealthy) {
            $state[[string]$server.id] = @{
                id = [string]$server.id
                pid = $listenerPid
                port = $port
                url = $url
                healthUrl = $healthUrl
                stdoutPath = if ($existing) { [string]$existing["stdoutPath"] } else { $null }
                stderrPath = if ($existing) { [string]$existing["stderrPath"] } else { $null }
                startedAt = if ($existing -and $existing.ContainsKey("startedAt")) { [string]$existing["startedAt"] } else { (Get-Date).ToString("o") }
                mode = [string]$server.mode
                status = "healthy"
                notes = [string]$server.notes
            }
            $results.Add([pscustomobject]@{
                    id = [string]$server.id
                    status = if ($existingPid -eq $listenerPid) { "already-running" } else { "adopted" }
                    pid = $listenerPid
                    url = $url
                }) | Out-Null
            continue
        }

        $stdoutPath = Join-Path $logRoot ("{0}.out.log" -f $server.id)
        $stderrPath = Join-Path $logRoot ("{0}.err.log" -f $server.id)
        $process = $null

        $launchCommand = Resolve-LaunchCommand -Server $server
        if (-not [string]::IsNullOrWhiteSpace($launchCommand)) {
            $process = Start-ManagedHttpProcess -Command $launchCommand -StdoutPath $stdoutPath -StderrPath $stderrPath
        } else {
            $resolvedCommand = Resolve-StdioCommand -Server $server
            if ([string]::IsNullOrWhiteSpace($resolvedCommand)) {
                $results.Add([pscustomobject]@{
                        id = [string]$server.id
                        status = "skipped"
                        reason = "No stdioCommand or launchCommand was configured for this platform."
                    }) | Out-Null
                continue
            }

            $resolvedEnv = Resolve-StdioEnvironment -Server $server
            if ([string]$server.id -eq "MiniMax" -and (-not $resolvedEnv.ContainsKey("MINIMAX_API_HOST") -or -not $resolvedEnv.ContainsKey("MINIMAX_API_KEY"))) {
                $results.Add([pscustomobject]@{
                        id = [string]$server.id
                        status = "skipped"
                        reason = "Set MINIMAX_API_HOST and MINIMAX_API_KEY in your user or machine environment before starting this server."
                    }) | Out-Null
                continue
            }

            $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($resolvedCommand))
            $argumentList = @(
                $proxyScriptPath,
                "--server-id", [string]$server.id,
                "--port", [string]$port,
                "--path", [string]$manifest.defaults.path,
                "--health-path", [string]$manifest.defaults.healthPath,
                "--protocol-version", "2024-11-05",
                "--stdio-command-b64", $encodedCommand
            )

            $process = Start-ProxyProcess -NodeExecutable $nodeExecutable -ArgumentList $argumentList -Environment $resolvedEnv -StdoutPath $stdoutPath -StderrPath $stderrPath
        }

        $healthy = $false
        for ($attempt = 0; $attempt -lt $startupProbeAttempts; $attempt++) {
            Start-Sleep -Seconds 1
            if (Test-ServerReady -Server $server -Url $url -HealthUrl $healthUrl -TimeoutSeconds $readyTimeoutSeconds) {
                $healthy = $true
                break
            }
        }

        $listenerPids = @(Get-SharedListeningProcessIds -Port $port)
        $listenerPid = if ($listenerPids.Count -gt 0) { [int]$listenerPids[0] } else { 0 }
        $recordPid = if ($listenerPid -gt 0) { $listenerPid } else { $process.Id }

        if (-not $healthy) {
            $pidsToStop = New-Object System.Collections.Generic.List[int]
            foreach ($pidCandidate in @(
                    $(if ($listenerPid -gt 0) { [int]$listenerPid } else { 0 }),
                    $(if ($null -ne $process -and $null -ne $process.Id) { [int]$process.Id } else { 0 })
                )) {
                if ($pidCandidate -gt 0 -and -not $pidsToStop.Contains($pidCandidate)) {
                    $pidsToStop.Add($pidCandidate) | Out-Null
                }
            }

            foreach ($pidToStop in @($pidsToStop.ToArray())) {
                Stop-SharedProcessTree -ProcessId $pidToStop
            }

            Start-Sleep -Milliseconds 750
            $remainingListenerPids = @(Get-SharedListeningProcessIds -Port $port | Sort-Object -Unique)
            [void]$state.Remove([string]$server.id)

            $results.Add([pscustomobject]@{
                    id = [string]$server.id
                    status = "failed-unhealthy"
                    pid = $recordPid
                    url = $url
                    stdoutPath = $stdoutPath
                    stderrPath = $stderrPath
                    cleaned = ($remainingListenerPids.Count -eq 0)
                    remainingPids = $remainingListenerPids
                }) | Out-Null
            continue
        }

        $state[[string]$server.id] = @{
            id = [string]$server.id
            pid = $recordPid
            port = $port
            url = $url
            healthUrl = $healthUrl
            stdoutPath = $stdoutPath
            stderrPath = $stderrPath
            startedAt = (Get-Date).ToString("o")
            mode = [string]$server.mode
            status = "healthy"
            notes = [string]$server.notes
        }

        $results.Add([pscustomobject]@{
                id = [string]$server.id
                status = "started"
                pid = $recordPid
                url = $url
                stdoutPath = $stdoutPath
                stderrPath = $stderrPath
            }) | Out-Null
    }

    Write-State -State $state
    $results | ConvertTo-Json -Depth 6
    if (@($results | Where-Object { @("started", "already-running", "adopted") -notcontains [string]$_.status }).Count -gt 0) {
        Write-StartupLog -Message "shared-mcp startup completed with failures" -Level "WARN"
        exit 1
    }
    Write-StartupLog -Message "shared-mcp startup completed successfully"
} catch {
    # Write crash log with full exception details so users never see a blank window.
    try {
        $crashLogPath = if (Get-Command Get-CrashLogPath -ErrorAction SilentlyContinue) {
            Get-CrashLogPath
        } else {
            Join-Path $logRoot ("crash-{0}.log" -f (Get-Date -Format "yyyy-MM-ddTHH-mm-ss"))
        }
        $crashContent = @(
            "=== Crash Report ===",
            "Timestamp: $(Get-Date -Format 'o')",
            "PID: $PID",
            "Script: $($MyInvocation.MyCommand.Path)",
            "Error: $($_.Exception.Message)",
            "Type: $($_.Exception.GetType().FullName)",
            "",
            "ScriptStackTrace:",
            "$($_.ScriptStackTrace)"
        ) -join "`n"
        Add-Content -Path $crashLogPath -Value $crashContent -Encoding UTF8
        Write-StartupLog -Message "CRASH: $($_.Exception.Message)" -Level "CRASH"
        Write-Error "[shared-mcp] Startup failed. Crash log: $crashLogPath"
    } catch {
        Write-Error "[shared-mcp] Startup failed: $($_.Exception.Message)"
    }
    exit 1
} finally {
    if ($mutexAcquired) {
        try {
            [void]$mutex.ReleaseMutex()
        } catch {
        }
    }
    $mutex.Dispose()
}
