# bus/memory-bus-sync-time.ps1
# Time, path and string utility helpers. Dot-sourced by memory-bus-sync.ps1.

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
