param(
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Writeback,
    [switch]$SkipArchive,
    [int]$MinHours = 24,
    [int]$MinRecords = 10
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$UnixEpochTicks = ([datetimeoffset]::Parse("1970-01-01T00:00:00+00:00", [System.Globalization.CultureInfo]::InvariantCulture)).Ticks

$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "../../bus/runtime-platform.ps1")
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

function Get-ContentHash {
    param([AllowEmptyString()][string]$Text)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
        $hashBytes = $sha256.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-UnixTimeMillisecondsString {
    param([Parameter(Mandatory = $true)][datetime]$TimestampUtc)

    $milliseconds = [decimal]($TimestampUtc.ToUniversalTime().Ticks - $UnixEpochTicks) / [decimal]10000
    return [string]::Format(
        [System.Globalization.CultureInfo]::InvariantCulture,
        "{0:0.###}",
        $milliseconds
    )
}

function Get-FileStamp {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return "__missing__"
    }

    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) {
        $entries = Get-ChildItem -LiteralPath $Path -Force | Sort-Object Name
        $meta = foreach ($entry in $entries) {
            try {
                $mtimeMs = Get-UnixTimeMillisecondsString -TimestampUtc $entry.LastWriteTimeUtc
                $size = if ($entry.PSIsContainer) { 0 } else { [int64]$entry.Length }
                "{0}:{1}:{2}" -f $entry.Name, $mtimeMs, $size
            } catch {
                "{0}:missing" -f $entry.Name
            }
        }
        $hash = Get-StringHash -Text ([string]::Join("|", @($meta)))
        return "{0}/dir:{1}:{2}entries" -f $item.Name, $hash, @($entries).Count
    }

    $content = Read-Text -Path $Path
    $hash = Get-StringHash -Text $content
    return "{0}:{1}:{2}" -f $item.Name, $hash, $item.Length
}

function SafeProp {
    param([Parameter(Mandatory = $true)][object]$Record, [Parameter(Mandatory = $true)][string]$Name)
    try {
        return [string]$Record.$Name
    } catch {
        return ""
    }
}

function New-BulletLine {
    param([Parameter(Mandatory = $true)][object]$Record)

    $tool = if ([string]::IsNullOrWhiteSpace((SafeProp $Record "tool"))) { "unknown" } else { SafeProp $Record "tool" }
    $scope = if ([string]::IsNullOrWhiteSpace((SafeProp $Record "scope"))) { "" } else { " [$(SafeProp $Record 'scope')]" }
    $title = if ([string]::IsNullOrWhiteSpace((SafeProp $Record "title"))) { SafeProp $Record "content" } else { SafeProp $Record "title" }
    $taskState = if ([string]::IsNullOrWhiteSpace((SafeProp $Record "task_state"))) { "" } else { " {$(SafeProp $Record 'task_state')}" }
    return "- [$tool]$scope$taskState $($title.Trim())"
}

function Normalize-RecordText {
    param([Parameter(Mandatory = $true)][object]$Record)

    $parts = @(
        (SafeProp $Record "project"),
        (SafeProp $Record "title"),
        (SafeProp $Record "content"),
        (SafeProp $Record "scope"),
        (SafeProp $Record "task_state")
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

    $effectiveScope = if ([string]::IsNullOrWhiteSpace($ScopeOverride)) { SafeProp $Record "scope" } else { $ScopeOverride }
    $prefix = "{0}|{1}" -f ((SafeProp $Record "project").ToLowerInvariant()), ($effectiveScope.ToLowerInvariant())
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
    param([object[]]$Records = @())

    if ($null -eq $Records -or @($Records).Count -eq 0) {
        return @{}
    }

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
        [object[]]$CandidateRecords = @(),
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [int]$MaxItems = 8
    )

    if ($null -eq $CandidateRecords -or @($CandidateRecords).Count -eq 0) {
        return @()
    }

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
        [object[]]$CandidateRecords = @(),
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [int]$MaxItems = 8
    )

    if ($null -eq $CandidateRecords -or @($CandidateRecords).Count -eq 0) {
        return @()
    }

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
        [object[]]$Records = @(),
        [int]$MaxItems = 8
    )

    if ($null -eq $Records -or @($Records).Count -eq 0) {
        return @()
    }

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
        [object[]]$CandidateRecords = @(),
        [Parameter(Mandatory = $true)][hashtable]$BaselineMap,
        [Parameter(Mandatory = $false)][hashtable]$ExistingByKey = @{},
        [Parameter(Mandatory = $false)][System.Collections.Generic.HashSet[string]]$DurableContentHashSet,
        [int]$MaxPromotions = 8,
        [int]$MaxRefresh = 8,
        $PromoteMaxPerScope = @{},
        $RefreshMaxPerScope = @{}
    )

    if ($null -eq $CandidateRecords -or @($CandidateRecords).Count -eq 0) {
        return @{ promotions = @(); refresh = @(); collisions = @() }
    }

    $promotions = New-Object System.Collections.Generic.List[object]
    $refresh = New-Object System.Collections.Generic.List[object]
    $collisions = New-Object System.Collections.Generic.List[object]
    $seenPromotions = @{}
    $seenRefresh = @{}

    $sortedCandidates = @($CandidateRecords | Sort-Object { [string]$_.id } | Sort-Object { try { [double]$_.sourceConfidence } catch { 0.0 } } -Descending)
    $scopeCounts = @{}
    $refreshScopeCounts = @{}
    foreach ($record in $sortedCandidates) {
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
            $sourceRecordId = [string]$record.id
            $sourceContent = [string]$record.content
            $sourceContentHash = Get-ContentHash -Text $sourceContent
            $itemNewId = ("dream-" + (Get-ContentHash -Text ($sourceRecordId + $key)).Substring(0, 16)).ToLowerInvariant()
            $idDedup = $ExistingByKey.ContainsKey($itemNewId)
            $hashDedup = $null -ne $DurableContentHashSet -and $DurableContentHashSet.Contains($sourceContentHash.ToLowerInvariant())
            $passesDedup = -not $idDedup -and -not $hashDedup
            $atMax = $promotions.Count -ge $MaxPromotions
            $scopeCap = $MaxPromotions
            if ($null -ne $PromoteMaxPerScope -and $PromoteMaxPerScope.Count -gt 0) {
                $v = $null
                try { $v = $PromoteMaxPerScope[$targetScope] } catch {}
                if ($null -ne $v -and $v -gt 0) { $scopeCap = $v }
            }
            $currentScopeCount = 0
            if ($scopeCounts.ContainsKey($targetScope)) { $currentScopeCount = $scopeCounts[$targetScope] }
            $scopeAtMax = $currentScopeCount -ge $scopeCap
            $keySeen = $seenPromotions.ContainsKey($key)
            if ($keySeen) {
                $collidingRecord = $seenPromotions[$key]
                $collidingId = if ($collidingRecord.PSObject.Properties.Name -contains "sourceRecordId") {
                    [string]$collidingRecord.sourceRecordId
                } else {
                    [string]$collidingRecord.id
                }
                $collisions.Add([ordered]@{
                    tool = [string]$record.tool
                    title = [string]$record.title
                    sourceLayer = $sourceLayer
                    sourceScope = [string]$record.scope
                    targetScope = $targetScope
                    sourceKind = [string]$record.source_kind
                    sourceType = $sourceType
                    sourceConfidence = $sourceConfidence
                    sourceRecordId = [string]$record.id
                    promotionKey = $key
                    collidingWithId = $collidingId
                    collidingWithTitle = if ($collidingRecord.PSObject.Properties.Name -contains "title") { [string]$collidingRecord.title } else { "" }
                    collisionType = "promotion-key-collision"
                    note = "same promotion key as higher-confidence candidate; use sourceRecordId to disambiguate manually"
                }) | Out-Null
                continue
            }
            $wouldSkip = $atMax -or $scopeAtMax
            if ($wouldSkip) {
                continue
            }
            if (-not $passesDedup) {
                continue
            }
            if ($null -ne $DurableContentHashSet) { $DurableContentHashSet.Add($sourceContentHash.ToLowerInvariant()) | Out-Null }
            $currentScopeCount = if ($scopeCounts.ContainsKey($targetScope)) { $scopeCounts[$targetScope] } else { 0 }
            $scopeCounts[$targetScope] = $currentScopeCount + 1
            $newItem = [ordered]@{
                tool = [string]$record.tool
                title = [string]$record.title
                t = [string]$record.t
                sourceLayer = $sourceLayer
                sourceScope = [string]$record.scope
                targetScope = $targetScope
                sourceKind = [string]$record.source_kind
                sourceType = $sourceType
                sourceConfidence = $sourceConfidence
                sourceRecordId = $sourceRecordId
                promotionKey = $key
                newId = $itemNewId
                contentHash = $sourceContentHash
                promotionReason = Get-PromotionReason -Record $record -TargetScope $targetScope -SourceLayer $sourceLayer
            }
            $seenPromotions[$key] = $newItem
            $promotions.Add($newItem) | Out-Null
            continue
        }

        $refreshAtMax = $refresh.Count -ge $MaxRefresh
        $refreshScopeCap = $MaxRefresh
        if ($null -ne $RefreshMaxPerScope -and $RefreshMaxPerScope.Count -gt 0) {
            $rv = $null
            try { $rv = $RefreshMaxPerScope[$targetScope] } catch {}
            if ($null -ne $rv -and $rv -gt 0) { $refreshScopeCap = $rv }
        }
        $currentRefreshScopeCount = 0
        if ($refreshScopeCounts.ContainsKey($targetScope)) { $currentRefreshScopeCount = $refreshScopeCounts[$targetScope] }
        $refreshScopeAtMax = $currentRefreshScopeCount -ge $refreshScopeCap
        if ($refreshAtMax -or $refreshScopeAtMax -or $seenRefresh.ContainsKey($key)) {
            continue
        }

        $baselineTs = Get-RecordTimestampUtc -Record $baseline
        if ($candidateTs -le $baselineTs) {
            continue
        }

        $sourceRecordId = [string]$record.id
        $refreshContentHash = (Get-ContentHash -Text ([string]$record.content)).ToLowerInvariant()
        $itemNewId = ("dream-" + (Get-ContentHash -Text ($sourceRecordId + $key)).Substring(0, 16)).ToLowerInvariant()
        $hashInSet = $null -ne $DurableContentHashSet -and $DurableContentHashSet.Contains($refreshContentHash)
        if ($null -ne $DurableContentHashSet -and $DurableContentHashSet.Contains($refreshContentHash)) {
            continue
        }
        if ($null -ne $DurableContentHashSet) { $DurableContentHashSet.Add($refreshContentHash) | Out-Null }
        $seenRefresh[$key] = $true
        $currentRefreshScopeCount = if ($refreshScopeCounts.ContainsKey($targetScope)) { $refreshScopeCounts[$targetScope] } else { 0 }
        $refreshScopeCounts[$targetScope] = $currentRefreshScopeCount + 1
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
            sourceRecordId = $sourceRecordId
            promotionKey = $key
            newId = $itemNewId
            contentHash = $refreshContentHash
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
        collisions = @($collisions.ToArray())
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

$LockExpiryMinutes = 60

$DurablePromoteMaxPerScope = @{
    user      = 3
    feedback  = 3
    project   = 4
    reference = 2
}

$DurableRefreshMaxPerScope = @{
    user      = 2
    feedback  = 2
    project   = 3
    reference = 1
}

function Write-TypedDurableJsonl {
    param(
        [object[]]$PromotionQueue = @(),
        [object[]]$RefreshQueue = @(),
        [Parameter(Mandatory = $true)][hashtable]$AllRecordsByPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [switch]$DryRun
    )

    $results = New-Object System.Collections.Generic.List[object]
    $conflicts = New-Object System.Collections.Generic.List[object]
    $existingRecords = @(Get-JsonLines -Path $TargetPath)
    $existingByKey = @{}
    foreach ($rec in $existingRecords) {
        if (-not [string]::IsNullOrWhiteSpace([string]$rec.id)) {
            $existingByKey[$rec.id] = $rec
        }
    }

    $recordsToWrite = @()
    $allItems = @($PromotionQueue) + @($RefreshQueue)

    foreach ($item in $allItems) {
        $sourceRecord = $null
        foreach ($path in $AllRecordsByPath.Keys) {
            $recs = $AllRecordsByPath[$path]
            foreach ($rec in $recs) {
                if ([string]$rec.id -eq [string]$item.sourceRecordId) {
                    $sourceRecord = $rec
                    break
                }
            }
            if ($null -ne $sourceRecord) { break }
        }

        $contentText = if ($null -ne $sourceRecord) { [string]$sourceRecord.content } else { "" }
        $titleText = if ($null -ne $sourceRecord) { [string]$sourceRecord.title } else { [string]$item.title }
        $newId = $item.newId
        $itemContentHash = $item.contentHash
        $newContentHash = if (-not [string]::IsNullOrWhiteSpace($itemContentHash)) { $itemContentHash } else { Get-ContentHash -Text $contentText }
        $isRefresh = ($null -ne $item.PSObject.Properties['refreshOf']) -and ($null -ne $item.refreshOf)
        $inExisting = $existingByKey.ContainsKey($newId)
        $conflictWith = @()
        $action = "append"
        $conflictExistingRecord = $null

        if ($inExisting) {
            $existingRecord = $existingByKey[$newId]
            $existingHash = SafeProp $existingRecord "content_hash"
            if (-not [string]::IsNullOrWhiteSpace($existingHash) -and $existingHash -eq $newContentHash) {
                $action = "skip-identical"
            } elseif (-not [string]::IsNullOrWhiteSpace($existingHash)) {
                $conflictWith = @([string]$existingRecord.id)
                $action = "append-conflict"
                $conflictExistingRecord = $existingRecord
            } else {
                $existingContent = SafeProp $existingRecord "content"
                $existingComputedHash = Get-ContentHash -Text $existingContent
                if ($existingComputedHash -eq $newContentHash) {
                    $action = "skip-identical"
                } else {
                    $conflictWith = @([string]$existingRecord.id)
                    $action = "append-conflict"
                    $conflictExistingRecord = $existingRecord
                }
            }
        }

        if ($action -eq "skip-identical") {
            $results.Add([ordered]@{ action = "skip"; id = $newId; reason = "content-identical" }) | Out-Null
            continue
        }

        $promotionMeta = [ordered]@{
            version = 1
            durable_type = $item.targetScope
            key = $item.promotionKey
            reason = $item.promotionReason
            source_layer = $item.sourceLayer
            source_record_id = $item.sourceRecordId
            is_refresh = $isRefresh
        }
        if ($isRefresh -and $null -ne $item.refreshOf) {
            $promotionMeta["refresh_of_id"] = $item.refreshOf.id
            $promotionMeta["refresh_of_t"] = $item.refreshOf.t
        }
        if ($conflictWith.Count -gt 0) {
            $promotionMeta["conflict_with"] = $conflictWith
        }
        if ($null -ne $conflictExistingRecord) {
            $existingConfRaw = SafeProp $conflictExistingRecord.metadata.promotion "source_confidence"
            $existingConf = 0.0
            if ($null -ne $existingConfRaw) {
                try { $existingConf = [double]$existingConfRaw } catch {}
            }
            $newConf = 0.0
            try { $newConf = [double]$item.sourceConfidence } catch {}
            if ($newConf -gt $existingConf) {
                $promotionMeta["supersedes"] = [string]$conflictExistingRecord.id
                $conflicts.Add([ordered]@{
                    newId = $newId
                    supersededId = [string]$conflictExistingRecord.id
                    newConfidence = $newConf
                    existingConfidence = $existingConf
                    outcome = "superseded"
                }) | Out-Null
            } else {
                $conflicts.Add([ordered]@{
                    newId = $newId
                    supersededId = [string]$conflictExistingRecord.id
                    newConfidence = $newConf
                    existingConfidence = $existingConf
                    outcome = "kept_original"
                }) | Out-Null
            }
        }

        $newRecord = [ordered]@{
            id = $newId
            type = $item.sourceType
            scope = $item.targetScope
            memory_level = "durable"
            source_kind = "writeback"
            tool = $item.tool
            title = $titleText
            content = $contentText
            t = (Get-Date).ToUniversalTime().ToString("o")
            content_hash = $newContentHash
            metadata = [ordered]@{
                promotion = $promotionMeta
            }
        }

        if ($DryRun) {
            $results.Add([ordered]@{ action = $action; id = $newId; targetScope = $item.targetScope; promotionReason = $item.promotionReason; isRefresh = $isRefresh; record = $newRecord }) | Out-Null
        } else {
            $jsonLine = ($newRecord | ConvertTo-Json -Compress) + "`n"
            [System.IO.File]::AppendAllText($TargetPath, $jsonLine, $Utf8NoBom)
            $existingByKey[$newId] = $newRecord
            $results.Add([ordered]@{ action = $action; id = $newId; targetScope = $item.targetScope; promotionReason = $item.promotionReason; isRefresh = $isRefresh }) | Out-Null
        }
    }

    $totalConflicts = $conflicts.Count
    $supersededCount = 0
    $keptOriginalCount = 0
    foreach ($c in $conflicts) {
        if ($c.outcome -eq "superseded") { $supersededCount++ } else { $keptOriginalCount++ }
    }
    return [ordered]@{
        results = $results.ToArray()
        conflicts = $conflicts.ToArray()
        conflictResolution = [ordered]@{
            total_conflicts = $totalConflicts
            superseded = $supersededCount
            kept_original = $keptOriginalCount
        }
    }
}

function Merge-DurableMemoryIndex {
    param(
        [object[]]$WriteResults = @(),
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [switch]$DryRun
    )

    if ($null -eq $WriteResults -or @($WriteResults).Count -eq 0) {
        return @{ appended = 0; skipped = 0 }
    }

    $entries = New-Object System.Collections.Generic.List[string]
    $appended = 0

    foreach ($result in $WriteResults) {
        if ($result.action -eq "skip") { continue }
        $scopeTag = "[{0}]" -f $result.targetScope
        $rawReason = if ($null -ne $result.promotionReason -and $result.promotionReason -ne "") { " ({0})" -f $result.promotionReason } else { "" }
        if ($result.isRefresh) {
            $line = "- {0} promotion_key: {1} — source: dream-refresh — refreshed: {2}{3}" -f $scopeTag, $result.id, (Get-Date).ToString("yyyy-MM-dd"), $rawReason
        } else {
            $line = "- {0} promotion_key: {1} — source: dream — promoted: {2}{3}" -f $scopeTag, $result.id, (Get-Date).ToString("yyyy-MM-dd"), $rawReason
        }
        $entries.Add($line) | Out-Null
        $appended++
    }

    if ($entries.Count -eq 0) { return @{ appended = 0; entries = @() } }

    if ($DryRun) {
        return @{ appended = $appended; entries = @($entries.ToArray()); dryRun = $true }
    }

    Ensure-Directory -Path (Split-Path -Parent $IndexPath)
    $sep = "`n"
    [System.IO.File]::AppendAllText($IndexPath, ($sep + ($entries.ToArray() -join $sep) + "`n"), $Utf8NoBom)
    return @{ appended = $appended; entries = @($entries.ToArray()); dryRun = $false }
}

function Build-AllRecordsByPath {
    param(
        [object[]]$SourceFiles = @()
    )

    if ($null -eq $SourceFiles -or @($SourceFiles).Count -eq 0) {
        return @{}
    }

    $byPath = @{}
    foreach ($filePath in $SourceFiles) {
        if (Test-Path -LiteralPath $filePath -PathType Leaf) {
            $byPath[$filePath] = @(Get-JsonLines -Path $filePath)
        }
    }
    return $byPath
}

function Write-LockMeta {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream
    )

    $now = (Get-Date).ToUniversalTime().ToString("o")
    $pidLine = (@{ pid = $PID; mtime = $now } | ConvertTo-Json -Compress) + "`n"
    $Stream.SetLength(0)
    $sw = [System.IO.StreamWriter]::new($Stream, $Utf8NoBom)
    $sw.Write($pidLine)
    $sw.Flush()
}

function Acquire-DreamLock {
    param([Parameter(Mandatory = $true)][string]$LockPath)

    Ensure-Directory -Path (Split-Path -Parent $LockPath)
    try {
        $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        Write-LockMeta -Stream $lockStream
        return $lockStream
    } catch {
        # File.Open failed (IO conflict) — try to read lock metadata via a FileStream with shared-read
        if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
            $content = ""
            try {
                $content = [System.IO.File]::ReadAllText($LockPath, [System.Text.Encoding]::UTF8)
            } catch {
                # Can't read either — another process holds exclusive lock, give up
                return $null
            }
            if (-not [string]::IsNullOrWhiteSpace($content)) {
                try {
                    $meta = $content | ConvertFrom-Json
                    $lockPid = [int]$meta.pid
                    $lockMtime = [datetime]::ParseExact([string]$meta.mtime, "o", $null)
                    if (((Get-Date) - $lockMtime).TotalMinutes -gt $LockExpiryMinutes) {
                        Write-Verbose "Lock stale (PID $lockPid, mtime=$($lockMtime.ToString('o'))), breaking."
                        try {
                            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
                        } catch {
                        }
                        try {
                            $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
                            Write-LockMeta -Stream $lockStream
                            return $lockStream
                        } catch {
                            return $null
                        }
                    }
                } catch {
                }
            }
        }
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
$MemoryIndexPath = Join-Path $GeneratedRoot "MEMORY.md"
$DreamLockPath = Join-Path (Join-Path $VaultRoot ".lock") "consolidation.lock"
$TaskMemoryPath = Join-Path $StructuredRoot "task-memory.jsonl"
$ClaudeCodeStructuredPath = Join-Path $StructuredRoot "claude-code.jsonl"
$OpenClawSessionStructuredPath = Join-Path $StructuredRoot "openclaw.jsonl"
$OpenClawRunsPath = Join-Path $StructuredRoot "openclaw-runs.jsonl"
$OpenClawJobsPath = Join-Path $StructuredRoot "openclaw-jobs.jsonl"
$OpenClawBlackboardPath = Join-Path $StructuredRoot "openclaw-blackboard.jsonl"
$OpenClawJournalPath = Join-Path $StructuredRoot "openclaw-journal.jsonl"
$LogsPath = Join-Path $StructuredRoot "logs"

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
    $OpenClawJournalPath,
    $LogsPath
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
    $runRecords = @($taskMemoryRecords | Where-Object { $_ -is [PSCustomObject] -and ($_.PSObject.Properties.Name -contains "source_kind") -and [string]$_.source_kind -eq "run" })
    $jobRecords = @($taskMemoryRecords | Where-Object { $_ -is [PSCustomObject] -and ($_.PSObject.Properties.Name -contains "source_kind") -and [string]$_.source_kind -eq "cron" })
    $taskRecords = @($taskMemoryRecords | Where-Object { $_ -is [PSCustomObject] -and ($_.PSObject.Properties.Name -contains "source_kind") -and [string]$_.source_kind -eq "blackboard" -and [string]$_.scope -eq "task" })
    $journalRecords = @($taskMemoryRecords | Where-Object { $_ -is [PSCustomObject] -and ([string]$_.source -eq "openclaw-blackboard-journal" -or [string]$_.type -eq "task-journal") })

    $totalRecords = $durableRecords.Count + $sessionRecords.Count + $eventRecords.Count + $taskMemoryRecords.Count
    if (-not $Force -and $totalRecords -lt $MinRecords) {
        Write-Output (@{ ok = $true; skipped = $true; reason = "dream-insufficient-records"; totalRecords = $totalRecords } | ConvertTo-Json -Compress)
        exit 0
    }

    $durableHighlights = @(Select-RecentUniqueRecords -Records $durableRecords -MaxItems 8)
    $sessionHighlights = @(Select-RecentUniqueRecords -Records ($sessionRecords + $eventRecords) -MaxItems 8)
    $taskHighlights = @(Select-RecentUniqueRecords -Records $taskMemoryRecords -MaxItems 10)
    $durableMap = New-KeyRecordMap -Records $durableRecords
    # Build ExistingByKey and durableContentHashSet from dream-inbox.jsonl
    # - ExistingByKey: dedup by dream-xxx ID (stable across session rebuilds)
    # - durableContentHashSet: dedup by content hash (handles same content with different session IDs)
    $dreamInboxPath = Join-Path $StructuredRoot "dream-inbox.jsonl"
    $existingByKey = @{}
    $durableContentHashSet = New-Object System.Collections.Generic.HashSet[string]
    if (Test-Path -LiteralPath $dreamInboxPath) {
        foreach ($rec in @(Get-JsonLines -Path $dreamInboxPath)) {
            $recId = SafeProp $rec "id"
            if (-not [string]::IsNullOrWhiteSpace($recId)) {
                $existingByKey[$recId] = $rec
            }
            $ch = SafeProp $rec "content_hash"
            if (-not [string]::IsNullOrWhiteSpace($ch)) {
                $durableContentHashSet.Add($ch.ToLowerInvariant()) | Out-Null
            } else {
                $existingContent = SafeProp $rec "content"
                if (-not [string]::IsNullOrWhiteSpace($existingContent)) {
                    $durableContentHashSet.Add((Get-ContentHash -Text $existingContent).ToLowerInvariant()) | Out-Null
                }
            }
        }
    }
    $typedDurableQueue = New-TypedDurableQueueItems -CandidateRecords ($sessionRecords + $eventRecords + $taskMemoryRecords) -BaselineMap $durableMap -ExistingByKey $existingByKey -DurableContentHashSet $durableContentHashSet -MaxPromotions 8 -MaxRefresh 8 -PromoteMaxPerScope $DurablePromoteMaxPerScope -RefreshMaxPerScope $DurableRefreshMaxPerScope
    $promotionCandidates = @($typedDurableQueue.promotions)
    $refreshTargets = @($typedDurableQueue.refresh)
    $durableByScope = Build-CountMap -Records $durableRecords -PropertyName "scope"
    $promotionTargetCounts = Build-CountMap -Records $promotionCandidates -PropertyName "targetScope"
    $refreshTargetCounts = Build-CountMap -Records $refreshTargets -PropertyName "targetScope"

    # ── Phase 1b: Trigger idempotent archival before promotion (Q1 fix: hygiene reports, dream triggers)
    $archivalScript = Join-Path $PSScriptRoot "memory-archival.js"
    if (-not $SkipArchive -and -not $DryRun -and (Test-Path -LiteralPath $archivalScript -PathType Leaf)) {
        try {
            $archivalJob = Start-Process -FilePath "node" -ArgumentList @($archivalScript, "--vault-root", $VaultRoot, "--trigger", "dream") -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
            Write-Verbose "Archival triggered: pid=$($archivalJob.Id)"
        } catch {
            Write-Verbose "Archival trigger failed (non-blocking): $_"
        }
    }

    $generatedAt = (Get-Date).ToString("o")

    # --- Durable writeback (Phase 2 writeback) ---
    $writebackResults = $null
    $memoryIndexResults = $null
    if ($Writeback -or $DryRun) {
        $allSourceFiles = @(
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
        $allRecordsByPath = Build-AllRecordsByPath -SourceFiles $allSourceFiles
        $sharedInboxPath = Join-Path $StructuredRoot "shared-inbox.jsonl"
        $dreamInboxPath = Join-Path $StructuredRoot "dream-inbox.jsonl"

        $writebackRaw = Write-TypedDurableJsonl `
            -PromotionQueue $promotionCandidates `
            -RefreshQueue $refreshTargets `
            -AllRecordsByPath $allRecordsByPath `
            -TargetPath $dreamInboxPath `
            -DryRun:$DryRun
        $writebackResultsArray = @($writebackRaw.results)
        $writebackResults = $writebackResultsArray
        $writebackConflictResolution = $writebackRaw.conflictResolution

        $memoryIndexResults = Merge-DurableMemoryIndex `
            -WriteResults $writebackResultsArray `
            -IndexPath $MemoryIndexPath `
            -DryRun:$DryRun
    }

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

    $collisions = @($typedDurableQueue.collisions)
    $collisionCount = $collisions.Count
    if ($collisionCount -gt 0) {
        $markdownLines.Add("") | Out-Null
        $markdownLines.Add("## Promotion Key Collisions") | Out-Null
        $markdownLines.Add("") | Out-Null
        $markdownLines.Add("- $collisionCount record(s) share a promotion key with a higher-confidence candidate and were skipped.") | Out-Null
        $markdownLines.Add("- Use ``collidingWithId`` in the JSON output to review which record won the key.") | Out-Null
        foreach ($col in $collisions) {
            $wid = [string]$col.collidingWithId
            $cid = [string]$col.sourceRecordId
            $ttl = [string]$col.collidingWithTitle
            if ([string]::IsNullOrWhiteSpace($ttl)) { $ttl = $wid }
            $ctitle = [string]$col.title
            if ([string]::IsNullOrWhiteSpace($ctitle)) { $ctitle = $cid }
            $tscp = [string]$col.targetScope
            $scp = [string]$col.sourceScope
            $bullet = "- [collision] $ctitle ($scp -> $tscp): ``$cid`` skipped -- same key as ``$ttl``"
            $markdownLines.Add($bullet) | Out-Null
        }
    }

    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("## Observations") | Out-Null
    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("- Durable signals should usually come from ``shared-inbox.jsonl`` and be promoted carefully into human-edited notes.") | Out-Null
    $markdownLines.Add("- Session handoff combines session memory and recent bus events, so long-running work can restart with less context decay.") | Out-Null
    $markdownLines.Add("- OpenClaw task, run, job, and journal records are treated as first-class recall targets, not just prompt snippets.") | Out-Null
    $markdownLines.Add("- Typed durable promotion only routes into ``user``, ``feedback``, ``project``, and ``reference``, so durable writeback targets stay auditable.") | Out-Null
    $markdownLines.Add("- Typed promotion queue items now carry source layer, source scope, target scope, source type, source confidence, source record id, and a promotion reason for downstream writeback decisions.") | Out-Null
    $markdownLines.Add("- Typed refresh targets are newer task/session/event signals that overlap an older durable memory after target-scope routing and may deserve a writeback update.") | Out-Null
    if ($null -ne $writebackResults -and $writebackResults.Count -gt 0) {
        $wbApplies = @($writebackResults | Where-Object { (SafeProp $_ "action") -ne "skip" })
        $wbSkips = @($writebackResults | Where-Object { (SafeProp $_ "action") -eq "skip" })
        if ($DryRun) {
            $dryRunTag = " [DRY-RUN — no files written]"
            $markdownLines.Add("") | Out-Null
            $markdownLines.Add("## Writeback Preview$dryRunTag") | Out-Null
            $markdownLines.Add("") | Out-Null
            $markdownLines.Add(("- Would write {0} records, skip {1} (identical):" -f $wbApplies.Count, $wbSkips.Count)) | Out-Null
        } else {
            $markdownLines.Add("") | Out-Null
            $markdownLines.Add("## Writeback Summary") | Out-Null
            $markdownLines.Add("") | Out-Null
            $markdownLines.Add(("- Wrote {0} records to shared-inbox.jsonl" -f $wbApplies.Count)) | Out-Null
            $markdownLines.Add(("- Appended {0} entries to MEMORY.md" -f $memoryIndexResults.appended)) | Out-Null
            if ($wbSkips.Count -gt 0) {
                $markdownLines.Add(("- Skipped {0} records (content identical to existing)" -f $wbSkips.Count)) | Out-Null
            }
        }
        foreach ($result in $wbApplies) {
            $scope = if ([string]::IsNullOrWhiteSpace([string](SafeProp $result "targetScope"))) { "?" } else { [string](SafeProp $result "targetScope") }
            $action = SafeProp $result "action"
            $pr = SafeProp $result "promotionReason"
            $detailReason = if ($null -ne $pr -and $pr -ne "") { " ($pr)" } else { "" }
            $markdownLines.Add(("- [{0}/{1}] id={2}{3}" -f $scope, $action, (SafeProp $result "id"), $detailReason)) | Out-Null
        }
    }

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
            promotionKeyCollisions = @($typedDurableQueue.collisions | ForEach-Object {
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
                    collidingWithId = $_.collidingWithId
                    collidingWithTitle = $_.collidingWithTitle
                    collisionType = $_.collisionType
                    title = $_.title
                }
            })
        }
        writeback = if ($null -ne $writebackResults -and @($writebackResults).Count -gt 0) {
            [ordered]@{
                dryRun = [bool]$DryRun
                records = @($writebackResults | ForEach-Object -Process {
                    $item = $_
                    [ordered]@{
                        action = SafeProp $item "action"
                        id = SafeProp $item "id"
                        targetScope = SafeProp $item "targetScope"
                        promotionReason = SafeProp $item "promotionReason"
                        isRefresh = [bool](SafeProp $item "isRefresh")
                    }
                })
                memoryIndex = if ($null -ne $memoryIndexResults) {
                    [ordered]@{
                        appended = $memoryIndexResults.appended
                        dryRun = [bool]$DryRun
                    }
                } else { $null }
                conflictResolution = $writebackConflictResolution
            }
        } else { $null }
    }

    $jsonPayload.promotionQueueScopeDiversity = @{}
    foreach ($scope in @('user', 'feedback', 'project', 'reference')) {
        $count = 0
        foreach ($item in $typedDurableQueue.promotions) {
            if ([string]$item.targetScope -eq $scope) { $count++ }
        }
        $jsonPayload.promotionQueueScopeDiversity[$scope] = $count
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
