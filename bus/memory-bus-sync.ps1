# bus/memory-bus-sync.ps1
# Source sync helpers. Dot-sourced by memory-bus.ps1.

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
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
