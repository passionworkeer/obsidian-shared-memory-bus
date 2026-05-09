# Part of memory-bus.ps1 - extracted for size compliance
# Text clipping, markdown section extraction, and marked-section upsert helpers

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Clip-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$MaxLines = 40
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    if ($lines.Count -le $MaxLines) {
        return ($lines -join "`n")
    }

    return ((@($lines[0..($MaxLines - 1)]) + "...") -join "`n")
}

function Tail-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$MaxLines = 40
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    if ($lines.Count -le $MaxLines) {
        return ($lines -join "`n")
    }

    $start = [Math]::Max(0, $lines.Count - $MaxLines)
    return (("..." + "`n") + (@($lines[$start..($lines.Count - 1)]) -join "`n"))
}

function HeadTail-Lines {
    param(
        [AllowEmptyString()][string]$Text,
        [int]$HeadLines = 80,
        [int]$TailLinesCount = 80
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return "(empty)"
    }

    $lines = @($normalized -split "`n")
    $maxTotal = $HeadLines + $TailLinesCount
    if ($lines.Count -le $maxTotal) {
        return ($lines -join "`n")
    }

    $head = @($lines[0..($HeadLines - 1)])
    $tailStart = [Math]::Max(0, $lines.Count - $TailLinesCount)
    $tail = @($lines[$tailStart..($lines.Count - 1)])

    return ((($head -join "`n") + "`n...`n" + ($tail -join "`n")).Trim())
}

function Get-RecentFilesSummary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Filter = "*",
        [int]$MaxFiles = 5,
        [switch]$Recurse
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return "Path not found: $Path"
    }

    $items = @(
        Get-ChildItem -LiteralPath $Path -File -Filter $Filter -Recurse:$Recurse |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First $MaxFiles
    )

    if ($items.Count -eq 0) {
        return "No matching files found."
    }

    return ($items | ForEach-Object {
        "- {0} ({1}, {2} bytes)" -f $_.FullName, $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"), $_.Length
    }) -join "`n"
}

function Upsert-MarkedSection {
    param(
        [AllowEmptyString()][string]$ExistingText,
        [Parameter(Mandatory = $true)][string]$StartMarker,
        [Parameter(Mandatory = $true)][string]$EndMarker,
        [Parameter(Mandatory = $true)][string]$SectionBody,
        [ValidateSet("prepend", "append")][string]$Position = "append"
    )

    $normalizedExisting = Normalize-Text -Text $ExistingText
    $block = @"
$StartMarker
$SectionBody
$EndMarker
"@.Trim()

    if ($normalizedExisting.Contains($StartMarker) -and $normalizedExisting.Contains($EndMarker)) {
        $startIndex = $normalizedExisting.IndexOf($StartMarker, [System.StringComparison]::Ordinal)
        $endIndex = $normalizedExisting.IndexOf($EndMarker, $startIndex, [System.StringComparison]::Ordinal)
        if ($startIndex -ge 0 -and $endIndex -ge 0) {
            $endIndex += $EndMarker.Length
            $prefix = $normalizedExisting.Substring(0, $startIndex).TrimEnd()
            $suffix = if (($afterParts = @($normalizedExisting -split [regex]::Escape($EndMarker), 2)).Count -gt 1) { $afterParts[1] } else { "" }
            $parts = @()
            if (-not [string]::IsNullOrWhiteSpace($prefix)) { $parts += $prefix }
            $parts += $block
            if (-not [string]::IsNullOrWhiteSpace($suffix)) { $parts += $suffix }
            return ($parts -join "`n`n").Trim() + "`n"
        }
    }

    if ([string]::IsNullOrWhiteSpace($normalizedExisting)) {
        return $block + "`n"
    }

    if ($Position -eq "prepend") {
        return (($block + "`n`n" + $normalizedExisting).Trim() + "`n")
    }

    return (($normalizedExisting + "`n`n" + $block).Trim() + "`n")
}

function Get-MarkdownSectionText {
    param(
        [AllowEmptyString()][string]$Text,
        [string[]]$Headings
    )

    $normalized = Normalize-Text -Text $Text
    if ([string]::IsNullOrWhiteSpace($normalized) -or $null -eq $Headings -or $Headings.Count -eq 0) {
        return ""
    }

    $sections = New-Object System.Collections.Generic.List[string]
    $buffer = New-Object System.Collections.Generic.List[string]
    $capture = $false

    foreach ($line in @($normalized -split "`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^##\s+' -or $trimmed -match '^#\s+') {
            if ($capture -and $buffer.Count -gt 0) {
                $sections.Add((($buffer.ToArray() -join "`n").Trim())) | Out-Null
                $buffer.Clear()
            }

            $capture = ($Headings -contains $trimmed)
            continue
        }

        if ($capture) {
            $buffer.Add($line) | Out-Null
        }
    }

    if ($capture -and $buffer.Count -gt 0) {
        $sections.Add((($buffer.ToArray() -join "`n").Trim())) | Out-Null
    }

    return [string]::Join("`n`n", @($sections))
}