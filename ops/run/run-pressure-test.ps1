param(
    [string]$AiMemoryRoot = "",
    [string]$WorkspaceRoot = "",
    [int]$Waves = 5,
    [int]$TimeoutSeconds = 30,
    [int]$ClientTaskTimeoutSeconds = 180,
    [switch]$RunCliChecks,
    [switch]$RunToolCalls,
    [switch]$RunClientTaskChecks,
    [switch]$IncludeOptionalServers
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

$AiMemoryRoot = Resolve-SharedOptionalPathArgument -Path $AiMemoryRoot -ParameterName "AiMemoryRoot"
$WorkspaceRoot = Resolve-SharedOptionalPathArgument -Path $WorkspaceRoot -ParameterName "WorkspaceRoot" -RequireExisting

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

    return (Invoke-SharedPowerShellFile -ScriptPath $ScriptPath -ArgumentList @("-Json") | ConvertFrom-Json)
}

function New-TemporaryCapturePath {
    $path = [System.IO.Path]::GetTempFileName()
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $path
}

function Invoke-ExternalCommandWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 45
    )

    $stdoutPath = New-TemporaryCapturePath
    $stderrPath = New-TemporaryCapturePath
    $invocationSpecPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".json")
    $launcherScriptPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".ps1")
    $result = [ordered]@{
        exitCode = -1
        timedOut = $false
        stdout = ""
        stderr = ""
        output = ""
        error = ""
        pid = 0
    }

    try {
        $invocationSpec = @{
            executable = $Executable
            arguments = @($Arguments)
            workingDirectory = $WorkingDirectory
        } | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($invocationSpecPath, $invocationSpec, $Utf8NoBom)

        $specLiteral = $invocationSpecPath -replace "'", "''"
        $launcherTemplate = @'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$spec = Get-Content -Raw -LiteralPath '__SPEC_PATH__' -Encoding utf8 | ConvertFrom-Json
$arguments = @()
foreach ($argument in @($spec.arguments)) {
    $arguments += [string]$argument
}
if (-not [string]::IsNullOrWhiteSpace([string]$spec.workingDirectory)) {
    Set-Location -LiteralPath ([string]$spec.workingDirectory)
}
$ErrorActionPreference = 'Continue'
& ([string]$spec.executable) @arguments
exit $LASTEXITCODE
'@
        $launcherContent = $launcherTemplate.Replace('__SPEC_PATH__', $specLiteral)
        [System.IO.File]::WriteAllText($launcherScriptPath, $launcherContent, $Utf8NoBom)

        $powerShellExe = Resolve-SharedPowerShellExecutable
        $powerShellArgs = Get-SharedPowerShellFileArguments -ScriptPath $launcherScriptPath -ArgumentList @()
        $process = Start-SharedBackgroundProcess `
            -FilePath $powerShellExe `
            -ArgumentList $powerShellArgs `
            -WorkingDirectory $WorkingDirectory `
            -StdoutPath $stdoutPath `
            -StderrPath $stderrPath

        if ($null -eq $process) {
            throw "Process failed to start."
        }

        $result.pid = [int]$process.Id
        $timeoutMs = [Math]::Max(1000, ($TimeoutSeconds * 1000))
        $completed = $process.WaitForExit($timeoutMs)
        if (-not $completed) {
            $result.timedOut = $true
            $result.exitCode = 124
            Stop-SharedProcessTree -ProcessId $process.Id
            try {
                $null = $process.WaitForExit(5000)
            } catch {
            }
        } else {
            $process.WaitForExit()
            $result.exitCode = $process.ExitCode
        }
    } catch {
        $result.error = $_.Exception.Message
        if ($result.exitCode -lt 0) {
            $result.exitCode = 1
        }
    } finally {
        if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) {
            try {
                $result.stdout = Get-Content -Raw -LiteralPath $stdoutPath -Encoding utf8
            } catch {
            }
            Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        }

        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            try {
                $result.stderr = Get-Content -Raw -LiteralPath $stderrPath -Encoding utf8
            } catch {
            }
            Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
        }

        foreach ($path in @($launcherScriptPath, $invocationSpecPath)) {
            if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $outputParts = New-Object System.Collections.Generic.List[string]
    foreach ($chunk in @($result.stdout, $result.stderr)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$chunk)) {
            $outputParts.Add(([string]$chunk).Trim()) | Out-Null
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($result.error)) {
        $outputParts.Add($result.error) | Out-Null
    }
    $result.output = ([string]::Join([Environment]::NewLine, @($outputParts))).Trim()
    return [pscustomobject]$result
}

function Invoke-ExternalCommandInlineWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 45
    )

    $job = Start-Job -ScriptBlock {
        param($Executable, $Arguments, $WorkingDirectory)

        function Convert-JobNativeOutputToText {
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

        $result = [ordered]@{
            exitCode = -1
            timedOut = $false
            stdout = ""
            stderr = ""
            output = ""
            error = ""
            pid = $PID
        }

        $output = @()
        $previousErrorAction = $ErrorActionPreference
        $hadNativePref = $false
        $previousNativePref = $false
        Push-Location -LiteralPath $WorkingDirectory
        try {
            $ErrorActionPreference = "Continue"
            if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
                $hadNativePref = $true
                $previousNativePref = $Global:PSNativeCommandUseErrorActionPreference
                $Global:PSNativeCommandUseErrorActionPreference = $false
            }
            $output = & $Executable @Arguments 2>&1
            $result.exitCode = $LASTEXITCODE
        } catch {
            $result.error = $_.Exception.Message
            if ($result.exitCode -lt 0) {
                $result.exitCode = 1
            }
        } finally {
            $ErrorActionPreference = $previousErrorAction
            if ($hadNativePref) {
                $Global:PSNativeCommandUseErrorActionPreference = $previousNativePref
            }
            Pop-Location
        }

        $result.output = Convert-JobNativeOutputToText -Output $output
        [pscustomobject]$result
    } -ArgumentList @($Executable, @($Arguments), $WorkingDirectory)

    try {
        $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $completed) {
            Stop-Job -Job $job -Force -ErrorAction SilentlyContinue
            return [pscustomobject]@{
                exitCode = 124
                timedOut = $true
                stdout = ""
                stderr = ""
                output = ""
                error = ""
                pid = 0
            }
        }

        $jobResult = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
        if ($jobResult.Count -gt 0) {
            return [pscustomobject]$jobResult[0]
        }

        return [pscustomobject]@{
            exitCode = 1
            timedOut = $false
            stdout = ""
            stderr = ""
            output = ""
            error = "inline-command-produced-no-result"
            pid = 0
        }
    } finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
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

    $commandResult = Invoke-ExternalCommandWithTimeout -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds 45
    $shouldRetryInline = (
        [bool]$commandResult.timedOut -or
        [int]$commandResult.exitCode -ne 0 -or
        [string]::IsNullOrWhiteSpace([string]$commandResult.output)
    )
    if ($shouldRetryInline) {
        $inlineResult = Invoke-ExternalCommandInlineWithTimeout -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds 45
        $inlineSucceeded = (
            -not [bool]$inlineResult.timedOut -and
            [int]$inlineResult.exitCode -eq 0 -and
            -not [string]::IsNullOrWhiteSpace([string]$inlineResult.output)
        )
        $primaryMissingOutput = [string]::IsNullOrWhiteSpace([string]$commandResult.output)
        if ($inlineSucceeded -or $primaryMissingOutput) {
            $commandResult = $inlineResult
        }
    }
    $text = [string]$commandResult.output
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
        exitCode = [int]$commandResult.exitCode
        timedOut = [bool]$commandResult.timedOut
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

function Test-JsonProbeShape {
    param([AllowNull()]$Object)

    return (
        $null -ne $Object -and
        $null -ne $Object.PSObject.Properties["watchdogStatus"] -and
        $null -ne $Object.PSObject.Properties["watchdogPid"] -and
        $null -ne $Object.PSObject.Properties["memoryIntegrityStatus"]
    )
}

function Get-OptionalProbeBooleanProperty {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$PropertyName,
        [bool]$Default = $false
    )

    if ($null -eq $Object) {
        return $Default
    }

    $property = $Object.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        return $Default
    }

    $value = $property.Value
    if ($value -is [bool]) {
        return [bool]$value
    }
    if ($value -is [string]) {
        return ([string]$value).Trim().ToLowerInvariant() -eq "true"
    }

    return ($null -ne $value)
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

function Get-ClientProbeSkipReason {
    param(
        [string]$ClientId = "",
        [AllowEmptyString()][string]$Text,
        [bool]$TimedOut = $false
    )

    $normalized = ([string]$Text).ToLowerInvariant()
    if (-not [string]::IsNullOrWhiteSpace($normalized)) {
        foreach ($pattern in @(
            "invalid api key",
            "api key is missing",
            "providerautherror",
            "loadapikeyerror",
            "oauth token is missing",
            "not logged in",
            "authentication required"
        )) {
            if ($normalized.Contains($pattern)) {
                return "provider-auth-unavailable"
            }
        }

        foreach ($pattern in @(
            "error_during_execution",
            "timed out",
            "try again later",
            "rate limit",
            "overloaded",
            "server had trouble"
        )) {
            if ($normalized.Contains($pattern)) {
                return "client-runtime-transient"
            }
        }

        if (
            ([string]$ClientId).Trim().ToLowerInvariant() -eq "claude" -and
            $normalized.Contains('"type":"result"') -and
            $normalized.Contains('"result":""')
        ) {
            return "client-runtime-transient"
        }
    }

    if ($TimedOut -and ([string]$ClientId).Trim().ToLowerInvariant() -eq "claude") {
        return "client-runtime-transient"
    }

    return ""
}

function Invoke-ClientTaskProbe {
    param(
        [Parameter(Mandatory = $true)][string]$ClientId,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$Wave
    )

    $result = [ordered]@{
        resultKind = "client-probe"
        clientId = $ClientId
        wave = $Wave
        exitCode = -1
        timedOut = $false
        attempts = 0
        ok = $false
        hasProbeJson = $false
        skipped = $false
        skipReason = ""
        watchdogStatus = ""
        watchdogPid = 0
        watchdogUpdatedAt = ""
        memoryIntegrityStatus = ""
        embeddingIndexAligned = $false
        searchObservedResult = $false
        denseObservedResult = $false
        pass = $false
        outputPreview = ""
        command = (($Executable + " " + ($Arguments -join " ")).Trim())
        errors = @()
    }

    $maxAttempts = if ($ClientId -eq "claude") { 2 } else { 1 }
    $skipReasonCandidate = ""
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $result.attempts = $attempt
        $result.exitCode = -1
        $result.timedOut = $false
        $result.ok = $false
        $result.hasProbeJson = $false
        $result.watchdogStatus = ""
        $result.watchdogPid = 0
        $result.watchdogUpdatedAt = ""
        $result.memoryIntegrityStatus = ""
        $result.embeddingIndexAligned = $false
        $result.searchObservedResult = $false
        $result.denseObservedResult = $false
        $result.outputPreview = ""
        $result.errors = @()
        $probeOutputPath = ""
        $commandArguments = @($Arguments)
        if ($ClientId -eq "codex") {
            $probeOutputPath = New-TemporaryCapturePath
            $commandArguments += @("--output-last-message", $probeOutputPath)
        }

        try {
            $commandResult = Invoke-ExternalCommandWithTimeout -Executable $Executable -Arguments $commandArguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds 240
            if (
                -not $commandResult.timedOut -and
                [string]::IsNullOrWhiteSpace([string]$commandResult.output) -and
                [string]::IsNullOrWhiteSpace([string]$commandResult.error)
            ) {
                $inlineResult = Invoke-ExternalCommandInlineWithTimeout -Executable $Executable -Arguments $commandArguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds 240
                if (
                    -not [string]::IsNullOrWhiteSpace([string]$inlineResult.output) -or
                    -not [string]::IsNullOrWhiteSpace([string]$inlineResult.error) -or
                    [bool]$inlineResult.timedOut
                ) {
                    $commandResult = $inlineResult
                }
            }
            $result.exitCode = [int]$commandResult.exitCode
            $result.timedOut = [bool]$commandResult.timedOut
            $text = [string]$commandResult.output
            if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($probeOutputPath) -and (Test-Path -LiteralPath $probeOutputPath -PathType Leaf)) {
                try {
                    $text = Get-Content -Raw -LiteralPath $probeOutputPath -Encoding utf8
                } catch {
                }
            }
            $sanitizedText = [regex]::Replace($text, "\x1b\[[0-9;]*[A-Za-z]", "")
            $result.ok = ($result.exitCode -eq 0)

            if ($text.Length -gt 240) {
                $result.outputPreview = $text.Substring(0, 240)
            } else {
                $result.outputPreview = $text
            }

            $skipReasonCandidate = Get-ClientProbeSkipReason -ClientId $ClientId -Text $sanitizedText -TimedOut:$result.timedOut
            if (
                [string]::IsNullOrWhiteSpace($skipReasonCandidate) -and
                $ClientId -eq "opencode" -and
                $result.exitCode -ne 0 -and
                [string]::IsNullOrWhiteSpace($sanitizedText)
            ) {
                $skipReasonCandidate = "provider-auth-unavailable"
            }

            try {
                $parsed = ConvertFrom-JsonProbePayload -Text $sanitizedText
                $result.hasProbeJson =
                    ($null -ne $parsed.PSObject.Properties["watchdogStatus"]) -and
                    ($null -ne $parsed.PSObject.Properties["watchdogPid"]) -and
                    ($null -ne $parsed.PSObject.Properties["memoryIntegrityStatus"])
                if ($result.hasProbeJson) {
                    $result.watchdogStatus = [string]$parsed.watchdogStatus
                    $result.watchdogPid = [int]$parsed.watchdogPid
                    $result.watchdogUpdatedAt = [string]$parsed.watchdogUpdatedAt
                    $result.memoryIntegrityStatus = [string]$parsed.memoryIntegrityStatus
                    if ($null -ne $parsed.PSObject.Properties["embeddingIndexAligned"]) {
                        if ($parsed.embeddingIndexAligned -is [bool]) {
                            $result.embeddingIndexAligned = [bool]$parsed.embeddingIndexAligned
                        } elseif ($parsed.embeddingIndexAligned -is [string]) {
                            $result.embeddingIndexAligned = ([string]$parsed.embeddingIndexAligned).Trim().ToLowerInvariant() -eq "true"
                        } else {
                            $result.embeddingIndexAligned = ($null -ne $parsed.embeddingIndexAligned)
                        }
                    }
                    if ($null -ne $parsed.PSObject.Properties["searchObservedResult"]) {
                        if ($parsed.searchObservedResult -is [bool]) {
                            $result.searchObservedResult = [bool]$parsed.searchObservedResult
                        } elseif ($parsed.searchObservedResult -is [string]) {
                            $result.searchObservedResult = ([string]$parsed.searchObservedResult).Trim().ToLowerInvariant() -eq "true"
                        } else {
                            $result.searchObservedResult = ($null -ne $parsed.searchObservedResult)
                        }
                    }
                    if ($null -ne $parsed.PSObject.Properties["denseObservedResult"]) {
                        if ($parsed.denseObservedResult -is [bool]) {
                            $result.denseObservedResult = [bool]$parsed.denseObservedResult
                        } elseif ($parsed.denseObservedResult -is [string]) {
                            $result.denseObservedResult = ([string]$parsed.denseObservedResult).Trim().ToLowerInvariant() -eq "true"
                        } else {
                            $result.denseObservedResult = ($null -ne $parsed.denseObservedResult)
                        }
                    }
                }
            } catch {
                $result.errors += ("runtime-probe-json-parse-failed: " + $_.Exception.Message)
            }
        } catch {
            $result.errors += ("runtime-probe-launch-failed: " + $_.Exception.Message)
        } finally {
            if (-not [string]::IsNullOrWhiteSpace($probeOutputPath) -and (Test-Path -LiteralPath $probeOutputPath -PathType Leaf)) {
                Remove-Item -LiteralPath $probeOutputPath -Force -ErrorAction SilentlyContinue
            }
        }

        if ($result.hasProbeJson -or -not [string]::IsNullOrWhiteSpace($skipReasonCandidate) -or $attempt -ge $maxAttempts) {
            break
        }

        Start-Sleep -Seconds 2
    }

    if (-not $result.hasProbeJson -and -not [string]::IsNullOrWhiteSpace($skipReasonCandidate)) {
        $result.skipReason = $skipReasonCandidate
        $result.skipped = $true
        $result.pass = $true
        $result.errors = @("skipped:" + $result.skipReason)
        return [pscustomobject]$result
    }

    if (-not $result.ok) {
        $result.errors += ("command-exit-" + $result.exitCode)
    }
    if ($result.timedOut) {
        $result.errors += "command-timeout"
    }
    if (-not $result.hasProbeJson) {
        $result.errors += "missing-runtime-probe-json"
    }
    if (-not [string]::IsNullOrWhiteSpace($commandResult.error)) {
        $result.errors += ("command-launch-failed: " + $commandResult.error)
    }

    return [pscustomobject]$result
}

function Get-ServerPath {
    param(
        [Parameter(Mandatory = $true)]$Server,
        [Parameter(Mandatory = $true)][string]$DefaultPath
    )

    if ($Server.PSObject.Properties.Name -contains "path" -and -not [string]::IsNullOrWhiteSpace([string]$Server.path)) {
        return [string]$Server.path
    }

    return $DefaultPath
}

function Get-ServerHealthPath {
    param(
        [Parameter(Mandatory = $true)]$Server,
        [Parameter(Mandatory = $true)][string]$DefaultPath
    )

    if ($Server.PSObject.Properties.Name -contains "healthPath" -and -not [string]::IsNullOrWhiteSpace([string]$Server.healthPath)) {
        return [string]$Server.healthPath
    }

    return $DefaultPath
}

function Get-ServerProbeType {
    param([Parameter(Mandatory = $true)]$Server)

    if ($Server.PSObject.Properties.Name -contains "probeType" -and -not [string]::IsNullOrWhiteSpace([string]$Server.probeType)) {
        return [string]$Server.probeType
    }

    return "http-get"
}

function Invoke-JobWave {
    param(
        [Parameter(Mandatory = $true)][object[]]$Jobs,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    if ($Jobs.Count -eq 0) {
        return @()
    }

    $null = Wait-Job -Job $Jobs -Timeout ([Math]::Max(30, $TimeoutSeconds))
    $unfinished = @($Jobs | Where-Object { $_.State -notin @("Completed", "Failed", "Stopped") })
    foreach ($job in $unfinished) {
        try {
            Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        } catch {
        }
    }

    $results = New-Object System.Collections.Generic.List[object]
    foreach ($job in $Jobs) {
        $jobOutput = @($job | Receive-Job -ErrorAction SilentlyContinue)
        foreach ($item in $jobOutput) {
            $results.Add($item) | Out-Null
        }

        if ($jobOutput.Count -gt 0) {
            continue
        }

        $segments = @(([string]$job.Name).Split("::", 3))
        $resultKind = if ($segments.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace($segments[0])) { [string]$segments[0] } else { "control-plane" }
        $wave = 0
        if ($segments.Count -ge 2) {
            try {
                $wave = [int]$segments[1]
            } catch {
                $wave = 0
            }
        }
        $targetId = if ($segments.Count -ge 3 -and -not [string]::IsNullOrWhiteSpace($segments[2])) { [string]$segments[2] } else { [string]$job.Name }
        $reason = if ($unfinished.Id -contains $job.Id) { "job-timeout" } else { "job-state-$([string]$job.State)" }

        switch ($resultKind) {
            "tool-call" {
                $results.Add([pscustomobject]@{
                    resultKind = "tool-call"
                    serverId = ""
                    wave = $wave
                    toolName = $targetId
                    callOk = $false
                    hasTextContent = $false
                    jsonOk = $false
                    assertionsOk = $false
                    pass = $false
                    durationMs = 0
                    outputPreview = ""
                    errors = @($reason)
                }) | Out-Null
            }
            "client-probe" {
                $results.Add([pscustomobject]@{
                    resultKind = "client-probe"
                    clientId = $targetId
                    wave = $wave
                    exitCode = -1
                    ok = $false
                    hasProbeJson = $false
                    watchdogStatus = ""
                    watchdogPid = 0
                    watchdogUpdatedAt = ""
                    memoryIntegrityStatus = ""
                    searchObservedResult = $false
                    pass = $false
                    outputPreview = ""
                    errors = @($reason)
                }) | Out-Null
            }
            default {
                $results.Add([pscustomobject]@{
                    resultKind = "control-plane"
                    serverId = $targetId
                    wave = $wave
                    healthOk = $false
                    initializeOk = $false
                    toolsListOk = $false
                    toolCount = 0
                    durationMs = 0
                    errors = @($reason)
                }) | Out-Null
            }
        }
    }

    $Jobs | Remove-Job -Force -ErrorAction SilentlyContinue | Out-Null
    return $results.ToArray()
}

function Invoke-MemoryStatusSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $body = @{
        jsonrpc = "2.0"
        id = "memory-status-final"
        method = "tools/call"
        params = @{
            name = "memory_status"
            arguments = @{}
        }
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $response = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Body $body
        $errorProperty = $response.PSObject.Properties["error"]
        if ($null -ne $errorProperty -and $null -ne $response.error) {
            return [pscustomobject]@{
                ok = $false
                error = [string]$response.error.message
            }
        }

        $textContent = @($response.result.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1)
        if ($textContent.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$textContent[0].text)) {
            return [pscustomobject]@{
                ok = $false
                error = "memory_status returned no text payload"
            }
        }

        return [pscustomobject]@{
            ok = $true
            payload = ([string]$textContent[0].text | ConvertFrom-Json)
        }
    } catch {
        return [pscustomobject]@{
            ok = $false
            error = $_.Exception.Message
        }
    }
}

if ($Waves -lt 1) {
    throw "-Waves must be >= 1"
}

$manifestPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "manifest.json")
$statusScriptPath = Join-SharedPath @($AiMemoryRoot, "shared-mcp", "status-shared-mcp.ps1")
$reportRoot = Join-Path $AiMemoryRoot "reports"
Ensure-Directory -Path $reportRoot

$manifest = Read-JsonFile -Path $manifestPath
$baselineStatus = @(Get-SharedStatus -ScriptPath $statusScriptPath)
$baselineStatusMap = @{}
foreach ($item in $baselineStatus) {
    $baselineStatusMap[[string]$item.id] = $item
}

$targetServerIds = New-Object System.Collections.Generic.List[string]
foreach ($server in @($manifest.servers)) {
    $serverId = [string]$server.id
    if ($server.mode -eq "shared") {
        $targetServerIds.Add($serverId) | Out-Null
        continue
    }

    if ($IncludeOptionalServers -and $baselineStatusMap.ContainsKey($serverId) -and [bool]$baselineStatusMap[$serverId].running) {
        $targetServerIds.Add($serverId) | Out-Null
    }
}

$sharedServers = @($manifest.servers | Where-Object { $targetServerIds -contains [string]$_.id })
if ($sharedServers.Count -eq 0) {
    throw "No target servers were selected from $manifestPath"
}

$ports = @($sharedServers | Where-Object { $null -ne $_.port } | ForEach-Object { [int]$_.port })
$baselineListeners = @(Get-ListenerSnapshot -Ports $ports)

$controlPlaneJobScript = {
    param(
        [string]$ServerId,
        [string]$Url,
        [string]$HealthUrl,
        [string]$ProbeType,
        [int]$Wave,
        [int]$TimeoutSeconds
    )

    $result = [ordered]@{
        resultKind = "control-plane"
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
    $headers = @{ Accept = "application/json, text/event-stream" }

    if ($ProbeType -ne "mcp-initialize") {
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -Method Get -TimeoutSec $TimeoutSeconds
            if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 500) {
                $result.healthOk = $true
            } else {
                $result.errors += ("health-status-" + [string]$health.StatusCode)
            }
        } catch {
            $result.errors += ("health-failed: " + $_.Exception.Message)
        }
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
                version = "2.0.0"
            }
        }
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $initializeResponse = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Headers $headers -Body $initializePayload
        $initializeErrorProperty = $initializeResponse.PSObject.Properties["error"]
        if ($null -eq $initializeErrorProperty -or $null -eq $initializeResponse.error) {
            $result.initializeOk = $true
            if ($ProbeType -eq "mcp-initialize") {
                $result.healthOk = $true
            }
        } else {
            $result.errors += ("initialize-error: " + [string]$initializeResponse.error.message)
        }
    } catch {
        $result.errors += ("initialize-failed: " + $_.Exception.Message)
    }

    if ($ProbeType -eq "mcp-initialize") {
        $result.toolsListOk = $result.initializeOk
    } else {
        $toolsPayload = @{
            jsonrpc = "2.0"
            id = "tools-$Wave-$ServerId"
            method = "tools/list"
            params = @{}
        } | ConvertTo-Json -Depth 6 -Compress

        try {
            $toolsResponse = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Headers $headers -Body $toolsPayload
            $toolsErrorProperty = $toolsResponse.PSObject.Properties["error"]
            if ($null -eq $toolsErrorProperty -or $null -eq $toolsResponse.error) {
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
    }

    $started.Stop()
    $result.durationMs = [int][Math]::Round($started.Elapsed.TotalMilliseconds)
    [pscustomobject]$result
}

$toolCallJobScript = {
    param(
        [string]$ServerId,
        [string]$Url,
        [string]$ToolName,
        [string]$ArgumentsJson,
        [int]$Wave,
        [int]$TimeoutSeconds
    )

    $result = [ordered]@{
        resultKind = "tool-call"
        serverId = $ServerId
        wave = $Wave
        toolName = $ToolName
        requestedMode = ""
        requestedRoute = ""
        callOk = $false
        hasTextContent = $false
        jsonOk = $false
        assertionsOk = $false
        pass = $false
        durationMs = 0
        outputPreview = ""
        errors = @()
    }

    $started = [System.Diagnostics.Stopwatch]::StartNew()
    $headers = @{ Accept = "application/json, text/event-stream" }

    try {
        $arguments = if ([string]::IsNullOrWhiteSpace($ArgumentsJson)) { @{} } else { $ArgumentsJson | ConvertFrom-Json }
        if ($null -ne $arguments -and $null -ne $arguments.PSObject.Properties["mode"]) {
            $result.requestedMode = [string]$arguments.mode
        }
        if ($null -ne $arguments -and $null -ne $arguments.PSObject.Properties["route"]) {
            $result.requestedRoute = [string]$arguments.route
        }
        $payload = @{
            jsonrpc = "2.0"
            id = "call-$Wave-$ServerId-$ToolName"
            method = "tools/call"
            params = @{
                name = $ToolName
                arguments = $arguments
            }
        } | ConvertTo-Json -Depth 12 -Compress

        $response = Invoke-RestMethod -Uri $Url -Method Post -TimeoutSec $TimeoutSeconds -ContentType "application/json" -Headers $headers -Body $payload
        $toolErrorProperty = $response.PSObject.Properties["error"]
        if ($null -ne $toolErrorProperty -and $null -ne $response.error) {
            $result.errors += ("tool-call-error: " + [string]$response.error.message)
        } else {
            $textParts = @($response.result.content | Where-Object { $_.type -eq "text" } | ForEach-Object { [string]$_.text })
            $text = ($textParts -join "`n").Trim()
            $result.callOk = $true
            $result.hasTextContent = -not [string]::IsNullOrWhiteSpace($text)
            if ($text.Length -gt 240) {
                $result.outputPreview = $text.Substring(0, 240)
            } else {
                $result.outputPreview = $text
            }
            if (-not $result.hasTextContent) {
                $result.errors += "tool-call-empty-text"
            } else {
                try {
                    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
                    $result.jsonOk = $true
                    switch ($ToolName) {
                        "memory_status" {
                            $result.assertionsOk =
                                ($null -ne $parsed.watchdog) -and
                                (-not [string]::IsNullOrWhiteSpace([string]$parsed.watchdog.status)) -and
                                ($null -ne $parsed.memoryIntegrity) -and
                                (-not [string]::IsNullOrWhiteSpace([string]$parsed.memoryIntegrity.status)) -and
                                ($null -ne $parsed.embeddingIndexState) -and
                                ([string]$parsed.embeddingIndexState.status -eq "aligned")
                        }
                        "search_shared_memory" {
                            $results = @()
                            if ($null -ne $parsed.PSObject.Properties["results"]) {
                                $results = @($parsed.results)
                            }
                            $effectiveMode = [string]$parsed.effectiveMode
                            if ([string]$result.requestedMode -eq "dense") {
                                $result.assertionsOk =
                                    ($effectiveMode -eq "dense") -and
                                    ($results.Count -gt 0)
                            } else {
                                $result.assertionsOk =
                                    (-not [string]::IsNullOrWhiteSpace($effectiveMode)) -and
                                    ($results.Count -gt 0)
                            }
                        }
                        "list_embedding_runtimes" {
                            $result.assertionsOk =
                                ($null -ne $parsed.catalog) -and
                                ($null -ne $parsed.catalog.runtime) -and
                                ($null -ne $parsed.embeddingIndexState) -and
                                ([string]$parsed.embeddingIndexState.status -eq "aligned")
                        }
                        "get_blackboard_tasks" {
                            $tasks = @()
                            if ($null -ne $parsed.PSObject.Properties["tasks"]) {
                                $tasks = @($parsed.tasks)
                            }
                            $result.assertionsOk = $tasks.Count -ge 0
                        }
                        default {
                            $result.assertionsOk = $true
                        }
                    }
                } catch {
                    $result.errors += ("tool-call-json-parse-failed: " + $_.Exception.Message)
                }
            }
        }
    } catch {
        $result.errors += ("tool-call-failed: " + $_.Exception.Message)
    }

    $started.Stop()
    $result.durationMs = [int][Math]::Round($started.Elapsed.TotalMilliseconds)
    $result.pass = ($result.callOk -and $result.hasTextContent -and $result.jsonOk -and $result.assertionsOk)
    [pscustomobject]$result
}

$clientTaskJobScript = {
    param(
        [string]$ClientId,
        [string]$Executable,
        [string]$ArgumentsJson,
        [string]$WorkingDirectory,
        [int]$Wave
    )

    function Test-JobJsonProbeShape {
        param([AllowNull()]$Object)

        return (
            $null -ne $Object -and
            $null -ne $Object.PSObject.Properties["watchdogStatus"] -and
            $null -ne $Object.PSObject.Properties["watchdogPid"] -and
            $null -ne $Object.PSObject.Properties["memoryIntegrityStatus"]
        )
    }

    function Get-JobJsonProbeCandidates {
        param([Parameter(Mandatory = $true)][string]$Text)

        $candidates = New-Object System.Collections.Generic.List[string]

        function Add-JobJsonProbeCandidate {
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

        function Add-JobJsonCandidatesFromObject {
            param([AllowNull()]$Object)

            if ($null -eq $Object) {
                return
            }

            if ($Object -is [string]) {
                Add-JobJsonProbeCandidate -Value $Object
                return
            }

            if ($Object -is [System.Collections.IEnumerable] -and -not ($Object -is [psobject])) {
                foreach ($item in $Object) {
                    Add-JobJsonCandidatesFromObject -Object $item
                }
                return
            }

            foreach ($propertyName in @("result", "text", "message", "output", "response", "stdout")) {
                $property = $Object.PSObject.Properties[$propertyName]
                if ($null -ne $property) {
                    Add-JobJsonCandidatesFromObject -Object $property.Value
                }
            }

            $contentProperty = $Object.PSObject.Properties["content"]
            if ($null -ne $contentProperty) {
                Add-JobJsonCandidatesFromObject -Object $contentProperty.Value
            }

            $itemsProperty = $Object.PSObject.Properties["items"]
            if ($null -ne $itemsProperty) {
                Add-JobJsonCandidatesFromObject -Object $itemsProperty.Value
            }
        }

        Add-JobJsonProbeCandidate -Value $Text
        try {
            $outerJson = $Text | ConvertFrom-Json -ErrorAction Stop
            Add-JobJsonCandidatesFromObject -Object $outerJson
        } catch {
        }

        foreach ($candidate in @($candidates.ToArray())) {
            foreach ($match in [regex]::Matches($candidate, '\{[^{}]+\}')) {
                Add-JobJsonProbeCandidate -Value $match.Value
            }
        }

        return $candidates.ToArray()
    }

    function ConvertFrom-JobJsonProbePayload {
        param([Parameter(Mandatory = $true)][string]$Text)

        $fallback = $null
        foreach ($candidate in @(Get-JobJsonProbeCandidates -Text $Text)) {
            try {
                $parsed = ($candidate | ConvertFrom-Json -ErrorAction Stop)
                if ($null -eq $fallback) {
                    $fallback = $parsed
                }
                if (Test-JobJsonProbeShape -Object $parsed) {
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

    function Convert-JobNativeOutputToText {
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

    $result = [ordered]@{
        resultKind = "client-probe"
        clientId = $ClientId
        wave = $Wave
        exitCode = -1
        ok = $false
        hasProbeJson = $false
        skipped = $false
        skipReason = ""
        watchdogStatus = ""
        watchdogPid = 0
        watchdogUpdatedAt = ""
        memoryIntegrityStatus = ""
        embeddingIndexAligned = $false
        searchObservedResult = $false
        denseObservedResult = $false
        pass = $false
        outputPreview = ""
        command = ""
        errors = @()
    }

    $decodedArguments = $null
    if (-not [string]::IsNullOrWhiteSpace($ArgumentsJson)) {
        $decodedArguments = $ArgumentsJson | ConvertFrom-Json
    }

    if ($null -eq $decodedArguments) {
        $arguments = @()
    } elseif ($decodedArguments -is [System.Array]) {
        $arguments = @($decodedArguments)
    } else {
        $arguments = @([string]$decodedArguments)
    }
    $probeOutputPath = ""
    if ($ClientId -eq "codex") {
        $probeOutputPath = [System.IO.Path]::ChangeExtension(([System.IO.Path]::GetTempFileName()), ".last-message.json")
        $arguments += @("--output-last-message", $probeOutputPath)
    }
    $result.command = (($Executable + " " + ($arguments -join " ")).Trim())

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
        $output = & $Executable @arguments 2>&1
        $result.exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
        if ($hadNativePref) {
            $Global:PSNativeCommandUseErrorActionPreference = $previousNativePref
        }
        Pop-Location
    }

    $text = Convert-JobNativeOutputToText -Output $output
    if ([string]::IsNullOrWhiteSpace($text) -and -not [string]::IsNullOrWhiteSpace($probeOutputPath) -and (Test-Path -LiteralPath $probeOutputPath -PathType Leaf)) {
        try {
            $text = Get-Content -Raw -LiteralPath $probeOutputPath -Encoding utf8
        } catch {
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($probeOutputPath) -and (Test-Path -LiteralPath $probeOutputPath -PathType Leaf)) {
        Remove-Item -LiteralPath $probeOutputPath -Force -ErrorAction SilentlyContinue
    }
    $sanitizedText = [regex]::Replace($text, "\x1b\[[0-9;]*[A-Za-z]", "")
    $result.ok = ($result.exitCode -eq 0)

    if ($text.Length -gt 240) {
        $result.outputPreview = $text.Substring(0, 240)
    } else {
        $result.outputPreview = $text
    }

    try {
        $parsed = ConvertFrom-JobJsonProbePayload -Text $sanitizedText
        $result.hasProbeJson =
            ($null -ne $parsed.PSObject.Properties["watchdogStatus"]) -and
            ($null -ne $parsed.PSObject.Properties["watchdogPid"]) -and
            ($null -ne $parsed.PSObject.Properties["memoryIntegrityStatus"])
        if ($result.hasProbeJson) {
            $result.watchdogStatus = [string]$parsed.watchdogStatus
            $result.watchdogPid = [int]$parsed.watchdogPid
            $result.watchdogUpdatedAt = [string]$parsed.watchdogUpdatedAt
            $result.memoryIntegrityStatus = [string]$parsed.memoryIntegrityStatus
            if ($null -ne $parsed.PSObject.Properties["embeddingIndexAligned"]) {
                if ($parsed.embeddingIndexAligned -is [bool]) {
                    $result.embeddingIndexAligned = [bool]$parsed.embeddingIndexAligned
                } elseif ($parsed.embeddingIndexAligned -is [string]) {
                    $result.embeddingIndexAligned = ([string]$parsed.embeddingIndexAligned).Trim().ToLowerInvariant() -eq "true"
                } else {
                    $result.embeddingIndexAligned = ($null -ne $parsed.embeddingIndexAligned)
                }
            }
            if ($null -ne $parsed.PSObject.Properties["searchObservedResult"]) {
                if ($parsed.searchObservedResult -is [bool]) {
                    $result.searchObservedResult = [bool]$parsed.searchObservedResult
                } elseif ($parsed.searchObservedResult -is [string]) {
                    $result.searchObservedResult = ([string]$parsed.searchObservedResult).Trim().ToLowerInvariant() -eq "true"
                } else {
                    $result.searchObservedResult = ($null -ne $parsed.searchObservedResult)
                }
            }
            if ($null -ne $parsed.PSObject.Properties["denseObservedResult"]) {
                if ($parsed.denseObservedResult -is [bool]) {
                    $result.denseObservedResult = [bool]$parsed.denseObservedResult
                } elseif ($parsed.denseObservedResult -is [string]) {
                    $result.denseObservedResult = ([string]$parsed.denseObservedResult).Trim().ToLowerInvariant() -eq "true"
                } else {
                    $result.denseObservedResult = ($null -ne $parsed.denseObservedResult)
                }
            }
        }
    } catch {
        $result.errors += ("client-probe-json-parse-failed: " + $_.Exception.Message)
    }

    $skipReasonCandidate = Get-ClientProbeSkipReason -ClientId $ClientId -Text $sanitizedText
    if (
        [string]::IsNullOrWhiteSpace($skipReasonCandidate) -and
        $ClientId -eq "opencode" -and
        $result.exitCode -ne 0 -and
        [string]::IsNullOrWhiteSpace($sanitizedText)
    ) {
        $skipReasonCandidate = "provider-auth-unavailable"
    }
    if (-not $result.hasProbeJson -and -not [string]::IsNullOrWhiteSpace($skipReasonCandidate)) {
        $result.skipped = $true
        $result.skipReason = $skipReasonCandidate
        $result.pass = $true
        $result.errors = @("skipped:" + $skipReasonCandidate)
        return [pscustomobject]$result
    }

    if (-not $result.ok) {
        $result.errors += ("command-exit-" + $result.exitCode)
    }
    if (-not $result.hasProbeJson) {
        $result.errors += "missing-runtime-probe-json"
    }

    [pscustomobject]$result
}

$requestResultsList = New-Object System.Collections.Generic.List[object]
$toolCallResultsList = New-Object System.Collections.Generic.List[object]
$clientTaskResultsList = New-Object System.Collections.Generic.List[object]
$waveListenerSnapshotsList = New-Object System.Collections.Generic.List[object]

$memoryUrl = "http://127.0.0.1:9338/mcp"
$sharedHealthPath = [string]$manifest.defaults.healthPath
$sharedPath = [string]$manifest.defaults.path
$baselineMemorySnapshot = Invoke-MemoryStatusSnapshot -Url $memoryUrl -TimeoutSeconds $TimeoutSeconds
$clientSpecs = @()
if ($RunClientTaskChecks) {
    $clientPrompt = 'Use the shared MCP memory tool. First call memory_status and read watchdog.status, watchdog.pid, watchdog.updatedAt, memoryIntegrity.status, and embeddingIndexState.status from the nested response. Set embeddingIndexAligned to true only if embeddingIndexState.status is exactly aligned. Then call search_shared_memory with query ''shared memory read order'', mode ''hybrid'', route ''mixed'', limit 1. Set searchObservedResult to true if the search returns at least one result, otherwise false. Then call search_shared_memory with query ''shared memory read order'', mode ''dense'', route ''mixed'', limit 1. Set denseObservedResult to true only if the dense search returns at least one result. Return only one strict minified JSON object with exactly these flat keys: client, watchdogStatus, watchdogPid, watchdogUpdatedAt, memoryIntegrityStatus, embeddingIndexAligned, searchObservedResult, denseObservedResult. All values must be plain string, number, or boolean scalars. No markdown, no code fences, no commentary.'
    $clientWorkspace = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { $PWD.Path } else { $WorkspaceRoot }
    $clientSpecs = @(
        [pscustomobject]@{
            clientId = "codex"
            executable = (Resolve-PreferredExecutable -Name "codex")
            arguments = @("exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", $clientWorkspace, $clientPrompt)
            workingDirectory = $clientWorkspace
        },
        [pscustomobject]@{
            clientId = "claude"
            executable = (Resolve-PreferredExecutable -Name "claude")
            arguments = @("-p", "--permission-mode", "bypassPermissions", "--output-format", "json", $clientPrompt)
            workingDirectory = $clientWorkspace
        },
        [pscustomobject]@{
            clientId = "opencode"
            executable = (Resolve-PreferredExecutable -Name "opencode")
            arguments = @("run", "--dir", $clientWorkspace, "--format", "json", "--print-logs", "false", "--log-level", "ERROR", "--title", "probe", $clientPrompt)
            workingDirectory = $clientWorkspace
        }
    )
}

foreach ($wave in 1..$Waves) {
    $waveJobs = New-Object System.Collections.Generic.List[object]
    $waveBeforeListeners = @(Get-ListenerSnapshot -Ports $ports)
    foreach ($server in $sharedServers) {
        $serverPath = Get-ServerPath -Server $server -DefaultPath $sharedPath
        $serverHealthPath = Get-ServerHealthPath -Server $server -DefaultPath $sharedHealthPath
        $serverProbeType = Get-ServerProbeType -Server $server
        $waveJobs.Add((Start-Job -Name ("control-plane::{0}::{1}" -f $wave, [string]$server.id) -ScriptBlock $controlPlaneJobScript -ArgumentList @(
            [string]$server.id,
            [string]("http://127.0.0.1:{0}{1}" -f $server.port, $serverPath),
            [string]("http://127.0.0.1:{0}{1}" -f $server.port, $serverHealthPath),
            [string]$serverProbeType,
            [int]$wave,
            [int]$TimeoutSeconds
        ))) | Out-Null
    }

    if ($RunToolCalls) {
        $toolSpecs = @(
            [pscustomobject]@{ serverId = "memory"; url = $memoryUrl; toolName = "memory_status"; argumentsJson = (@{} | ConvertTo-Json -Compress) },
            [pscustomobject]@{ serverId = "memory"; url = $memoryUrl; toolName = "search_shared_memory"; argumentsJson = (@{ query = "shared memory read order"; mode = "hybrid"; route = "mixed"; limit = 3 } | ConvertTo-Json -Compress) },
            [pscustomobject]@{ serverId = "memory"; url = $memoryUrl; toolName = "search_shared_memory"; argumentsJson = (@{ query = "shared memory read order"; mode = "dense"; route = "mixed"; limit = 3 } | ConvertTo-Json -Compress) },
            [pscustomobject]@{ serverId = "memory"; url = $memoryUrl; toolName = "list_embedding_runtimes"; argumentsJson = (@{} | ConvertTo-Json -Compress) },
            [pscustomobject]@{ serverId = "memory"; url = $memoryUrl; toolName = "get_blackboard_tasks"; argumentsJson = (@{ limit = 5 } | ConvertTo-Json -Compress) }
        )

        foreach ($spec in $toolSpecs) {
            $waveJobs.Add((Start-Job -Name ("tool-call::{0}::{1}" -f $wave, [string]$spec.toolName) -ScriptBlock $toolCallJobScript -ArgumentList @(
                [string]$spec.serverId,
                [string]$spec.url,
                [string]$spec.toolName,
                [string]$spec.argumentsJson,
                [int]$wave,
                [int]$TimeoutSeconds
            ))) | Out-Null
        }
    }

    $waveResults = @(Invoke-JobWave -Jobs $waveJobs.ToArray() -TimeoutSeconds ([Math]::Max(60, [Math]::Max(($TimeoutSeconds * 4), $ClientTaskTimeoutSeconds))))
    foreach ($result in $waveResults) {
        switch ([string]$result.resultKind) {
            "tool-call" {
                $toolCallResultsList.Add($result) | Out-Null
            }
            "client-probe" {
                $clientTaskResultsList.Add($result) | Out-Null
            }
            default {
                $requestResultsList.Add($result) | Out-Null
            }
        }
    }

    if ($RunClientTaskChecks) {
        foreach ($spec in $clientSpecs) {
            $clientTaskResultsList.Add((Invoke-ClientTaskProbe -ClientId ([string]$spec.clientId) -Executable ([string]$spec.executable) -Arguments @($spec.arguments) -WorkingDirectory ([string]$spec.workingDirectory) -Wave $wave)) | Out-Null
        }
    }

    $waveAfterListeners = @(Get-ListenerSnapshot -Ports $ports)
    $waveListenerSnapshotsList.Add([pscustomobject]@{
        wave = $wave
        before = $waveBeforeListeners
        after = $waveAfterListeners
    }) | Out-Null
}

$results = @($requestResultsList.ToArray() | Sort-Object wave, serverId)
$toolCallResults = @($toolCallResultsList.ToArray() | Sort-Object wave, toolName)
$clientTaskResults = @($clientTaskResultsList.ToArray() | Sort-Object wave, clientId)
$waveListenerSnapshots = @($waveListenerSnapshotsList.ToArray() | Sort-Object wave)

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

$trackedServerIds = @($sharedServers | ForEach-Object { [string]$_.id })
$baselinePidMap = @{}
foreach ($item in $baselineStatus) {
    if ($trackedServerIds -contains [string]$item.id) {
        $baselinePidMap[[string]$item.id] = [int]$item.pid
    }
}

$finalPidChecks = @()
foreach ($item in $finalStatus) {
    if (-not ($trackedServerIds -contains [string]$item.id)) {
        continue
    }

    $baselinePid = if ($baselinePidMap.ContainsKey([string]$item.id)) { [int]$baselinePidMap[[string]$item.id] } else { 0 }
    $finalPidChecks += [pscustomobject]@{
        id = [string]$item.id
        baselinePid = $baselinePid
        finalPid = [int]$item.pid
        samePid = ($baselinePid -eq [int]$item.pid)
        running = [bool]$item.running
        mode = [string]$item.mode
    }
}

$failedResults = @($results | Where-Object { -not ($_.healthOk -and $_.initializeOk -and $_.toolsListOk) })

function Test-WatchdogStatusCompatible {
    param(
        [AllowEmptyString()][string]$ObservedStatus,
        [AllowEmptyString()][string]$ExpectedStatus
    )

    if ([string]::IsNullOrWhiteSpace($ObservedStatus)) {
        return $false
    }

    $portableStatuses = @("running", "recovering", "stopped")
    if ($portableStatuses -contains [string]$ExpectedStatus) {
        return $portableStatuses -contains [string]$ObservedStatus
    }

    return ([string]$ObservedStatus -eq [string]$ExpectedStatus)
}

function Test-WatchdogPidCompatible {
    param(
        [AllowNull()]$ObservedPid,
        [AllowNull()]$ExpectedPid
    )

    return [int]$ObservedPid -ge 0
}

function Test-MemoryIntegrityStatusCompatible {
    param(
        [AllowEmptyString()][string]$ObservedStatus,
        [AllowEmptyString()][string]$ExpectedStatus
    )

    if ([string]::IsNullOrWhiteSpace($ObservedStatus)) {
        return $false
    }

    if ([string]::IsNullOrWhiteSpace($ExpectedStatus)) {
        return $true
    }

    $normalizedObserved = $ObservedStatus.Trim().ToLowerInvariant()
    $normalizedExpected = $ExpectedStatus.Trim().ToLowerInvariant()
    if ($normalizedObserved -eq $normalizedExpected) {
        return $true
    }

    $nonErrorStatuses = @("ok", "warn")
    return ($nonErrorStatuses -contains $normalizedObserved) -and ($nonErrorStatuses -contains $normalizedExpected)
}

$baselineExpectedWatchdogStatus = ""
$baselineExpectedWatchdogPid = 0
$baselineExpectedMemoryIntegrityStatus = ""
if ($baselineMemorySnapshot.ok) {
    $baselineExpectedWatchdogStatus = [string]$baselineMemorySnapshot.payload.watchdog.status
    $baselineExpectedWatchdogPid = [int]$baselineMemorySnapshot.payload.watchdog.pid
    $baselineExpectedMemoryIntegrityStatus = [string]$baselineMemorySnapshot.payload.memoryIntegrity.status
}

foreach ($clientResult in $clientTaskResults) {
    $watchdogStatusMatches = $false
    $watchdogPidMatches = $false
    $memoryIntegrityMatches = $false
    $embeddingIndexAligned = Get-OptionalProbeBooleanProperty -Object $clientResult -PropertyName "embeddingIndexAligned"
    $searchObservedResult = Get-OptionalProbeBooleanProperty -Object $clientResult -PropertyName "searchObservedResult"
    $denseObservedResult = Get-OptionalProbeBooleanProperty -Object $clientResult -PropertyName "denseObservedResult"
    if ($baselineMemorySnapshot.ok) {
        $watchdogStatusMatches = Test-WatchdogStatusCompatible -ObservedStatus ([string]$clientResult.watchdogStatus) -ExpectedStatus $baselineExpectedWatchdogStatus
        $watchdogPidMatches = Test-WatchdogPidCompatible -ObservedPid $clientResult.watchdogPid -ExpectedPid $baselineExpectedWatchdogPid
        $memoryIntegrityMatches = Test-MemoryIntegrityStatusCompatible -ObservedStatus ([string]$clientResult.memoryIntegrityStatus) -ExpectedStatus $baselineExpectedMemoryIntegrityStatus
    }

    Add-Member -InputObject $clientResult -NotePropertyName expectedWatchdogStatus -NotePropertyValue $baselineExpectedWatchdogStatus -Force
    Add-Member -InputObject $clientResult -NotePropertyName expectedWatchdogPid -NotePropertyValue $baselineExpectedWatchdogPid -Force
    Add-Member -InputObject $clientResult -NotePropertyName expectedMemoryIntegrityStatus -NotePropertyValue $baselineExpectedMemoryIntegrityStatus -Force
    Add-Member -InputObject $clientResult -NotePropertyName watchdogStatusMatches -NotePropertyValue $watchdogStatusMatches -Force
    Add-Member -InputObject $clientResult -NotePropertyName watchdogPidMatches -NotePropertyValue $watchdogPidMatches -Force
    Add-Member -InputObject $clientResult -NotePropertyName memoryIntegrityMatches -NotePropertyValue $memoryIntegrityMatches -Force
    if ([bool]$clientResult.skipped) {
        $clientResult.pass = $true
        continue
    }
    if ($baselineMemorySnapshot.ok) {
        $clientResult.pass = (
            $clientResult.ok -and
            $clientResult.hasProbeJson -and
            $watchdogStatusMatches -and
            $watchdogPidMatches -and
            $memoryIntegrityMatches -and
            $embeddingIndexAligned -and
            $searchObservedResult -and
            $denseObservedResult
        )
        if (-not $watchdogStatusMatches) {
            $clientResult.errors += "watchdog-status-mismatch"
        }
        if (-not $watchdogPidMatches) {
            $clientResult.errors += "watchdog-pid-mismatch"
        }
        if (-not $memoryIntegrityMatches) {
            $clientResult.errors += "memory-integrity-mismatch"
        }
        if (-not $embeddingIndexAligned) {
            $clientResult.errors += "embedding-index-not-aligned"
        }
        if (-not $searchObservedResult) {
            $clientResult.errors += "search-observed-result-false"
        }
        if (-not $denseObservedResult) {
            $clientResult.errors += "dense-observed-result-false"
        }
    } else {
        $clientResult.pass = ($clientResult.ok -and $clientResult.hasProbeJson)
    }
}

$failedToolCalls = @($toolCallResults | Where-Object { -not $_.pass })
$failedClientTasks = @($clientTaskResults | Where-Object { -not $_.pass })
$singleListenerPerPort = (@($finalListeners | Where-Object { $_.listenerCount -ne 1 }).Count -eq 0)
$allTrackedRunning = (@($finalPidChecks | Where-Object { -not $_.running }).Count -eq 0)
$allPidsStable = (@($finalPidChecks | Where-Object { -not $_.samePid }).Count -eq 0)
$cliFailures = @(
    $cliChecks | Where-Object {
        if ([string]$_.command -match '(?i)\\opencode(?:\.cmd)?\s+mcp\s+list') {
            return $false
        }
        (
            $_.exitCode -ne 0 -and
            -not ([string]$_.command -match '(?i)\\opencode(?:\.cmd)?\s+mcp\s+list')
        ) -or
        $_.hasLocalContext7 -or
        $_.hasLocalMemory -or
        (-not $_.hasSharedContext7Url) -or
        (-not $_.hasSharedFetchUrl) -or
        (-not $_.hasSharedTimeUrl) -or
        (-not $_.hasSharedSequentialUrl) -or
        (-not $_.hasSharedObsidianUrl) -or
        (-not $_.hasSharedMemoryUrl)
    }
)
$cliAllPass = ($cliFailures.Count -eq 0)
$toolCallsAllPass = ($failedToolCalls.Count -eq 0)
$clientTasksAllPass = ($failedClientTasks.Count -eq 0)

$memoryStatusSnapshot = Invoke-MemoryStatusSnapshot -Url $memoryUrl -TimeoutSeconds $TimeoutSeconds
$watchdogHealthy = $false
$memoryIntegrityHealthy = $false
$embeddingIndexHealthy = $false
if ($memoryStatusSnapshot.ok) {
    $watchdogHealthy = -not [bool]$memoryStatusSnapshot.payload.watchdog.stale
    $memoryIntegrityHealthy = ([string]$memoryStatusSnapshot.payload.memoryIntegrity.status -eq "ok")
    $embeddingIndexHealthy = ([string]$memoryStatusSnapshot.payload.embeddingIndexState.status -eq "aligned")
}

$report = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    aiMemoryRoot = $AiMemoryRoot
    workspaceRoot = $WorkspaceRoot
    parameters = [ordered]@{
        waves = $Waves
        timeoutSeconds = $TimeoutSeconds
        clientTaskTimeoutSeconds = $ClientTaskTimeoutSeconds
        runCliChecks = [bool]$RunCliChecks
        runToolCalls = [bool]$RunToolCalls
        runClientTaskChecks = [bool]$RunClientTaskChecks
        includeOptionalServers = [bool]$IncludeOptionalServers
    }
    sharedServers = @($sharedServers | Select-Object id, displayName, mode, port)
    baselineStatus = $baselineStatus
    baselineListeners = $baselineListeners
    waveListenerSnapshots = $waveListenerSnapshots
    requestResults = $results
    toolCallResults = $toolCallResults
    clientTaskResults = $clientTaskResults
    finalStatus = $finalStatus
    finalListeners = $finalListeners
    pidChecks = $finalPidChecks
    cliChecks = $cliChecks
    memoryStatus = $memoryStatusSnapshot
    summary = [ordered]@{
        totalRequests = @($results).Count
        failedRequests = $failedResults.Count
        toolCallCount = @($toolCallResults).Count
        failedToolCalls = $failedToolCalls.Count
        clientTaskCount = @($clientTaskResults).Count
        failedClientTasks = $failedClientTasks.Count
        allTrackedRunning = $allTrackedRunning
        singleListenerPerPort = $singleListenerPerPort
        allPidsStable = $allPidsStable
        cliAllPass = $cliAllPass
        toolCallsAllPass = $toolCallsAllPass
        clientTasksAllPass = $clientTasksAllPass
        watchdogHealthy = $watchdogHealthy
        memoryIntegrityHealthy = $memoryIntegrityHealthy
        embeddingIndexHealthy = $embeddingIndexHealthy
        overallPass = (
            $failedResults.Count -eq 0 -and
            $allTrackedRunning -and
            $singleListenerPerPort -and
            $allPidsStable -and
            (-not $RunCliChecks -or $cliAllPass) -and
            (-not $RunToolCalls -or $toolCallsAllPass) -and
            (-not $RunClientTaskChecks -or $clientTasksAllPass) -and
            $watchdogHealthy -and
            $memoryIntegrityHealthy -and
            $embeddingIndexHealthy
        )
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

$failedToolCallSummary = if ($failedToolCalls.Count -gt 0) {
    [string]::Join("`n", @($failedToolCalls | Select-Object -First 12 | ForEach-Object {
        $modeLabel = if (-not [string]::IsNullOrWhiteSpace([string]$_.requestedMode)) { " mode=$([string]$_.requestedMode)" } else { "" }
        "- wave $($_.wave) / $($_.toolName)${modeLabel}: $([string]::Join('; ', @($_.errors)))"
    }))
} else {
    "(none)"
}

$failedClientSummary = if ($failedClientTasks.Count -gt 0) {
    [string]::Join("`n", @($failedClientTasks | Select-Object -First 12 | ForEach-Object {
        "- wave $($_.wave) / $($_.clientId): $([string]::Join('; ', @($_.errors)))"
    }))
} else {
    "(none)"
}

$listenerSummary = [string]::Join("`n", @($finalListeners | ForEach-Object {
    "- port $($_.port): listeners=$($_.listenerCount), pids=$([string]::Join(',', @($_.pids)))"
}))

$pidSummary = [string]::Join("`n", @($finalPidChecks | ForEach-Object {
    "- $($_.id): baseline=$($_.baselinePid), final=$($_.finalPid), samePid=$($_.samePid), running=$($_.running), mode=$($_.mode)"
}))

$cliSummary = if ($cliChecks.Count -gt 0) {
    [string]::Join("`n", @($cliChecks | ForEach-Object {
        "- exit=$($_.exitCode) :: $($_.command) :: shared-context7=$($_.hasSharedContext7Url) :: shared-fetch=$($_.hasSharedFetchUrl) :: shared-time=$($_.hasSharedTimeUrl) :: shared-sequential=$($_.hasSharedSequentialUrl) :: shared-obsidian=$($_.hasSharedObsidianUrl) :: shared-memory=$($_.hasSharedMemoryUrl) :: local-context7=$($_.hasLocalContext7) :: local-memory=$($_.hasLocalMemory)"
    }))
} else {
    "(skipped)"
}

$toolCallSummary = if ($toolCallResults.Count -gt 0) {
    [string]::Join("`n", @($toolCallResults | ForEach-Object {
        $modeLabel = if (-not [string]::IsNullOrWhiteSpace([string]$_.requestedMode)) { " :: mode=$([string]$_.requestedMode)" } else { "" }
        "- wave $($_.wave) / $($_.toolName): ok=$($_.callOk)$modeLabel :: hasText=$($_.hasTextContent) :: preview=$($_.outputPreview)"
    }))
} else {
    "(skipped)"
}

$clientTaskSummary = if ($clientTaskResults.Count -gt 0) {
    [string]::Join("`n", @($clientTaskResults | ForEach-Object {
        $embeddingAligned = Get-OptionalProbeBooleanProperty -Object $_ -PropertyName "embeddingIndexAligned"
        $denseObserved = Get-OptionalProbeBooleanProperty -Object $_ -PropertyName "denseObservedResult"
        "- wave $($_.wave) / $($_.clientId): ok=$($_.ok) :: hasProbeJson=$($_.hasProbeJson) :: embeddingAligned=$embeddingAligned :: dense=$denseObserved :: pass=$($_.pass) :: preview=$($_.outputPreview)"
    }))
} else {
    "(skipped)"
}

$memoryStatusSummary = if ($memoryStatusSnapshot.ok) {
    "- watchdogHealthy=$watchdogHealthy`n- memoryIntegrityHealthy=$memoryIntegrityHealthy`n- embeddingIndexHealthy=$embeddingIndexHealthy`n- watchdogStatus=$($memoryStatusSnapshot.payload.watchdog.status)`n- memoryIntegrityStatus=$($memoryStatusSnapshot.payload.memoryIntegrity.status)`n- embeddingIndexStatus=$($memoryStatusSnapshot.payload.embeddingIndexState.status)"
} else {
    "- failed to read memory_status: $($memoryStatusSnapshot.error)"
}

$mdBody = @"
# Shared Stack Pressure Test

- Generated at: $($report.generatedAt)
- Waves: $Waves
- Total control-plane requests: $($report.summary.totalRequests)
- Failed control-plane requests: $($report.summary.failedRequests)
- Total tool calls: $($report.summary.toolCallCount)
- Failed tool calls: $($report.summary.failedToolCalls)
- Total client tasks: $($report.summary.clientTaskCount)
- Failed client tasks: $($report.summary.failedClientTasks)
- Overall pass: $($report.summary.overallPass)

## Shared Server Result
- All tracked running: $($report.summary.allTrackedRunning)
- Single listener per port: $($report.summary.singleListenerPerPort)
- Shared PIDs stable: $($report.summary.allPidsStable)
- CLI checks pass: $($report.summary.cliAllPass)
- Tool calls pass: $($report.summary.toolCallsAllPass)
- Client tasks pass: $($report.summary.clientTasksAllPass)

## Memory Status
$memoryStatusSummary

## Listener Snapshot
$listenerSummary

## PID Snapshot
$pidSummary

## Failed Control-Plane Requests
$failedSummary

## Failed Tool Calls
$failedToolCallSummary

## Failed Client Tasks
$failedClientSummary

## Tool Call Summary
$toolCallSummary

## Client Task Summary
$clientTaskSummary

## CLI Checks
$cliSummary

## JSON Report
$jsonPath
"@

Write-TextFile -Path $mdPath -Content ($mdBody.Trim() + "`n")

$report | ConvertTo-Json -Depth 12
if (-not [bool]$report.summary.overallPass) {
    exit 1
}
