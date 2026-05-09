# cleanup-inbox.ps1
# 娓呯悊 inbox 鏂囦欢涓殑鍘嬪姏娴嬭瘯鍣煶锛屼繚鐣欑湡瀹炶蹇嗘潯鐩?
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

$VBase = Join-SharedPath @((Resolve-SharedStoreRoot -ThrowIfMissing), "00-System", "ai-memory")
$InboxDir = Join-SharedPath @($VBase, "inbox")

$NoisePatterns = @(
    'stress-round-',
    '鍘嬪姏娴嬭瘯',
    'ai-memory-pressure-test',
    'cross-tool-test.*marker-',
    'marker-openclaw',
    'marker-claude-code',
    'marker-codex',
    'marker-opencode',
    'marker-trae',
    'marker-cursor',
    'marker-copilot'
)

function Remove-NoiseEntries {
    param([string]$FilePath)

    $raw = Get-Content -Path $FilePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }

    $lines = $raw -split "`n"
    $headerLines = @()
    $bodyLines = @()
    $inHeader = $true
    $removed = 0

    foreach ($rawLine in $lines) {
        $line = $rawLine
        $trimmed = $line.Trim()

        if ($inHeader) {
            $headerLines += $line
            if ($trimmed -match '^# ' -or ($trimmed -match '^---' -and $headerLines.Count -gt 1)) {
                $inHeader = $false
            }
            continue
        }

        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            $bodyLines += $line
            continue
        }

        $isNoise = $false
        foreach ($pat in $NoisePatterns) {
            if ($trimmed -match $pat) {
                $isNoise = $true
                break
            }
        }

        if ($isNoise) {
            $removed++
        } else {
            $bodyLines += $line
        }
    }

    $output = ($headerLines + $bodyLines) -join "`n"
    Set-Content -Path $FilePath -Value $output -Encoding UTF8 -NoNewline
    return $removed
}

Write-Host "=== 娓呯悊 inbox 鍣煶 ===" -ForegroundColor Cyan
$totalRemoved = 0

$inboxFiles = Get-ChildItem -Path $InboxDir -Filter "*.md" -File
foreach ($f in $inboxFiles) {
    $removed = Remove-NoiseEntries -FilePath $f.FullName
    $totalRemoved += $removed
    $msg = if ($removed -gt 0) { "Removed $removed" } else { "clean" }
    $color = if ($removed -gt 0) { "Yellow" } else { "Green" }
    Write-Host "  $($f.Name): $msg" -ForegroundColor $color
}

Write-Host ""
Write-Host "Total removed: $totalRemoved" -ForegroundColor Cyan

$StructuredDir = Join-SharedPath @($VBase, "structured")
if (-not (Test-Path $StructuredDir)) {
    New-Item -ItemType Directory -Path $StructuredDir -Force | Out-Null
    Write-Host "Created structured/ directory" -ForegroundColor Green
}

$SchemaFile = Join-SharedPath @($VBase, "MEMORY-SCHEMA.md")
$SchemaContent = @"
# Memory Schema

## structured/*.jsonl -- Structure Memory Format

Each memory entry stored as one JSON line (JSON Lines):

```json
{
  "t": "2026-03-31T12:00:00Z",
  "tool": "claude-code",
  "session": "uuid",
  "type": "fact|decision|working|learning|bugfix|feature",
  "project": "project-name",
  "title": "Brief title",
  "content": "Full description",
  "facts": ["fact1"],
  "concepts": ["concept1"],
  "files_read": ["path/file"],
  "files_modified": ["path/file"],
  "source": "claude-mem|tool-writeback|human"
}
```

## inbox/*.md -- Human-Readable Bridge

Append-only, written by both machine and human:

```
- [YYYY-MM-DD HH:MM:SS] [source] content
```

## Rules

- structured/ is primary storage, machine-readable
- inbox/ is bridge layer, human-readable
- Append after each session ends
- Deduplicate by content SHA256
"@

if (-not (Test-Path $SchemaFile)) {
    Set-Content -Path $SchemaFile -Value $SchemaContent -Encoding UTF8
    Write-Host "Created MEMORY-SCHEMA.md" -ForegroundColor Green
} else {
    Write-Host "MEMORY-SCHEMA.md exists, skipping" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Phase 1 done ===" -ForegroundColor Green
