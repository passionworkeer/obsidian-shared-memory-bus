# sync-claudemem-to-obsidian.ps1
# Sync claude-mem observations into Obsidian structured memory.
param(
    [int]$MaxRecordsPerRun = 500
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$helperPath = @(
    (Join-Path $PSScriptRoot "runtime-platform.ps1"),
    (Join-Path $PSScriptRoot "../bus/runtime-platform.ps1")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $PSScriptRoot"
}

. $helperPath

$VBase = Join-SharedPath @((Resolve-SharedObsidianVaultRoot -ThrowIfMissing), "00-System", "ai-memory")
$StructuredDir = Join-SharedPath @($VBase, "structured")
$InboxFile = Join-SharedPath @($VBase, "inbox", "claude-code.md")
$StructuredFile = Join-SharedPath @($StructuredDir, "claude-code.jsonl")
$ClaudeMemApi = "http://127.0.0.1:37778/api"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Normalize-Space {
    param([AllowEmptyString()][string]$Text)

    if ($null -eq $Text) {
        return ""
    }

    return (($Text -replace "\s+", " ").Trim())
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

function Convert-ToArrayValue {
    param($Value)

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return @($Value)
    }

    if ($Value -is [string]) {
        $trimmed = $Value.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            return @()
        }

        try {
            $parsed = $trimmed | ConvertFrom-Json
            if ($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])) {
                return @($parsed)
            }
            return @($parsed)
        } catch {
            return @($trimmed)
        }
    }

    return @($Value)
}

function Resolve-ClaudeMemScope {
    param(
        [AllowEmptyString()][string]$Project,
        [AllowEmptyString()][string]$Type
    )

    $normalizedType = ([string]$Type).ToLowerInvariant()
    if ($normalizedType -match "preference|decision|workflow|rule") {
        return "feedback"
    }

    if (-not [string]::IsNullOrWhiteSpace($Project) -and $Project -ne "wang") {
        return "project"
    }

    return "summary"
}

function Get-OptionalProperty {
    param(
        [Parameter(Mandatory = $true)]$Item,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Item.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Convert-ToClaudeStructuredRecord {
    param([Parameter(Mandatory = $true)]$Item)

    $id = [string]$Item.id
    if ([string]::IsNullOrWhiteSpace($id)) {
        return $null
    }

    $facts = @(Convert-ToArrayValue -Value (Get-OptionalProperty -Item $Item -Name "facts"))
    $concepts = @(Convert-ToArrayValue -Value (Get-OptionalProperty -Item $Item -Name "concepts"))
    $filesRead = @(Convert-ToArrayValue -Value (Get-OptionalProperty -Item $Item -Name "files_read"))
    $filesModified = @(Convert-ToArrayValue -Value (Get-OptionalProperty -Item $Item -Name "files_modified"))
    $title = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "title"))
    $narrative = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "narrative"))
    $content = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "content"))
    if ([string]::IsNullOrWhiteSpace($content)) {
        $content = if (-not [string]::IsNullOrWhiteSpace($narrative)) { $narrative } else { $title }
    }
    if ([string]::IsNullOrWhiteSpace($title)) {
        $title = if (-not [string]::IsNullOrWhiteSpace($content)) { $content } else { $id }
    }

    $project = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "project"))
    $typeInput = [string](Get-OptionalProperty -Item $Item -Name "type")
    $scope = Resolve-ClaudeMemScope -Project $project -Type $typeInput
    $timestamp = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "created_at"))
    if ([string]::IsNullOrWhiteSpace($timestamp)) {
        $timestamp = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "t"))
    }
    $sessionValue = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "memory_session_id"))
    if ([string]::IsNullOrWhiteSpace($sessionValue)) {
        $sessionValue = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "session"))
    }
    $typeValue = Normalize-Space ($typeInput)
    if ([string]::IsNullOrWhiteSpace($typeValue)) {
        $typeValue = "memory"
    }

    return [ordered]@{
        schemaVersion = 2
        id = $id
        t = $timestamp
        tool = "claude-code"
        session = $sessionValue
        type = $typeValue
        project = $project
        title = $title
        content = $content
        facts = $facts
        concepts = $concepts
        files_read = $filesRead
        files_modified = $filesModified
        source = "claude-mem"
        scope = $scope
        visibility = "shared"
        source_kind = "session"
        memory_level = "session"
        workspace = if (-not [string]::IsNullOrWhiteSpace($project)) { $project } else { "claude-mem" }
        task_state = ""
        freshness = "hot"
        confidence = 0.72
        content_hash = Get-ContentHash -Text $content
        metadata = [ordered]@{
            subtitle = Normalize-Space ([string](Get-OptionalProperty -Item $Item -Name "subtitle"))
            narrative = $narrative
        }
    }
}

if (-not (Test-Path -LiteralPath $StructuredDir)) {
    New-Item -ItemType Directory -Path $StructuredDir -Force | Out-Null
}

try {
    $health = Invoke-RestMethod "$ClaudeMemApi/health" -TimeoutSec 5
    if ($health.status -ne "ok") {
        Write-Host "[WARN] claude-mem health: $($health.status)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[ERROR] claude-mem not reachable: $_" -ForegroundColor Red
    exit 1
}

$existingIds = @{}
$recordMap = [ordered]@{}
if (Test-Path -LiteralPath $StructuredFile) {
    foreach ($line in Get-Content -Path $StructuredFile -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $item = $line | ConvertFrom-Json
            $normalized = Convert-ToClaudeStructuredRecord -Item $item
            if ($null -ne $normalized -and $normalized.id) {
                $existingIds[$normalized.id.ToString()] = $true
                $recordMap[$normalized.id.ToString()] = $normalized
            }
        } catch {
        }
    }
}

$existingCount = $existingIds.Count
Write-Host "Existing structured entries: $existingCount" -ForegroundColor Cyan

# Fetch observations in pages of 100.
$allNew = @()
$offset = 0
$limit = 100
$totalFetched = 0

Write-Host "Fetching observations from claude-mem..." -ForegroundColor Cyan

while ($true) {
    $uri = "$ClaudeMemApi/observations?offset=$offset&limit=$limit"
    try {
        $resp = Invoke-RestMethod $uri -TimeoutSec 15
    } catch {
        Write-Host "[WARN] Failed to fetch offset $offset : $_" -ForegroundColor Yellow
        break
    }

    $items = @($resp.items)
    if ($items.Count -eq 0) {
        break
    }

    $newCount = 0
    foreach ($item in $items) {
        $id = $item.id.ToString()
        if ($existingIds.ContainsKey($id)) {
            continue
        }

        $structured = Convert-ToClaudeStructuredRecord -Item $item
        if ($null -eq $structured) {
            continue
        }

        $allNew += $structured
        $recordMap[$structured.id] = $structured
        $existingIds[$id] = $true
        $newCount++
        $totalFetched++
    }

    Write-Host "  Offset $offset : fetched $($items.Count), new $newCount" -ForegroundColor Gray
    if ($items.Count -lt $limit) {
        break
    }

    $offset += $limit

    # Cap per run to avoid long-running syncs.
    if ($totalFetched -ge $MaxRecordsPerRun) {
        Write-Host "  [INFO] Import capped at $MaxRecordsPerRun new entries for this run" -ForegroundColor Yellow
        break
    }
}

Write-Host ""
if ($allNew.Count -eq 0) {
    Write-Host "No new observations to add." -ForegroundColor Green
} else {
    Write-Host "Added $($allNew.Count) new entries to structured/claude-code.jsonl" -ForegroundColor Green

    $inboxLines = @()
    $topNew = @($allNew | Select-Object -Last 20)
    foreach ($entry in $topNew) {
        $time = if ($entry.t) { $entry.t -replace "T", " " -replace "Z", "" } else { "unknown" }
        $project = if ($entry.project -and $entry.project -ne "wang") { "[$($entry.project)] " } else { "" }
        $type = if ($entry.type) { "[$($entry.type)] " } else { "" }
        $content = if ($entry.title) { [string]$entry.title } else { "(untitled)" }
        $files = ""
        if ($entry.files_modified -and $entry.files_modified.Count -gt 0) {
            $files = " | " + (($entry.files_modified | Select-Object -First 3) -join ", ")
        }
        $inboxLines += "- $time $project$type$content$files"
    }

    if ($inboxLines.Count -gt 0) {
        $existing = ""
        if (Test-Path -LiteralPath $InboxFile) {
            $existing = Get-Content -Path $InboxFile -Raw -Encoding UTF8
            if (-not $existing.EndsWith("`n")) {
                $existing += "`n"
            }
        }
        $newContent = $existing + ($inboxLines -join "`n") + "`n"
        Set-Content -Path $InboxFile -Value $newContent -Encoding UTF8 -NoNewline
        Write-Host "Updated inbox/claude-code.md with $($inboxLines.Count) recent entries" -ForegroundColor Green
    }
}

$allStructured = @($recordMap.Values | Sort-Object { [string]$_.t }, { [string]$_.id })
$jsonLines = @($allStructured | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })
$allLines = if ($jsonLines.Count -gt 0) { $jsonLines -join "`n" } else { "" }

$tempFile = $StructuredFile + ".tmp.$([System.Diagnostics.Process]::GetCurrentProcess().Id)"
try {
    [System.IO.File]::WriteAllText($tempFile, $allLines, $Utf8NoBom)
    Move-Item -LiteralPath $tempFile -Destination $StructuredFile -Force
} catch {
    if (Test-Path -LiteralPath $tempFile) {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
    }
    throw
}

Write-Host ""
Write-Host "=== claude-mem -> Obsidian sync complete ===" -ForegroundColor Cyan
Write-Host "Total structured entries: $($existingIds.Count)" -ForegroundColor Cyan
Write-Host "Structured file: $StructuredFile" -ForegroundColor Gray
