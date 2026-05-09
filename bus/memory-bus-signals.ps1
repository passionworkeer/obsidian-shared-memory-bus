# Part of memory-bus.ps1 - extracted for size compliance
# Signal detection, filtering, dedup, and item extraction from inbox/imported sources

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Convert-ToSignalItemText {
    param([AllowEmptyString()][string]$Line)

    $normalized = Normalize-Text -Text $Line
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ""
    }

    $item = ($normalized -replace '\s+', ' ').Trim()
    $item = $item -replace '^[\-\*\+]\s+', ''
    $item = $item -replace '^\d+\.\s+', ''
    if ($item -match '^(.*?)(?=- \[[0-9]{4}-[0-9]{2}-[0-9]{2})') {
        $item = $matches[1].Trim()
    }
    return $item.Trim()
}

function Test-MemoryNoiseLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if ([string]::IsNullOrWhiteSpace($item)) {
        return $true
    }

    $noisePatterns = @(
        '^(?:#|##|###)\s+',
        '^\|',
        '^\.\.\.$',
        '(?i)^Imported at:',
        '(?i)^Append durable facts, reusable decisions, and cross-project preferences here\.$',
        '(?i)SHARED-PROBE',
        '(?i)\bprobe-\d+',
        '(?i)\[cross-tool-test\]',
        '(?i)\bmarker-[a-z0-9_-]+',
        '(?i)stress-round',
        '(?i)ai-memory-pressure-test',
        '(?i)^No .* detected\.?$',
        '(?i)^No .* found\.?$',
        '(?i)^Project .* not found\.?$',
        '(?i)^OpenCode stats unavailable',
        '(?i)^opencode\.json not found',
        '(?i)^CLI path:',
        '(?i)^Database path:',
        '(?i)^Storage path:',
        '(?i)^Chat sessions path:',
        '(?i)^Session state root:',
        '(?i)^Matching CLI sessions:',
        '(?i)^Workspace path:',
        '(?i)^Last activity:',
        '(?i)^Total Cost\b',
        '(?i)^Avg Cost/Day\b',
        '(?i)^Avg Tokens/Session\b',
        '(?i)^Median Tokens/Session\b',
        '(?i)^Input\b',
        '(?i)^Output\b',
        '(?i)^Cache Read\b',
        '(?i)^Cache Write\b',
        '(?i)^Sessions\b',
        '(?i)^Messages\b',
        '(?i)^Days\b',
        '(?i)rollout-\d{4}',
        '(?i)\.jsonl\b'
    )

    foreach ($pattern in $noisePatterns) {
        if ($item -match $pattern) {
            return $true
        }
    }

    return $false
}

function Test-DurableSignalLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if (Test-MemoryNoiseLine -Line $item) {
        return $false
    }

    if ($item -match '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}') {
        return $false
    }

    if ($item -match '^[A-Za-z]:\\' -or $item -match '^".*":\s*\{?$' -or $item -match '^`?.+\.md`?$') {
        return $false
    }

    if ($item -match '(?i)(shared long-term storage|canonical|durable|writeback|read order|shared memory|workflow|strategy|obsidian|vault|claude-mem|mcp ready|initialized|worker port|database size|observations|summaries|react\b|typescript\b|vite\b|supabase|three\.js|swiftui|socket\.io)') {
        return $true
    }

    if ($item -match '(?i)^\*\*(name|timezone|os|python path|git)\*\*:') {
        return $true
    }

    return $false
}

function Test-WorkingSignalLine {
    param([AllowEmptyString()][string]$Line)

    $item = Convert-ToSignalItemText -Line $Line
    if (Test-MemoryNoiseLine -Line $item) {
        return $false
    }

    if ($item -match '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}') {
        return $true
    }

    if ($item -match '(?i)(current|active|working|handoff|recent|today|task|session|thread|topic|continue|verify|analyze|fix|memory)') {
        return $true
    }

    return $false
}

function Get-DedupedSignalItems {
    param(
        [string[]]$Lines,
        [int]$MaxItems = 8,
        [ValidateSet("durable", "working", "inbox")][string]$Mode = "working",
        [switch]$FromNewest
    )

    $items = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    if ($null -eq $Lines -or $Lines.Count -eq 0 -or $MaxItems -le 0) {
        return @()
    }

    $tryAdd = {
        param([AllowEmptyString()][string]$CurrentLine)

        $item = Convert-ToSignalItemText -Line $CurrentLine
        if ([string]::IsNullOrWhiteSpace($item)) {
            return
        }

        switch ($Mode) {
            "durable" {
                if (-not (Test-DurableSignalLine -Line $item)) {
                    return
                }
            }
            "working" {
                if (-not (Test-WorkingSignalLine -Line $item)) {
                    return
                }
            }
            "inbox" {
                if (Test-MemoryNoiseLine -Line $item) {
                    return
                }
            }
        }

        $key = $item.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            return
        }

        $seen[$key] = $true
        $items.Add($item) | Out-Null
    }

    if ($FromNewest) {
        for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
            & $tryAdd $Lines[$i]
            if ($items.Count -ge $MaxItems) {
                break
            }
        }
    } else {
        foreach ($line in @($Lines)) {
            & $tryAdd $line
            if ($items.Count -ge $MaxItems) {
                break
            }
        }
    }

    return $items.ToArray()
}

function Get-InboxSignalItems {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxItems = 8
    )

    $text = Read-Text -Path $Path
    $normalized = Normalize-Text -Text $text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return @()
    }

    return @(Get-DedupedSignalItems -Lines @($normalized -split "`n") -MaxItems $MaxItems -Mode "inbox" -FromNewest)
}

function Get-ImportedSignalItems {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet("durable", "working")][string]$Mode = "working",
        [int]$MaxItems = 8
    )

    $text = Read-Text -Path $Path
    $normalized = Normalize-Text -Text $text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return @()
    }

    $preferredHeadings = if ($Mode -eq "durable") {
        @(
            "## Strategy",
            "## USER.md",
            "## MEMORY.md",
            "## Claude-Mem Health",
            "## Claude-Mem Stats",
            "## Canonical Files",
            "## Writeback Policy"
        )
    } else {
        @(
            "## Recent Threads",
            "## Recent Sessions",
            "## Recent Prompts",
            "## Recent Session Topics"
        )
    }

    $candidateText = Get-MarkdownSectionText -Text $normalized -Headings $preferredHeadings
    if ([string]::IsNullOrWhiteSpace($candidateText) -and $Mode -eq "working") {
        return @()
    }

    if ([string]::IsNullOrWhiteSpace($candidateText)) {
        $candidateText = $normalized
    }

    return @(Get-DedupedSignalItems -Lines @($candidateText -split "`n") -MaxItems $MaxItems -Mode $Mode)
}