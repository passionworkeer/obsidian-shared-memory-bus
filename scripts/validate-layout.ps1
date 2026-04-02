param(
    [switch]$AsJson
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$layoutPath = Join-Path $PSScriptRoot "install-layout.psd1"
$layout = Import-PowerShellDataFile -Path $layoutPath
$issues = New-Object System.Collections.Generic.List[string]

function Add-Issue {
    param([Parameter(Mandatory = $true)][string]$Message)
    [void]$issues.Add($Message)
}

function Normalize-RelativeInstallPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (($Path -replace '[/\\]+', '/').TrimStart('/'))
}

function Get-LayoutEntries {
    param(
        [Parameter(Mandatory = $true)][string]$Section,
        [string]$SourceDir,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [string]$InstallPrefix
    )

    $entries = @()
    $localNames = @{}

    foreach ($name in @($Names)) {
        if ([string]::IsNullOrWhiteSpace($name)) {
            Add-Issue ("Section '{0}' contains an empty file name." -f $Section)
            continue
        }

        if ($localNames.ContainsKey($name)) {
            Add-Issue ("Section '{0}' contains a duplicate file name: {1}" -f $Section, $name)
            continue
        }
        $localNames[$name] = $true

        $relativeSourcePath = if ([string]::IsNullOrWhiteSpace($SourceDir)) {
            $name
        } else {
            Join-Path $SourceDir $name
        }

        $fullSourcePath = Join-Path $bundleRoot $relativeSourcePath
        if (-not (Test-Path -LiteralPath $fullSourcePath -PathType Leaf)) {
            Add-Issue ("Section '{0}' references a missing file: {1}" -f $Section, $relativeSourcePath)
            continue
        }

        $relativeInstallPath = if ([string]::IsNullOrWhiteSpace($InstallPrefix)) {
            $name
        } else {
            Join-Path $InstallPrefix $name
        }

        $entries += [pscustomobject]@{
            section      = $Section
            sourcePath   = $relativeSourcePath
            installPath  = Normalize-RelativeInstallPath -Path $relativeInstallPath
        }
    }

    return @($entries)
}

$layoutEntries = @()
foreach ($sourceDir in @($layout.FlatRuntimeFiles.Keys | Sort-Object)) {
    $layoutEntries += Get-LayoutEntries -Section ("runtime:{0}" -f $sourceDir) -SourceDir $sourceDir -Names @($layout.FlatRuntimeFiles[$sourceDir])
}
$layoutEntries += Get-LayoutEntries -Section "shared-mcp" -SourceDir "shared-mcp" -InstallPrefix "shared-mcp" -Names @($layout.SharedMcpFiles)
$layoutEntries += Get-LayoutEntries -Section "templates" -SourceDir "templates" -Names @($layout.TemplateFiles)

$managedInstallEntries = @($layoutEntries | Where-Object { $_.section -ne "templates" })
$managedLookup = @{}
foreach ($entry in @($managedInstallEntries)) {
    if ($managedLookup.ContainsKey($entry.installPath)) {
        Add-Issue ("Multiple layout entries resolve to the same installed path: {0}" -f $entry.installPath)
        continue
    }
    $managedLookup[$entry.installPath] = $true
}

$legacyCleanupFiles = if ($layout.ContainsKey("LegacyCleanupFiles")) {
    @($layout.LegacyCleanupFiles)
} else {
    @()
}
$legacyLookup = @{}
foreach ($path in @($legacyCleanupFiles)) {
    $normalized = Normalize-RelativeInstallPath -Path $path
    if ($legacyLookup.ContainsKey($normalized)) {
        Add-Issue ("Legacy cleanup list contains a duplicate path: {0}" -f $normalized)
        continue
    }
    if ($managedLookup.ContainsKey($normalized)) {
        Add-Issue ("Legacy cleanup path overlaps an active managed install path: {0}" -f $normalized)
        continue
    }
    $legacyLookup[$normalized] = $true
}

$requiredInstalledFiles = @(
    "memory-bus.ps1"
    "memory-watchdog.ps1"
    "memory-contract.js"
    "python-runtime.js"
    "register-agent.ps1"
    "runtime-platform.ps1"
    "runtime-config.js"
    "check-memory-integrity.js"
    "run-pressure-test.ps1"
    "verify-client-integrations.ps1"
    "verify-integrations.ps1"
    "benchmark-backends.py"
    "probe-models.py"
    "runtime_support.py"
    "semantic-search.py"
    "shared-mcp/manifest.json"
    "shared-mcp/start-default-shared-mcp.ps1"
    "shared-mcp/start-default-shared-mcp.sh"
    "shared-mcp/start-shared-mcp.ps1"
    "shared-mcp/start-shared-mcp.sh"
    "shared-mcp/status-shared-mcp.ps1"
    "shared-mcp/status-shared-mcp.sh"
    "shared-mcp/stop-shared-mcp.ps1"
    "shared-mcp/stop-shared-mcp.sh"
    "shared-mcp/write-config-snippets.ps1"
)

$missingRequiredFiles = @(
    $requiredInstalledFiles | Where-Object {
        -not $managedLookup.ContainsKey((Normalize-RelativeInstallPath -Path $_))
    }
)
if ($missingRequiredFiles.Count -gt 0) {
    Add-Issue ("Managed install layout is missing required installed files: {0}" -f ($missingRequiredFiles -join ", "))
}

$rootMetadataFiles = @("README.md", "SECURITY.md", ".gitattributes")
foreach ($path in @($rootMetadataFiles)) {
    $fullPath = Join-Path $bundleRoot $path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Add-Issue ("Repository metadata file is missing: {0}" -f $path)
    }
}

$sharedManifestPath = Join-Path $bundleRoot (Join-Path "shared-mcp" "manifest.json")
try {
    [void](Get-Content -Raw -LiteralPath $sharedManifestPath -Encoding utf8 | ConvertFrom-Json)
} catch {
    Add-Issue ("shared-mcp/manifest.json must remain strict JSON: {0}" -f $_.Exception.Message)
}

if ($issues.Count -gt 0) {
    throw ("Install layout validation failed:`n- " + ($issues -join "`n- "))
}

$report = [ordered]@{
    layoutFile               = $layoutPath
    managedInstallFileCount  = @($managedInstallEntries).Count
    runtimeFileCount         = @($layoutEntries | Where-Object { $_.section -like "runtime:*" }).Count
    sharedMcpFileCount       = @($layoutEntries | Where-Object { $_.section -eq "shared-mcp" }).Count
    templateFileCount        = @($layoutEntries | Where-Object { $_.section -eq "templates" }).Count
    legacyCleanupFileCount   = @($legacyCleanupFiles).Count
    requiredInstalledFiles   = $requiredInstalledFiles
    rootMetadataFiles        = $rootMetadataFiles
    sharedManifestJsonValid  = $true
}

if ($AsJson) {
    $report | ConvertTo-Json -Depth 4
    return
}

Write-Output ("Validated install layout contract from {0}" -f $layoutPath)
Write-Output ("Managed install files: {0}" -f $report.managedInstallFileCount)
Write-Output ("Legacy cleanup targets: {0}" -f $report.legacyCleanupFileCount)
Write-Output ("Strict JSON manifest: shared-mcp/manifest.json")
