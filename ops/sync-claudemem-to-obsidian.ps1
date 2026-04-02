# sync-claudemem-to-obsidian.ps1
# Sync claude-mem observations into Obsidian structured memory.
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
if (Test-Path -LiteralPath $StructuredFile) {
    foreach ($line in Get-Content -Path $StructuredFile -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $item = $line | ConvertFrom-Json
            if ($item.id) {
                $existingIds[$item.id.ToString()] = $true
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

        $facts = @()
        if ($item.facts) {
            try {
                $facts = @($item.facts | ConvertFrom-Json)
            } catch {
            }
        }

        $concepts = @()
        if ($item.concepts) {
            try {
                $concepts = @($item.concepts | ConvertFrom-Json)
            } catch {
            }
        }

        $filesRead = @()
        if ($item.files_read) {
            try {
                $filesRead = @($item.files_read | ConvertFrom-Json)
            } catch {
            }
        }

        $filesMod = @()
        if ($item.files_modified) {
            try {
                $filesMod = @($item.files_modified | ConvertFrom-Json)
            } catch {
            }
        }

        $content = ""
        if ($item.narrative) {
            $content = [string]$item.narrative
        } elseif ($item.title) {
            $content = [string]$item.title
        }

        $structured = [ordered]@{
            id = $id
            t = $item.created_at
            tool = "claude-code"
            session = $item.memory_session_id
            type = $item.type
            project = $item.project
            title = $item.title
            subtitle = $item.subtitle
            narrative = $item.narrative
            content = $content
            facts = $facts
            concepts = $concepts
            files_read = $filesRead
            files_modified = $filesMod
            source = "claude-mem"
        }

        $jsonLine = $structured | ConvertTo-Json -Compress -Depth 5
        $allNew += $jsonLine
        $existingIds[$id] = $true
        $newCount++
        $totalFetched++
    }

    Write-Host "  Offset $offset : fetched $($items.Count), new $newCount" -ForegroundColor Gray
    if ($items.Count -lt $limit) {
        break
    }

    $offset += $limit

    # Cap the initial catch-up to avoid long-running syncs.
    if ($totalFetched -ge 500) {
        Write-Host "  [INFO] Import capped at 500 new entries for this run" -ForegroundColor Yellow
        break
    }
}

Write-Host ""
if ($allNew.Count -eq 0) {
    Write-Host "No new observations to add." -ForegroundColor Green
} else {
    Add-Content -Path $StructuredFile -Value ($allNew -join "`n") -Encoding UTF8
    Write-Host "Added $($allNew.Count) new entries to structured/claude-code.jsonl" -ForegroundColor Green

    $inboxLines = @()
    $topNew = $allNew | Select-Object -Last 20
    foreach ($jsonLine in $topNew) {
        try {
            $entry = $jsonLine | ConvertFrom-Json
            $time = if ($entry.t) { $entry.t -replace "T", " " -replace "Z", "" } else { "unknown" }
            $project = if ($entry.project -and $entry.project -ne "wang") { "[$($entry.project)] " } else { "" }
            $type = if ($entry.type) { "[$($entry.type)] " } else { "" }
            $content = if ($entry.title) { [string]$entry.title } else { "(untitled)" }
            if ($entry.subtitle) {
                $content += ": $($entry.subtitle)"
            }
            $files = ""
            if ($entry.files_modified -and $entry.files_modified.Count -gt 0) {
                $files = " | " + (($entry.files_modified | Select-Object -First 3) -join ", ")
            }
            $inboxLines += "- $time $project$type$content$files"
        } catch {
        }
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

Write-Host ""
Write-Host "=== claude-mem -> Obsidian sync complete ===" -ForegroundColor Cyan
Write-Host "Total structured entries: $($existingIds.Count)" -ForegroundColor Cyan
Write-Host "Structured file: $StructuredFile" -ForegroundColor Gray
