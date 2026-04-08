# bus/memory-bus-helpers.ps1
# Utility helpers for memory-bus. Dot-sourced by memory-bus.ps1.
# DO NOT call directly. These functions have no dependencies on other bus functions.

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    try {
        return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
    } catch {
        return Get-Content -Raw -LiteralPath $Path
    }
}

function Normalize-Text {
    param([AllowEmptyString()][string]$Text)
    if ($null -eq $Text) {
        return ""
    }

    return (($Text -replace "`r", "") -replace "[`t ]+$", "").Trim()
}

function Write-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $tmpPath = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmpPath, $Content, $Utf8NoBom)
    Move-Item -LiteralPath $tmpPath -Destination $Path -Force
}

function Write-TextIfChanged {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content
    )

    $existing = Read-Text -Path $Path
    if ($existing -ceq $Content) {
        return $false
    }

    Write-Text -Path $Path -Content $Content
    return $true
}

function Append-Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::AppendAllText($Path, $Content, $Utf8NoBom)
}

function Get-JsonFromUri {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 8
    } catch {
        return $null
    }
}

function Write-Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 12
    Write-Text -Path $Path -Content $json
}

function Invoke-GeneratedArtifactRefresh {
    param([switch]$Force)

    if (-not (Test-Path -LiteralPath $Script:RefreshGeneratedArtifactsScript -PathType Leaf)) {
        return $false
    }

    $args = @($Script:RefreshGeneratedArtifactsScript)
    if ($Force) {
        $args += "--force"
    }

    try {
        $output = & (Resolve-SharedNodeExecutable) @args 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $text = ($output | Out-String).Trim()
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                [Console]::Error.WriteLine(("AI_MEMORY_REFRESH warning: {0}" -f $text))
            }
            return $false
        }

        return $true
    } catch {
        [Console]::Error.WriteLine(("AI_MEMORY_REFRESH exception: {0}" -f $_.Exception.Message))
        return $false
    }
}

function Get-OrAddRuntimeCache {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][scriptblock]$Factory
    )

    if ($Script:RuntimeCache.ContainsKey($Key)) {
        return $Script:RuntimeCache[$Key]
    }

    $value = & $Factory
    $Script:RuntimeCache[$Key] = $value
    return $value
}

function Get-FileStamp {
    param([AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return "__missing__"
    }

    $item = Get-Item -LiteralPath $Path
    return "{0}:{1}:{2}" -f $item.FullName, $item.LastWriteTimeUtc.Ticks, $item.Length
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

function ConvertTo-AgentSlug {
    param([AllowEmptyString()][string]$Name)

    $candidate = [string]$Name
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        return ""
    }

    $slug = $candidate.ToLowerInvariant()
    $slug = [System.Text.RegularExpressions.Regex]::Replace($slug, "[^a-z0-9]+", "-")
    $slug = $slug.Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) {
        throw "Agent name '$Name' could not be converted to a safe slug."
    }

    return $slug
}

function ConvertTo-AgentDisplayName {
    param(
        [AllowEmptyString()][string]$Name,
        [AllowEmptyString()][string]$FallbackSlug = ""
    )

    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        $trimmedName = $Name.Trim()
        if ($trimmedName -cmatch '^[a-z0-9-]+$') {
            $FallbackSlug = $trimmedName
        } else {
            return $trimmedName
        }
    }

    $slug = ConvertTo-AgentSlug -Name $FallbackSlug
    if ([string]::IsNullOrWhiteSpace($slug)) {
        return "External Agent"
    }

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($part in @($slug -split "-")) {
        if ([string]::IsNullOrWhiteSpace($part)) {
            continue
        }

        $parts.Add(($part.Substring(0, 1).ToUpperInvariant() + $part.Substring(1))) | Out-Null
    }

    if ($parts.Count -eq 0) {
        return "External Agent"
    }

    return [string]::Join(" ", $parts)
}

