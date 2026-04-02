param(
    [switch]$Force,
    [int]$MinHours = 24,
    [int]$MinRecords = 10
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

function Resolve-ObsidianVaultRoot {
    foreach ($overridePath in @($env:AI_MEMORY_OBSIDIAN_VAULT, $env:OBSIDIAN_VAULT_ROOT)) {
        if (-not [string]::IsNullOrWhiteSpace($overridePath) -and (Test-Path -LiteralPath $overridePath -PathType Container)) {
            return (Get-Item -LiteralPath $overridePath).FullName
        }
    }

    $obsidianConfigPath = Join-Path $env:APPDATA "obsidian\obsidian.json"
    if (Test-Path -LiteralPath $obsidianConfigPath) {
        try {
            $config = Get-Content -Raw -LiteralPath $obsidianConfigPath -Encoding utf8 | ConvertFrom-Json
            $records = New-Object System.Collections.Generic.List[object]
            if ($config.vaults) {
                foreach ($property in $config.vaults.PSObject.Properties) {
                    $vault = $property.Value
                    $path = [string]$vault.path
                    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) {
                        continue
                    }

                    $records.Add([pscustomobject]@{
                        path = (Get-Item -LiteralPath $path).FullName
                        open = [bool]$vault.open
                        ts = if ($null -ne $vault.ts) { [int64]$vault.ts } else { 0 }
                    }) | Out-Null
                }
            }

            $openVault = @($records | Where-Object { $_.open } | Sort-Object ts -Descending | Select-Object -First 1)
            if ($openVault.Count -gt 0) {
                return $openVault[0].path
            }

            $recentVault = @($records | Sort-Object ts -Descending | Select-Object -First 1)
            if ($recentVault.Count -gt 0) {
                return $recentVault[0].path
            }
        } catch {
        }
    }

    foreach ($candidate in @(
        (Join-Path ([Environment]::GetFolderPath("Desktop")) "Obsidian Vault"),
        (Join-Path $env:USERPROFILE "Documents\Obsidian Vault")
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    throw "No Obsidian vault directory found. Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT, or open the vault in Obsidian first."
}

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
    return "{0}:{1}:{2}" -f $item.Name, $item.LastWriteTimeUtc.Ticks, $item.Length
}

function New-BulletLine {
    param([Parameter(Mandatory = $true)][object]$Record)

    $tool = if ([string]::IsNullOrWhiteSpace([string]$Record.tool)) { "unknown" } else { [string]$Record.tool }
    $scope = if ([string]::IsNullOrWhiteSpace([string]$Record.scope)) { "" } else { " [$([string]$Record.scope)]" }
    $title = if ([string]::IsNullOrWhiteSpace([string]$Record.title)) { [string]$Record.content } else { [string]$Record.title }
    $taskState = if ([string]::IsNullOrWhiteSpace([string]$Record.task_state)) { "" } else { " {$([string]$Record.task_state)}" }
    return "- [$tool]$scope$taskState $($title.Trim())"
}

function Select-RecentUniqueRecords {
    param(
        [Parameter(Mandatory = $true)][object[]]$Records,
        [int]$MaxItems = 8
    )

    $seen = @{}
    $selected = New-Object System.Collections.Generic.List[object]
    foreach ($record in @($Records | Sort-Object { [string]$_.t } -Descending)) {
        $key = if (-not [string]::IsNullOrWhiteSpace([string]$record.title)) {
            ([string]$record.title).ToLowerInvariant()
        } else {
            ([string]$record.content).ToLowerInvariant()
        }

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

$VaultRoot = Resolve-ObsidianVaultRoot
$AiMemoryRoot = Join-Path $VaultRoot "00-System\ai-memory"
$StructuredRoot = Join-Path $AiMemoryRoot "structured"
$GeneratedRoot = Join-Path $AiMemoryRoot "generated"
$StateRoot = Join-Path $AiMemoryRoot "state"
$DreamMarkdownPath = Join-Path $GeneratedRoot "AUTO-DREAM.md"
$DreamJsonPath = Join-Path $GeneratedRoot "AUTO-DREAM.json"
$DreamStatePath = Join-Path $StateRoot "auto-dream-state.json"
$DreamLockPath = Join-Path $StateRoot "auto-dream.lock"

$SourceFiles = @(
    (Join-Path $StructuredRoot "shared-inbox.jsonl"),
    (Join-Path $StructuredRoot "session-memory.jsonl"),
    (Join-Path $StructuredRoot "shared-events.jsonl"),
    (Join-Path $StructuredRoot "openclaw-runs.jsonl"),
    (Join-Path $StructuredRoot "openclaw-jobs.jsonl"),
    (Join-Path $StructuredRoot "openclaw-blackboard.jsonl")
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
    $runRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "openclaw-runs.jsonl"))
    $taskRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "openclaw-blackboard.jsonl"))
    $jobRecords = @(Get-JsonLines -Path (Join-Path $StructuredRoot "openclaw-jobs.jsonl"))

    $totalRecords = $durableRecords.Count + $sessionRecords.Count + $eventRecords.Count + $runRecords.Count + $taskRecords.Count + $jobRecords.Count
    if (-not $Force -and $totalRecords -lt $MinRecords) {
        Write-Output (@{ ok = $true; skipped = $true; reason = "dream-insufficient-records"; totalRecords = $totalRecords } | ConvertTo-Json -Compress)
        exit 0
    }

    $durableHighlights = @(Select-RecentUniqueRecords -Records $durableRecords -MaxItems 8)
    $sessionHighlights = @(Select-RecentUniqueRecords -Records ($sessionRecords + $eventRecords) -MaxItems 8)
    $taskHighlights = @(Select-RecentUniqueRecords -Records ($taskRecords + $runRecords + $jobRecords) -MaxItems 10)

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
    $markdownLines.Add("## Observations") | Out-Null
    $markdownLines.Add("") | Out-Null
    $markdownLines.Add("- Durable signals should usually come from `shared-inbox.jsonl` and be promoted carefully into human-edited notes.") | Out-Null
    $markdownLines.Add("- Session handoff combines session memory and recent bus events, so long-running work can restart with less context decay.") | Out-Null
    $markdownLines.Add("- OpenClaw task and run records are treated as first-class recall targets, not just prompt snippets.") | Out-Null

    $markdown = ($markdownLines.ToArray() -join "`n").Trim() + "`n"
    Write-Text -Path $DreamMarkdownPath -Content $markdown

    $jsonPayload = [ordered]@{
        generatedAt = $generatedAt
        sourceDigest = $sourceDigest
        counts = [ordered]@{
            durable = $durableRecords.Count
            session = $sessionRecords.Count
            events = $eventRecords.Count
            runs = $runRecords.Count
            tasks = $taskRecords.Count
            jobs = $jobRecords.Count
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
