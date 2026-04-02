param(
    [string]$AiMemoryRoot = "",
    [string]$WorkspaceRoot = "",
    [int]$Waves = 5,
    [int]$TimeoutSeconds = 30,
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

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "JSON file not found: $Path"
    }

    $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "JSON file was empty: $Path"
    }

    return ($content | ConvertFrom-Json)
}

function Write-TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Get-SharedStatus {
    param([Parameter(Mandatory = $true)][string]$ScriptPath)

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "Shared MCP status script not found: $ScriptPath"
    }

    return (Invoke-SharedPowerShellFile -ScriptPath $ScriptPath | ConvertFrom-Json)
}

function Get-ListenerSnapshot {
    param([Parameter(Mandatory = $true)][int[]]$Ports)

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($port in $Ports) {
        $pids = @(Get-SharedListeningProcessIds -Port $port | Sort-Object -Unique)
        $records.Add([pscustomobject]@{
            port = $port
            listenerCount = $pids.Count
            pids = $pids
        }) | Out-Null
    }

    return $records.ToArray()
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
    $healthIndex = $text.IndexOf("Checking MCP server health")
    if ($healthIndex -gt 0) {
        $text = $text.Substring($healthIndex).Trim()
    }
    return [pscustomobject]@{
        command = (($Executable + " " + ($Arguments -join " ")).Trim())
        workdir = $WorkingDirectory
        exitCode = $exitCode
        output = $text
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

if ($Waves -lt 1) {
    throw "-Waves must be >= 1"
}

$manifestPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "manifest.json")
$statusScriptPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "status-shared-mcp.ps1")
$reportRoot = Join-Path $AiMemoryRoot "reports"
Ensure-Directory -Path $reportRoot

$manifest = Read-JsonFile -Path $manifestPath
$sharedServers = @($manifest.servers | Where-Object { $_.mode -eq "shared" })
if ($sharedServers.Count -eq 0) {
    throw "No shared servers were declared in $manifestPath"
}

$baselineStatus = @(Get-SharedStatus -ScriptPath $statusScriptPath)
$ports = @($sharedServers | Where-Object { $null -ne $_.port } | ForEach-Object { [int]$_.port })
$baselineListeners = @(Get-ListenerSnapshot -Ports $ports)

$jobScript = {
    param(
        [string]$ServerId,
        [string]$Url,
        [string]$HealthUrl,
        [int]$Wave,
        [int]$TimeoutSeconds
    )

    $result = [ordered]@{
        serverId = $ServerId
        wave = $Wave
        healthOk = $false
        initializeOk = $false
        toolsListOk = $false
        toolCount = 0
        durationMs = 0
        errors = @()
    }

    $started = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec $TimeoutSeconds
        if ($null -ne $health -and $health.ok) {
            $result.healthOk = $true
        } else {
            $result.errors += "health-not-ok"
        }
    } catch {
        $result.errors += ("health-failed: " + $_.Exception.Message)
    }

    $initializePayload = @{
        jsonrpc = "2.0"
        id = "init-$Wave-$ServerId"
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
                name = "shared-stack-pressure-test"
                version = "1.0.0"
            }
        }
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $initializeResponse = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Body $initializePayload
        if ($null -eq $initializeResponse.error) {
            $result.initializeOk = $true
        } else {
            $result.errors += ("initialize-error: " + [string]$initializeResponse.error.message)
        }
    } catch {
        $result.errors += ("initialize-failed: " + $_.Exception.Message)
    }

    $toolsPayload = @{
        jsonrpc = "2.0"
        id = "tools-$Wave-$ServerId"
        method = "tools/list"
        params = @{}
    } | ConvertTo-Json -Depth 6 -Compress

    try {
        $toolsResponse = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Body $toolsPayload
        if ($null -eq $toolsResponse.error) {
            $tools = @()
            if ($null -ne $toolsResponse.result -and $null -ne $toolsResponse.result.tools) {
                $tools = @($toolsResponse.result.tools)
            }
            $result.toolsListOk = $true
            $result.toolCount = $tools.Count
        } else {
            $result.errors += ("tools-list-error: " + [string]$toolsResponse.error.message)
        }
    } catch {
        $result.errors += ("tools-list-failed: " + $_.Exception.Message)
    }

    $started.Stop()
    $result.durationMs = [int][Math]::Round($started.Elapsed.TotalMilliseconds)
    [pscustomobject]$result
}

$jobs = New-Object System.Collections.Generic.List[object]
foreach ($wave in 1..$Waves) {
    foreach ($server in $sharedServers) {
        $jobs.Add((Start-Job -ScriptBlock $jobScript -ArgumentList @(
            [string]$server.id,
            [string]("http://127.0.0.1:{0}{1}" -f $server.port, $manifest.defaults.path),
            [string]("http://127.0.0.1:{0}{1}" -f $server.port, $manifest.defaults.healthPath),
            [int]$wave,
            [int]$TimeoutSeconds
        ))) | Out-Null
    }
}

$null = Wait-Job -Job $jobs -Timeout ([Math]::Max(60, ($Waves * 30)))
$results = @($jobs | Receive-Job)
$jobs | Remove-Job -Force | Out-Null

$finalStatus = @(Get-SharedStatus -ScriptPath $statusScriptPath)
$finalListeners = @(Get-ListenerSnapshot -Ports $ports)

$cliChecks = @()
if ($RunCliChecks) {
    $codexExe = Resolve-PreferredExecutable -Name "codex"
    $opencodeExe = Resolve-PreferredExecutable -Name "opencode"
    $claudeExe = Resolve-PreferredExecutable -Name "claude"
    $codexWorkdir = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $PWD.Path } else { $WorkspaceRoot }
    $opencodeWorkdir = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $PWD.Path } else { $WorkspaceRoot }
    $claudeWorkdir = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $PWD.Path } else { $WorkspaceRoot }

    $cliChecks += Invoke-CliCheck -Executable $codexExe -Arguments @("mcp", "list") -WorkingDirectory $codexWorkdir
    $cliChecks += Invoke-CliCheck -Executable $opencodeExe -Arguments @("mcp", "list") -WorkingDirectory $opencodeWorkdir
    $cliChecks += Invoke-CliCheck -Executable $claudeExe -Arguments @("mcp", "list") -WorkingDirectory $claudeWorkdir
}

$baselinePidMap = @{}
foreach ($item in $baselineStatus) {
    $baselinePidMap[[string]$item.id] = [int]$item.pid
}

$finalPidChecks = @()
foreach ($item in $finalStatus) {
    if ($item.mode -ne "shared") {
        continue
    }

    $baselinePid = if ($baselinePidMap.ContainsKey([string]$item.id)) { [int]$baselinePidMap[[string]$item.id] } else { 0 }
    $finalPidChecks += [pscustomobject]@{
        id = [string]$item.id
        baselinePid = $baselinePid
        finalPid = [int]$item.pid
        samePid = ($baselinePid -eq [int]$item.pid)
        running = [bool]$item.running
    }
}

$failedResults = @($results | Where-Object { -not ($_.healthOk -and $_.initializeOk -and $_.toolsListOk) })
$singleListenerPerPort = (@($finalListeners | Where-Object { $_.listenerCount -ne 1 }).Count -eq 0)
$allSharedRunning = (@($finalStatus | Where-Object { $_.mode -eq "shared" -and -not $_.running }).Count -eq 0)
$allPidsStable = (@($finalPidChecks | Where-Object { -not $_.samePid }).Count -eq 0)
$cliFailures = @(
    $cliChecks | Where-Object {
        $_.exitCode -ne 0 -or
        $_.hasLocalContext7 -or
        $_.hasLocalMemory -or
        (-not $_.hasSharedContext7Url) -or
        (-not $_.hasSharedObsidianUrl) -or
        (-not $_.hasSharedMemoryUrl)
    }
)
$cliAllPass = ($cliFailures.Count -eq 0)

$report = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    aiMemoryRoot = $AiMemoryRoot
    workspaceRoot = $WorkspaceRoot
    parameters = [ordered]@{
        waves = $Waves
        timeoutSeconds = $TimeoutSeconds
        runCliChecks = [bool]$RunCliChecks
    }
    sharedServers = @($sharedServers | Select-Object id, displayName, mode, port)
    baselineStatus = $baselineStatus
    baselineListeners = $baselineListeners
    requestResults = @($results | Sort-Object wave, serverId)
    finalStatus = $finalStatus
    finalListeners = $finalListeners
    pidChecks = $finalPidChecks
    cliChecks = $cliChecks
    summary = [ordered]@{
        totalRequests = @($results).Count
        failedRequests = $failedResults.Count
        successRequests = (@($results).Count - $failedResults.Count)
        allSharedRunning = $allSharedRunning
        singleListenerPerPort = $singleListenerPerPort
        allPidsStable = $allPidsStable
        cliAllPass = $cliAllPass
        overallPass = ($failedResults.Count -eq 0 -and $allSharedRunning -and $singleListenerPerPort -and (-not $RunCliChecks -or $cliAllPass))
    }
}

$jsonPath = Join-Path $reportRoot "shared-stack-pressure.last.json"
$mdPath = Join-Path $reportRoot "shared-stack-pressure.last.md"

$jsonBody = ($report | ConvertTo-Json -Depth 12).Trim() + "`n"
Write-TextFile -Path $jsonPath -Content $jsonBody

$failedSummary = if ($failedResults.Count -gt 0) {
    [string]::Join("`n", @($failedResults | Select-Object -First 12 | ForEach-Object {
        "- wave $($_.wave) / $($_.serverId): $([string]::Join('; ', @($_.errors)))"
    }))
} else {
    "(none)"
}

$listenerSummary = [string]::Join("`n", @($finalListeners | ForEach-Object {
    "- port $($_.port): listeners=$($_.listenerCount), pids=$([string]::Join(',', @($_.pids)))"
}))

$pidSummary = [string]::Join("`n", @($finalPidChecks | ForEach-Object {
    "- $($_.id): baseline=$($_.baselinePid), final=$($_.finalPid), samePid=$($_.samePid), running=$($_.running)"
}))

$cliSummary = if ($cliChecks.Count -gt 0) {
    [string]::Join("`n", @($cliChecks | ForEach-Object {
        "- exit=$($_.exitCode) :: $($_.command) :: shared-context7=$($_.hasSharedContext7Url) :: shared-obsidian=$($_.hasSharedObsidianUrl) :: shared-memory=$($_.hasSharedMemoryUrl) :: local-context7=$($_.hasLocalContext7) :: local-memory=$($_.hasLocalMemory)"
    }))
} else {
    "(skipped)"
}

$mdBody = @"
# Shared Stack Pressure Test

- Generated at: $($report.generatedAt)
- Waves: $Waves
- Total requests: $($report.summary.totalRequests)
- Failed requests: $($report.summary.failedRequests)
- Overall pass: $($report.summary.overallPass)

## Shared Server Result
- All shared running: $($report.summary.allSharedRunning)
- Single listener per port: $($report.summary.singleListenerPerPort)
- Shared PIDs stable: $($report.summary.allPidsStable)
- CLI checks pass: $($report.summary.cliAllPass)

## Listener Snapshot
$listenerSummary

## PID Snapshot
$pidSummary

## Failed Requests
$failedSummary

## CLI Checks
$cliSummary

## JSON Report
$jsonPath
"@

Write-TextFile -Path $mdPath -Content ($mdBody.Trim() + "`n")

$report | ConvertTo-Json -Depth 12
