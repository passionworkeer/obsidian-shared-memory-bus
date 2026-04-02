param(
    [switch]$Force,
    [int]$MinHours = 24,
    [int]$MinRecords = 10
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "../bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Read-Text {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}

function Write-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Get-JsonLines {
    param([Parameter(Mandatory = $true)][string]$Path)

    $items = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }

    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $items.Add(($line | ConvertFrom-Json)) | Out-Null
        } catch {
        }
    }

    return @($items.ToArray())
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

function Get-FileStamp {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return "__missing__"
    }

    $item = Get-Item -LiteralPath $Path
    $content = Read-Text -Path $Path
    $hash = Get-StringHash -Text $content
    return "{0}:{1}:{2}" -f $item.Name, $hash, $item.Length
}

function New-BulletLine {
    param([Parameter(Mandatory = $true)][object]$Record)

    $tool = if ([string]::IsNullOrWhiteSpace([string]$Record.tool)) { "unknown" } else { [string]$Record.tool }
    $scope = if ([string]::IsNullOrWhiteSpace([string]$Record.scope)) { "" } else { " [$([string]$Record.scope)]" }
    $title = if ([string]::IsNullOrWhiteSpace([string]$Record.title)) { [string]$Record.content } else { [string]$Record.title }
    $taskState = if ([string]::IsNullOrWhiteSpace([string]$Record.task_state)) { "" } else { " {$([string]$Record.task_state)}" }
    return "- [$tool]$scope$taskState $($title.Trim())"
}

function Normalize-RecordText {
    param([Parameter(Mandatory = $true)][object]$Record)

    $parts = @(
        [string]$Record.project,
        [string]$Record.title,
        [string]$Record.content,
        [string]$Record.scope,
        [string]$Record.task_state
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }

    $text = [string]::Join(" ", $parts).ToLowerInvariant()
    $text = [System.Text.RegularExpressions.Regex]::Replace($text, "[^\p{L}\p{Nd}]+", " ")
    $text = [System.Text.RegularExpressions.Regex]::Replace($text, "\s+", " ").Trim()
    return $text
}

function Get-RecordSimilarityKey {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [AllowEmptyString()][string]$ScopeOverride = ""
    )

    $normalized = Normalize-RecordText -Record $Record
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }

    $tokens = @($normalized -split "\s+" | Where-Object { $_.Length -ge 3 } | Select-Object -First 18)
    if ($tokens.Count -eq 0) {
        return ""
    }

    $effectiveScope = if ([string]::IsNullOrWhiteSpace($ScopeOverride)) { [string]$Record.scope } else { $ScopeOverride }
    $prefix = "{0}|{1}" -f ([string]$Record.project).ToLowerInvariant(), ([string]$effectiveScope).ToLowerInvariant()
    return (Get-StringHash -Text ($prefix + "|" + ($tokens -join " ")))
}

function Get-RecordTimestampUtc {
    param([Parameter(Mandatory = $true)][object]$Record)

    try {
        if ([string]::IsNullOrWhiteSpace([string]$Record.t)) {
            return [datetime]::MinValue
        }

        return ([datetime]::Parse([string]$Record.t)).ToUniversalTime()
    } catch {
        return [datetime]::MinValue
    }
}

function New-KeyRecordMap {
    param([Parameter(Mandatory = $true)][object[]]$Records)

    $map = @{}
    foreach ($record in @($Records | Sort-Object { [string]$_.t } -Descending)) {
        $targetScope = Get-DurableTargetScope -Record $record
        $key = if ([string]::IsNullOrWhiteSpace($targetScope)) {
            Get-RecordSimilarityKey -Record $record
        } else {
            Get-RecordPromotionKey -Record $record -TargetScope $targetScope
        }
        if ([string]::IsNullOrWhiteSpace($key) -or $map.ContainsKey($key)) {
            continue
        }

        $map[$key] = $record
    }

    return $map
}

function Select-NovelRecordsAgainstBaseline {
    param(
        [Parameter(Mandatory = $true)][object[]]$CandidateRecords,
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [int]$MaxItems = 8
    )

    $selected = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($record in @($CandidateRecords | Sort-Object { [string]$_.t } -Descending)) {
        $key = Get-RecordSimilarityKey -Record $record
        if ([string]::IsNullOrWhiteSpace($key) -or $BaselineMap.ContainsKey($key) -or $seen.ContainsKey($key)) {
            continue
        }

        $seen[$key] = $true
        $selected.Add($record) | Out-Null
        if ($selected.Count -ge $MaxItems) {
            break
        }
    }

    return @($selected.ToArray())
}

function Select-RefreshTargets {
    param(
        [Parameter(Mandatory = $true)][object[]]$CandidateRecords,
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [int]$MaxItems = 8
    )

    $selected = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($record in @($CandidateRecords | Sort-Object { [string]$_.t } -Descending)) {
        $key = Get-RecordSimilarityKey -Record $record
        if ([string]::IsNullOrWhiteSpace($key) -or -not $BaselineMap.ContainsKey($key) -or $seen.ContainsKey($key)) {
            continue
        }

        $baseline = $BaselineMap[$key]
        $candidateTs = Get-RecordTimestampUtc -Record $record
        $baselineTs = Get-RecordTimestampUtc -Record $baseline
        if ($candidateTs -le $baselineTs) {
            continue
        }

        $seen[$key] = $true
        $selected.Add($record) | Out-Null
        if ($selected.Count -ge $MaxItems) {
            break
        }
    }

    return @($selected.ToArray())
}

function Select-RecentUniqueRecords {
    param(
        [Parameter(Mandatory = $true)][object[]]$Records,
        [int]$MaxItems = 8
    )

    $seen = @{}
    $selected = New-Object System.Collections.Generic.List[object]
    foreach ($record in @($Records | Sort-Object { [string]$_.t } -Descending)) {
        $key = Get-RecordSimilarityKey -Record $record

        if ([string]::IsNullOrWhiteSpace($key) -or $seen.ContainsKey($key)) {
            continue
        }

        $seen[$key] = $true
        $selected.Add($record) | Out-Null
        if ($selected.Count -ge $MaxItems) {
            break
        }
    }

    return @($selected.ToArray())
}

function Get-RecordSourceLayer {
    param([Parameter(Mandatory = $true)][object]$Record)

    $memoryLevel = ([string]$Record.memory_level).Trim().ToLowerInvariant()
    $sourceKind = ([string]$Record.source_kind).Trim().ToLowerInvariant()
    $scope = ([string]$Record.scope).Trim().ToLowerInvariant()

    if ($memoryLevel -eq "durable" -or $sourceKind -eq "writeback") {
        return "durable"
    }
    if ($sourceKind -in @("hook", "event") -or $memoryLevel -eq "event") {
        return "event"
    }
    if ($memoryLevel -eq "task" -or $sourceKind -in @("blackboard", "run", "cron", "task") -or $scope -in @("task", "run")) {
        return "task"
    }
    return "session"
}

function Get-RecordPromotionMetadata {
    param([Parameter(Mandatory = $true)][object]$Record)

    if ($null -ne $Record.metadata -and $Record.metadata.PSObject.Properties.Name -contains "promotion") {
        return $Record.metadata.promotion
    }

    return $null
}

function Get-RecordType {
    param([Parameter(Mandatory = $true)][object]$Record)

    return ([string]$Record.type).Trim().ToLowerInvariant()
}

function Get-RecordConfidence {
    param([Parameter(Mandatory = $true)][object]$Record)

    try {
        return [double]$Record.confidence
    } catch {
        return 0.0
    }
}

function Get-DurableScopeFromType {
    param([Parameter(Mandatory = $true)][object]$Record)

    switch (Get-RecordType -Record $Record) {
        "preference" { return "user" }
        "workflow-rule" { return "feedback" }
        "project-context" { return "project" }
        "reference" { return "reference" }
        default { return "" }
    }
}

function Test-NonPromotableRecordType {
    param([Parameter(Mandatory = $true)][object]$Record)

    return (Get-RecordType -Record $Record) -in @(
        "summary",
        "session-summary",
        "daily-summary",
        "session-response",
        "task-note",
        "task-run",
        "task-job",
        "task-journal"
    )
}

function Test-AnyPattern {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }

    return $false
}

function Get-DurableTargetScope {
    param([Parameter(Mandatory = $true)][object]$Record)

    $promotion = Get-RecordPromotionMetadata -Record $Record
    if ($null -ne $promotion) {
        $durableType = ([string]$promotion.durable_type).Trim().ToLowerInvariant()
        if ($durableType -in @("user", "feedback", "project", "reference")) {
            return $durableType
        }
        return ""
    }

    $scope = ([string]$Record.scope).Trim().ToLowerInvariant()
    $sourceKind = ([string]$Record.source_kind).Trim().ToLowerInvariant()
    $memoryLevel = ([string]$Record.memory_level).Trim().ToLowerInvariant()
    $typedScope = Get-DurableScopeFromType -Record $Record
    $confidence = Get-RecordConfidence -Record $Record
    if (($sourceKind -eq "writeback" -or $memoryLevel -eq "durable") -and $scope -in @("user", "feedback", "project", "reference")) {
        return $scope
    }
    if (-not [string]::IsNullOrWhiteSpace($typedScope)) {
        if (([string]::IsNullOrWhiteSpace($scope) -or $scope -eq $typedScope) -and ($confidence -le 0 -or $confidence -ge 0.6)) {
            return $typedScope
        }
        return ""
    }
    if (Test-NonPromotableRecordType -Record $Record) {
        return ""
    }
    if ($confidence -gt 0 -and $confidence -lt 0.6) {
        return ""
    }
    if ($scope -in @("user", "feedback", "project", "reference")) {
        return $scope
    }

    $text = @(
        [string]$Record.project,
        [string]$Record.title,
        [string]$Record.content,
        [string]$Record.scope,
        [string]$Record.source_kind,
        [string]$Record.task_state
    ) -join " "
    $text = $text.ToLowerInvariant()

    if (Test-AnyPattern -Text $text -Patterns @("偏好", "喜欢", "语言", "风格", "回复", "\bpreference\b", "\blanguage\b", "\bstyle\b", "\breply\b", "user prefers")) {
        return "user"
    }
    if (Test-AnyPattern -Text $text -Patterns @("必须", "不要", "避免", "\balways\b", "\bnever\b", "\bmust\b", "\bshould\b", "workflow", "\brule\b", "约定", "规范")) {
        return "feedback"
    }
    if (Test-AnyPattern -Text $text -Patterns @("\bpath\b", "\burl\b", "\blink\b", "\bdashboard\b", "\blinear\b", "\bslack\b", "路径", "链接", "位置")) {
        return "reference"
    }
    if (Test-AnyPattern -Text $text -Patterns @("\bissue\b", "\bpr\b", "\brepo\b", "\bproject\b", "\btask\b", "cron", "blackboard", "queue", "workspace", "任务", "项目")) {
        return "project"
    }

    return ""
}

function Get-RecordPromotionKey {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [AllowEmptyString()][string]$TargetScope = ""
    )

    $promotion = Get-RecordPromotionMetadata -Record $Record
    if ($null -ne $promotion) {
        $promotionScope = ([string]$promotion.durable_type).Trim().ToLowerInvariant()
        $promotionKey = ([string]$promotion.key).Trim()
        if (-not [string]::IsNullOrWhiteSpace($promotionKey) -and ([string]::IsNullOrWhiteSpace($TargetScope) -or $promotionScope -eq $TargetScope)) {
            return $promotionKey
        }
    }

    return (Get-RecordSimilarityKey -Record $Record -ScopeOverride $TargetScope)
}

function Get-PromotionReason {
    param(
        [Parameter(Mandatory = $true)][object]$Record,
        [Parameter(Mandatory = $true)][string]$TargetScope,
        [Parameter(Mandatory = $true)][string]$SourceLayer,
        [switch]$Refresh
    )

    $recordScope = ([string]$Record.scope).Trim().ToLowerInvariant()
    $promotion = Get-RecordPromotionMetadata -Record $Record
    if ($null -ne $promotion -and -not [string]::IsNullOrWhiteSpace([string]$promotion.reason)) {
        $promotionReason = [string]$promotion.reason
        if ($Refresh) {
            return "refresh:{0}" -f $promotionReason
        }
        return $promotionReason
    }

    if ($recordScope -eq $TargetScope) {
        if ($Refresh) {
            return "scope-aligned-durable-refresh"
        }
        return "scope-aligned-durable-promotion"
    }
    if ($recordScope -eq "summary") {
        if ($Refresh) {
            return "summary-routed-to-durable-refresh"
        }
        return "summary-routed-to-durable-scope"
    }
    if ($SourceLayer -eq "task") {
        if ($Refresh) {
            return "task-layer-refresh"
        }
        return "task-layer-promotion"
    }
    if ($SourceLayer -eq "event") {
        if ($Refresh) {
            return "event-layer-refresh"
        }
        return "event-layer-promotion"
    }
    if ($Refresh) {
        return "session-layer-refresh"
    }
    return "session-layer-promotion"
}

function New-TypedDurableQueueItems {
    param(
        [Parameter(Mandatory = $true)][object[]]$CandidateRecords,
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [int]$MaxPromotions = 8,
        [int]$MaxRefresh = 8
    )

    $promotions = New-Object System.Collections.Generic.List[object]
    $refresh = New-Object System.Collections.Generic.List[object]
    $seenPromotions = @{}
    $seenRefresh = @{}

    foreach ($record in @($CandidateRecords | Sort-Object { [string]$_.t } -Descending)) {
        $targetScope = Get-DurableTargetScope -Record $record
        if ([string]::IsNullOrWhiteSpace($targetScope)) {
            continue
        }

        $key = Get-RecordPromotionKey -Record $record -TargetScope $targetScope
        if ([string]::IsNullOrWhiteSpace($key)) {
            continue
        }

        $sourceLayer = Get-RecordSourceLayer -Record $record
        $sourceType = [string]$record.type
        $sourceConfidence = [math]::Round((Get-RecordConfidence -Record $record), 4)
        $candidateTs = Get-RecordTimestampUtc -Record $record
        $baseline = if ($BaselineMap.ContainsKey($key)) { $BaselineMap[$key] } else { $null }

        if ($null -eq $baseline) {
            if ($promotions.Count -ge $MaxPromotions -or $seenPromotions.ContainsKey($key)) {
                continue
            }

            $seenPromotions[$key] = $true
            $promotions.Add([ordered]@{
                tool = [string]$record.tool
                title = [string]$record.title
                t = [string]$record.t
                sourceLayer = $sourceLayer
                sourceScope = [string]$record.scope
                targetScope = $targetScope
                sourceKind = [string]$record.source_kind
                sourceType = $sourceType
                sourceConfidence = $sourceConfidence
                sourceRecordId = [string]$record.id
                promotionKey = $key
                promotionReason = Get-PromotionReason -Record $record -TargetScope $targetScope -SourceLayer $sourceLayer
            }) | Out-Null
            continue
        }

        if ($refresh.Count -ge $MaxRefresh -or $seenRefresh.ContainsKey($key)) {
            continue
        }

        $baselineTs = Get-RecordTimestampUtc -Record $baseline
        if ($candidateTs -le $baselineTs) {
            continue
        }

        $seenRefresh[$key] = $true
        $refresh.Add([ordered]@{
            tool = [string]$record.tool
            title = [string]$record.title
            t = [string]$record.t
            sourceLayer = $sourceLayer
            sourceScope = [string]$record.scope
            targetScope = $targetScope
            sourceKind = [string]$record.source_kind
            sourceType = $sourceType
            sourceConfidence = $sourceConfidence
            sourceRecordId = [string]$record.id
            promotionKey = $key
            promotionReason = Get-PromotionReason -Record $record -TargetScope $targetScope -SourceLayer $sourceLayer -Refresh
            refreshOf = [ordered]@{
                id = [string]$baseline.id
                title = [string]$baseline.title
                scope = [string]$baseline.scope
                t = [string]$baseline.t
            }
        }) | Out-Null
    }

    return [ordered]@{
        promotions = @($promotions.ToArray())
        refresh = @($refresh.ToArray())
    }
}

function New-TypedQueueBulletLine {
    param([Parameter(Mandatory = $true)][object]$Item)

    $tool = if ([string]::IsNullOrWhiteSpace([string]$Item.tool)) { "unknown" } else { [string]$Item.tool }
    $sourceLayer = if ([string]::IsNullOrWhiteSpace([string]$Item.sourceLayer)) { "unknown" } else { [string]$Item.sourceLayer }
    $targetScope = if ([string]::IsNullOrWhiteSpace([string]$Item.targetScope)) { "unknown" } else { [string]$Item.targetScope }
    $sourceScope = if ([string]::IsNullOrWhiteSpace([string]$Item.sourceScope)) { "unknown" } else { [string]$Item.sourceScope }
    $title = if ([string]::IsNullOrWhiteSpace([string]$Item.title)) { [string]$Item.sourceRecordId } else { [string]$Item.title }
    $auditParts = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace([string]$Item.sourceType)) {
        $auditParts.Add(("type={0}" -f [string]$Item.sourceType)) | Out-Null
    }
    if ($null -ne $Item.sourceConfidence -and [double]$Item.sourceConfidence -gt 0) {
        $auditParts.Add(("conf={0}" -f ([double]$Item.sourceConfidence).ToString("0.00"))) | Out-Null
    }
    $auditTag = if ($auditParts.Count -gt 0) { " [{0}]" -f ($auditParts.ToArray() -join " ") } else { "" }
    $reason = if ([string]::IsNullOrWhiteSpace([string]$Item.promotionReason)) { "" } else { " ({0})" -f [string]$Item.promotionReason }
    return "- [$tool] [$targetScope <- $sourceLayer/$sourceScope] $($title.Trim())$auditTag$reason"
}

function Build-CountMap {
    param(
        [AllowEmptyCollection()][object[]]$Records = @(),
        [Parameter(Mandatory = $true)][string]$PropertyName
    )

    $counts = [ordered]@{}
    foreach ($record in $Records) {
        $name = ([string]$record.$PropertyName).Trim()
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }
        if (-not $counts.Contains($name)) {
            $counts[$name] = 0
        }
        $counts[$name] = [int]$counts[$name] + 1
    }

    $sorted = [ordered]@{}
    foreach ($entry in @($counts.GetEnumerator() | Sort-Object { -[int]$_.Value }, { [string]$_.Key })) {
        $sorted[$entry.Key] = [int]$entry.Value
    }

    return $sorted
}

function Acquire-DreamLock {
    param([Parameter(Mandatory = $true)][string]$LockPath)

    Ensure-Directory -Path (Split-Path -Parent $LockPath)
    try {
        return [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        return $null
    }
}

function Release-DreamLock {
    param(
        [Parameter(Mandatory = $false)][System.IDisposable]$Stream,
        [Parameter(Mandatory = $true)][string]$LockPath
    )

    if ($null -ne $Stream) {
        try {
            $Stream.Dispose()
        } catch {
        }
    }

    if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $LockPath -Force
        } catch {
        }
    }
}

$VaultRoot = Resolve-SharedObsidianVaultRoot -ThrowIfMissing
$AiMemoryRoot = Join-SharedPath @($VaultRoot, "00-System", "ai-memory")
$StructuredRoot = Join-SharedPath @($AiMemoryRoot, "structured")
$GeneratedRoot = Join-SharedPath @($AiMemoryRoot, "generated")
$StateRoot = Join-SharedPath @($AiMemoryRoot, "state")
$DreamMarkdownPath = Join-Path $GeneratedRoot "AUTO-DREAM.md"
$DreamJsonPath = Join-Path $GeneratedRoot "AUTO-DREAM.json"
$DreamStatePath = Join-Path $StateRoot "auto-dream-state.json"
$DreamLockPath = Join-Path $StateRoot "auto-dream.lock"
$TaskMemoryPath = Join-Path $StructuredRoot "task-memory.jsonl"
$ClaudeCodeStructuredPath = Join-Path $StructuredRoot "claude-code.jsonl"
$OpenClawSessionStructuredPath = Join-Path $StructuredRoot "openclaw.jsonl"
$OpenClawRunsPath = Join-Path $StructuredRoot "openclaw-runs.jsonl"
$OpenClawJobsPath = Join-Path $StructuredRoot "openclaw-jobs.jsonl"
$OpenClawBlackboardPath = Join-Path $StructuredRoot "openclaw-blackboard.jsonl"
$OpenClawJournalPath = Join-Path $StructuredRoot "openclaw-journal.jsonl"

$SourceFiles = @(
    (Join-Path $StructuredRoot "shared-inbox.jsonl"),
    (Join-Path $StructuredRoot "session-memory.jsonl"),
    (Join-Path $StructuredRoot "shared-events.jsonl"),
    $TaskMemoryPath,
    $ClaudeCodeStructuredPath,
    $OpenClawSessionStructuredPath,
    $OpenClawBlackboardPath,
    $OpenClawRunsPath,
    $OpenClawJobsPath,
    $OpenClawJournalPath
)

$lockStream = Acquire-DreamLock -LockPath $DreamLockPath
if ($null -eq $lockStream) {
    Write-Output (@{ ok = $false; skipped = $true; reason = "dream-lock-busy" } | ConvertTo-Json -Compress)
    exit 0
}

try {
    Ensure-Directory -Path $GeneratedRoot
    Ensure-Directory -Path $StateRoot

    $sourceStamp = ($SourceFiles | ForEach-Object { Get-FileStamp -Path $_ }) -join "|"
    $sourceDigest = Get-StringHash -Text $sourceStamp
    $sourceStructuredSignature = [ordered]@{
        raw = $sourceStamp
        hash = if ($sourceDigest.Length -ge 16) { $sourceDigest.Substring(0, 16) } else { $sourceDigest }
    }

    $state = $null
    if (Test-Path -LiteralPath $DreamStatePath -PathType Leaf) {
        try {
            $state = Get-Content -Raw -LiteralPath $DreamStatePath -Encoding UTF8 | ConvertFrom-Json
        } catch {
            $state = $null
        }
    }

    $lastRunAt = $null
    if ($null -ne $state -and $state.lastRunAt) {
        try {
            $lastRunAt = [datetime]::Parse([string]$state.lastRunAt)
        } catch {
            $lastRunAt = $null
        }
    }

    if (-not $Force) {
        if ($null -ne $state -and $state.sourceDigest -eq $sourceDigest -and $lastRunAt) {
            $ageHours = ((Get-Date) - $lastRunAt).TotalHours
            if ($ageHours -lt $MinHours) {
                Write-Output (@{ ok = $true; skipped = $true; reason = "dream-no-source-change"; ageHours = [math]::Round($ageHours, 2) } | ConvertTo-Json -Compress)
                exit 0
            }
        }
    }

    $durableRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "shared-inbox.jsonl"))
    $sessionRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "session-memory.jsonl"))
    $eventRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "shared-events.jsonl"))
    $taskMemoryRecords = @(Get-JsonLines -Path $TaskMemoryPath)
    if ($taskMemoryRecords.Count -eq 0) {
        $taskMemoryRecords = @(
            (Get-JsonLines -Path $OpenClawBlackboardPath) +
            (Get-JsonLines -Path $OpenClawRunsPath) +
            (Get-JsonLines -Path $OpenClawJobsPath) +
            (Get-JsonLines -Path $OpenClawJournalPath)
        )
    }
    $runRecords = @($taskMemoryRecords | Where-Object { [string]$_.source_kind -eq "run" })
    $jobRecords = @($taskMemoryRecords | Where-Object { [string]$_.source_kind -eq "cron" })
    $taskRecords = @($taskMemoryRecords | Where-Object { [string]$_.source_kind -eq "blackboard" -and [string]$_.scope -eq "task" })
    $journalRecords = @($taskMemoryRecords | Where-Object { [string]$_.source -eq "openclaw-blackboard-journal" -or [string]$_.type -eq "task-journal" })

    $totalRecords = $durableRecords.Count + $sessionRecords.Count + $eventRecords.Count + $taskMemoryRecords.Count
    if (-not $Force -and $totalRecords -lt $MinRecords) {
        Write-Output (@{ ok = $true; skipped = $true; reason = "dream-insufficient-records"; totalRecords = $totalRecords } | ConvertTo-Json -Compress)
        exit 0
    }

    $durableHighlights = @(Select-RecentUniqueRecords -Records $durableRecords -MaxItems 8)
    $sessionHighlights = @(Select-RecentUniqueRecords -Records ($sessionRecords + $eventRecords) -MaxItems 8)
    $taskHighlights = @(Select-RecentUniqueRecords -Records $taskMemoryRecords -MaxItems 10)
    $durableMap = New-KeyRecordMap -Records $durableRecords
    $typedDurableQueue = New-TypedDurableQueueItems -CandidateRecords ($sessionRecords + $eventRecords + $taskMemoryRecords) -BaselineMap $durableMap -MaxPromotions 8 -MaxRefresh 8
    $promotionCandidates = @($typedDurableQueue.promotions)
    $refreshTargets = @($typedDurableQueue.refresh)
    $durableByScope = Build-CountMap -Records $durableRecords -PropertyName "scope"
    $promotionTargetCounts = Build-CountMap -Records $promotionCandidates -PropertyName "targetScope"
    $refreshTargetCounts = Build-CountMap -Records $refreshTargets -PropertyName "targetScope"

    $generatedAt = (Get-Date).ToString("o")
    $markdownLines = New-Object System.Collections.Generic.List[string]
    $markdownLines.Add("# Auto Dream Summary") | Out-Null
    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("Generated at: $generatedAt") | Out-Null
    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Durable Candidates") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($durableHighlights.Count -eq 0) {
        $markdownLines.Add("- No durable candidates yet.") | Out-Null
    } else {
        foreach ($record in $durableHighlights) {
            $markdownLines.Add((New-BulletLine -Record $record)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Session Handoff") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($sessionHighlights.Count -eq 0) {
        $markdownLines.Add("- No recent session-layer records yet.") | Out-Null
    } else {
        foreach ($record in $sessionHighlights) {
            $markdownLines.Add((New-BulletLine -Record $record)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Task And Run Recall") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($taskHighlights.Count -eq 0) {
        $markdownLines.Add("- No task/run-layer records yet.") | Out-Null
    } else {
        foreach ($record in $taskHighlights) {
            $markdownLines.Add((New-BulletLine -Record $record)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Durable Scope Coverage") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($durableByScope.Count -eq 0) {
        $markdownLines.Add("- No durable scope coverage yet.") | Out-Null
    } else {
        foreach ($entry in $durableByScope.GetEnumerator()) {
            $markdownLines.Add(("- {0}: {1}" -f [string]$entry.Key, [int]$entry.Value)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Typed Durable Promotion Queue") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($promotionCandidates.Count -eq 0) {
        $markdownLines.Add("- No fresh cross-layer signals need typed durable promotion right now.") | Out-Null
    } else {
        foreach ($entry in $promotionTargetCounts.GetEnumerator()) {
            $markdownLines.Add(("- target={0}: {1}" -f [string]$entry.Key, [int]$entry.Value)) | Out-Null
        }
        foreach ($record in $promotionCandidates) {
            $markdownLines.Add((New-TypedQueueBulletLine -Item $record)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Typed Durable Refresh Queue") | Out-Null
    $markdownLines.Add("") | Out-Null
    if ($refreshTargets.Count -eq 0) {
        $markdownLines.Add("- No older durable signals appear to need typed refresh right now.") | Out-Null
    } else {
        foreach ($entry in $refreshTargetCounts.GetEnumerator()) {
            $markdownLines.Add(("- target={0}: {1}" -f [string]$entry.Key, [int]$entry.Value)) | Out-Null
        }
        foreach ($record in $refreshTargets) {
            $markdownLines.Add((New-TypedQueueBulletLine -Item $record)) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Observations") | Out-Null
    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("- Durable signals should usually come from `shared-inbox.jsonl` and be promoted carefully into human-edited notes.") | Out-Null
    $markdownLines.Add("- Session handoff combines session memory and recent bus events, so long-running work can restart with less context decay.") | Out-Null
    $markdownLines.Add("- OpenClaw task, run, job, and journal records are treated as first-class recall targets, not just prompt snippets.") | Out-Null
    $markdownLines.Add("- Typed durable promotion only routes into `user`, `feedback`, `project`, and `reference`, so durable writeback targets stay auditable.") | Out-Null
    $markdownLines.Add("- Typed promotion queue items now carry source layer, source scope, target scope, source type, source confidence, source record id, and a promotion reason for downstream writeback decisions.") | Out-Null
    $markdownLines.Add("- Typed refresh targets are newer task/session/event signals that overlap an older durable memory after target-scope routing and may deserve a writeback update.") | Out-Null

    $markdown = ($markdownLines.ToArray() -join "`n").Trim() + "`n"
    Write-Text -Path $DreamMarkdownPath -Content $markdown

    $jsonPayload = [ordered]@{
        generatedAt = $generatedAt
        contractVersion = 2
        recordSchemaVersion = 2
        sourceDigest = $sourceDigest
        sourceStructuredSignature = $sourceStructuredSignature
        counts = [ordered]@{
            durable = $durableRecords.Count
            session = $sessionRecords.Count
            events = $eventRecords.Count
            runs = $runRecords.Count
            tasks = $taskRecords.Count
            jobs = $jobRecords.Count
            journal = $journalRecords.Count
            taskMemory = $taskMemoryRecords.Count
            durableByScope = $durableByScope
            typedPromotionTargets = $promotionTargetCounts
            typedRefreshTargets = $refreshTargetCounts
            total = $totalRecords
        }
        highlights = [ordered]@{
            durable = @($durableHighlights | ForEach-Object {
                [ordered]@{
                    tool = $_.tool
                    scope = $_.scope
                    title = $_.title
                    t = $_.t
                }
            })
            session = @($sessionHighlights | ForEach-Object {
                [ordered]@{
                    tool = $_.tool
                    title = $_.title
                    t = $_.t
                }
            })
            tasks = @($taskHighlights | ForEach-Object {
                [ordered]@{
                    tool = $_.tool
                    task_state = $_.task_state
                    title = $_.title
                    t = $_.t
                }
            })
            durableByScope = $durableByScope
            promotions = @($promotionCandidates | ForEach-Object {
                [ordered]@{
                    tool = $_.tool
                    sourceLayer = $_.sourceLayer
                    sourceScope = $_.sourceScope
                    targetScope = $_.targetScope
                    sourceKind = $_.sourceKind
                    sourceType = $_.sourceType
                    sourceConfidence = $_.sourceConfidence
                    sourceRecordId = $_.sourceRecordId
                    promotionKey = $_.promotionKey
                    promotionReason = $_.promotionReason
                    title = $_.title
                    t = $_.t
                }
            })
            refresh = @($refreshTargets | ForEach-Object {
                [ordered]@{
                    tool = $_.tool
                    sourceLayer = $_.sourceLayer
                    sourceScope = $_.sourceScope
                    targetScope = $_.targetScope
                    sourceKind = $_.sourceKind
                    sourceType = $_.sourceType
                    sourceConfidence = $_.sourceConfidence
                    sourceRecordId = $_.sourceRecordId
                    promotionKey = $_.promotionKey
                    promotionReason = $_.promotionReason
                    refreshOf = $_.refreshOf
                    title = $_.title
                    t = $_.t
                }
            })
        }
    }

    Write-Text -Path $DreamJsonPath -Content (($jsonPayload | ConvertTo-Json -Depth 8) + "`n")
    Write-Text -Path $DreamStatePath -Content (([ordered]@{
        lastRunAt = $generatedAt
        sourceDigest = $sourceDigest
        totalRecords = $totalRecords
    } | ConvertTo-Json -Depth 5) + "`n")

    Write-Output (($jsonPayload | ConvertTo-Json -Depth 8))
} finally {
    Release-DreamLock -Stream $lockStream -LockPath $DreamLockPath
}
