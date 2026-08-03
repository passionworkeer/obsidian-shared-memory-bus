Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function ConvertTo-SafeRelativeInstallPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "Install path must not be empty."
    }
    if ($Path.IndexOf([char]0) -ge 0 -or @($Path.ToCharArray() | Where-Object { [char]::IsControl($_) }).Count -gt 0) {
        throw "Install path contains a control character."
    }

    $raw = $Path.Trim()
    if ([System.IO.Path]::IsPathRooted($raw) -or $raw -match '^[A-Za-z]:' -or $raw -match '^(?:\\\\|//)') {
        throw "Install path must be relative: $Path"
    }
    if ($raw.Contains(':')) {
        throw "Install path must not contain a colon or alternate data-stream syntax: $Path"
    }

    $segments = @($raw -split '[/\\]+')
    if ($segments.Count -eq 0) {
        throw "Install path must contain at least one segment."
    }

    $devicePattern = '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$'
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -in @('.', '..')) {
            throw "Install path contains an unsafe segment: $Path"
        }
        if ($segment -match '[*?\[\]]') {
            throw "Install path must not contain wildcard characters: $Path"
        }
        if ($segment.EndsWith(' ') -or $segment.EndsWith('.')) {
            throw "Install path segments must not end in spaces or dots: $Path"
        }
        if ($segment -match $devicePattern) {
            throw "Install path contains a reserved device name: $Path"
        }
    }

    return [string]::Join([System.IO.Path]::DirectorySeparatorChar, $segments)
}

function Test-InstallPathContained {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$CandidatePath
    )

    $comparison = if (Test-SharedIsWindows) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd([char[]]@('/', '\\'))
    $candidateFull = [System.IO.Path]::GetFullPath($CandidatePath)
    return $candidateFull.StartsWith($rootFull + $separator, $comparison)
}

function Assert-NoInstallReparsePoint {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $normalized = ConvertTo-SafeRelativeInstallPath -Path $RelativePath
    $current = [System.IO.Path]::GetFullPath($RootPath)
    foreach ($segment in @($normalized -split '[/\\]+')) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) {
            continue
        }
        $item = Get-Item -LiteralPath $current -Force
        $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
        $hasLinkType = ($item.PSObject.Properties.Name -contains 'LinkType') -and -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)
        if ($isReparse -or $hasLinkType) {
            throw "Refusing to traverse a symbolic link, junction, or reparse point during installation cleanup: $current"
        }
    }
}

function Resolve-SafeInstallTarget {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [switch]$RejectReparsePoints
    )

    $normalized = ConvertTo-SafeRelativeInstallPath -Path $RelativePath
    $rootFull = [System.IO.Path]::GetFullPath($TargetRoot)
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $normalized))
    if (-not (Test-InstallPathContained -RootPath $rootFull -CandidatePath $candidate)) {
        throw "Install path escapes the target root: $RelativePath"
    }
    if ($RejectReparsePoints) {
        Assert-NoInstallReparsePoint -RootPath $rootFull -RelativePath $normalized
    }
    return $candidate
}

function Remove-SafeManagedFileIfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [switch]$DryRun
    )

    $targetPath = Resolve-SafeInstallTarget -TargetRoot $TargetRoot -RelativePath $RelativePath -RejectReparsePoints
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        return
    }
    if ($DryRun) {
        Write-Output "[dry-run] would remove managed file: $targetPath"
        return
    }
    [void](Resolve-SafeInstallTarget -TargetRoot $TargetRoot -RelativePath $RelativePath -RejectReparsePoints)
    Remove-Item -LiteralPath $targetPath -Force
}

function Remove-SafeManagedDirectoryIfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$TargetRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [switch]$DryRun
    )

    $targetPath = Resolve-SafeInstallTarget -TargetRoot $TargetRoot -RelativePath $RelativePath -RejectReparsePoints
    if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
        return
    }
    if ($DryRun) {
        Write-Output "[dry-run] would remove managed directory: $targetPath"
        return
    }
    [void](Resolve-SafeInstallTarget -TargetRoot $TargetRoot -RelativePath $RelativePath -RejectReparsePoints)
    Remove-Item -LiteralPath $targetPath -Force -Recurse
}

function ConvertTo-PosixSingleQuotedLiteral {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    $singleQuote = [string][char]39
    $doubleQuote = [string][char]34
    $embeddedQuote = $singleQuote + $doubleQuote + $singleQuote + $doubleQuote + $singleQuote
    return $singleQuote + $Value.Replace($singleQuote, $embeddedQuote) + $singleQuote
}

function ConvertTo-PowerShellSingleQuotedLiteral {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '' }
    return "'" + $Value.Replace("'", "''") + "'"
}

function New-PosixActivationContent {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedTargetRoot,
        [Parameter(Mandatory = $true)][string]$ResolvedPython,
        [string]$ResolvedSharedMcpPython = ''
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('#!/usr/bin/env sh') | Out-Null
    $lines.Add(('export AI_MEMORY_ROOT={0}' -f (ConvertTo-PosixSingleQuotedLiteral $ResolvedTargetRoot))) | Out-Null
    $lines.Add(('export AI_MEMORY_PYTHON={0}' -f (ConvertTo-PosixSingleQuotedLiteral $ResolvedPython))) | Out-Null
    if (-not [string]::IsNullOrWhiteSpace($ResolvedSharedMcpPython)) {
        $lines.Add(('export AI_MEMORY_MCP_PYTHON={0}' -f (ConvertTo-PosixSingleQuotedLiteral $ResolvedSharedMcpPython))) | Out-Null
    }
    return [string]::Join("`n", @($lines)) + "`n"
}

function New-PowerShellActivationContent {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedTargetRoot,
        [Parameter(Mandatory = $true)][string]$ResolvedPython,
        [string]$ResolvedSharedMcpPython = ''
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add(('$env:AI_MEMORY_ROOT = {0}' -f (ConvertTo-PowerShellSingleQuotedLiteral $ResolvedTargetRoot))) | Out-Null
    $lines.Add(('$env:AI_MEMORY_PYTHON = {0}' -f (ConvertTo-PowerShellSingleQuotedLiteral $ResolvedPython))) | Out-Null
    if (-not [string]::IsNullOrWhiteSpace($ResolvedSharedMcpPython)) {
        $lines.Add(('$env:AI_MEMORY_MCP_PYTHON = {0}' -f (ConvertTo-PowerShellSingleQuotedLiteral $ResolvedSharedMcpPython))) | Out-Null
    }
    return [string]::Join("`n", @($lines)) + "`n"
}

function Write-AtomicRestrictedTextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Content,
        [ValidateSet('600', '700')][string]$PosixMode = '600',
        [Parameter(Mandatory = $true)][System.Text.Encoding]$Encoding
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    $temporaryPath = Join-Path $directory ('.tmp-{0}-{1}' -f [System.IO.Path]::GetFileName($Path), [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Content, $Encoding)
        if (-not (Test-SharedIsWindows)) {
            & chmod $PosixMode -- $temporaryPath
            if ($LASTEXITCODE -ne 0) { throw "chmod $PosixMode failed for $temporaryPath" }
        }
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
        if (-not (Test-SharedIsWindows)) {
            & chmod $PosixMode -- $Path
            if ($LASTEXITCODE -ne 0) { throw "chmod $PosixMode failed for $Path" }
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}
