param(
    [switch]$AsJson
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $PSScriptRoot
$layoutPath = Join-Path $PSScriptRoot "install-layout.psd1"
$layout = Import-PowerShellDataFile -Path $layoutPath
. (Join-Path $bundleRoot "bus/runtime-platform.ps1")
. (Join-Path $PSScriptRoot "install-path-safety.ps1")
$issues = New-Object System.Collections.Generic.List[string]

function Add-Issue {
    param([Parameter(Mandatory = $true)][string]$Message)
    [void]$issues.Add($Message)
}

$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Add-Issue "Node.js is required to validate the generated install file graph."
} else {
    & $node.Source (Join-Path $PSScriptRoot "generate-install-file-graph.mjs") --check
    if ($LASTEXITCODE -ne 0) {
        Add-Issue "scripts/install-files.json is stale or its import closure is invalid."
    }
}

$graphPath = Join-Path $PSScriptRoot ([string]$layout.InstallFileGraph)
if (-not (Test-Path -LiteralPath $graphPath -PathType Leaf)) {
    Add-Issue ("Install file graph is missing: {0}" -f $graphPath)
    $graph = [pscustomobject]@{ formatVersion = 0; entries = @() }
} else {
    try {
        $graph = Get-Content -Raw -LiteralPath $graphPath -Encoding utf8 | ConvertFrom-Json
    } catch {
        Add-Issue ("Install file graph must be strict JSON: {0}" -f $_.Exception.Message)
        $graph = [pscustomobject]@{ formatVersion = 0; entries = @() }
    }
}
if ([int]$graph.formatVersion -ne 1) {
    Add-Issue ("Unsupported install file graph version: {0}" -f $graph.formatVersion)
}

$managedLookup = @{}
$sourceLookup = @{}
foreach ($entry in @($graph.entries)) {
    try {
        $source = (ConvertTo-SafeRelativeInstallPath -Path ([string]$entry.source)) -replace '\\', '/'
        $destination = (ConvertTo-SafeRelativeInstallPath -Path ([string]$entry.destination)) -replace '\\', '/'
    } catch {
        Add-Issue ("Unsafe install file graph entry: {0} -> {1}: {2}" -f $entry.source, $entry.destination, $_.Exception.Message)
        continue
    }
    if ($managedLookup.ContainsKey($destination)) {
        Add-Issue ("Multiple graph entries resolve to the same installed path: {0}" -f $destination)
    } else {
        $managedLookup[$destination] = $source
    }
    if ($sourceLookup.ContainsKey($source + '|' + $destination)) {
        Add-Issue ("Duplicate source/destination graph entry: {0} -> {1}" -f $source, $destination)
    } else {
        $sourceLookup[$source + '|' + $destination] = $true
    }
    $fullSource = Resolve-SafeInstallTarget -TargetRoot $bundleRoot -RelativePath $source -RejectReparsePoints
    if (-not (Test-Path -LiteralPath $fullSource -PathType Leaf)) {
        Add-Issue ("Install graph references a missing source file: {0}" -f $source)
    }
}

$templateFiles = @($layout.TemplateFiles)
foreach ($template in $templateFiles) {
    try {
        $normalized = ConvertTo-SafeRelativeInstallPath -Path ([string]$template)
        $source = Resolve-SafeInstallTarget -TargetRoot (Join-Path $bundleRoot 'templates') -RelativePath $normalized -RejectReparsePoints
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Add-Issue ("Template file is missing: {0}" -f $template)
        }
    } catch {
        Add-Issue ("Unsafe template path '{0}': {1}" -f $template, $_.Exception.Message)
    }
}

$legacyCleanupFiles = @($layout.LegacyCleanupFiles)
$legacyCleanupDirectories = @($layout.LegacyCleanupDirectories)
$legacyLookup = @{}
foreach ($path in @($legacyCleanupFiles + $legacyCleanupDirectories)) {
    try {
        $normalized = (ConvertTo-SafeRelativeInstallPath -Path ([string]$path)) -replace '\\', '/'
    } catch {
        Add-Issue ("Unsafe legacy cleanup path '{0}': {1}" -f $path, $_.Exception.Message)
        continue
    }
    if ($legacyLookup.ContainsKey($normalized)) {
        Add-Issue ("Legacy cleanup list contains a duplicate path: {0}" -f $normalized)
    }
    if ($managedLookup.ContainsKey($normalized)) {
        Add-Issue ("Legacy cleanup path overlaps an active managed install path: {0}" -f $normalized)
    }
    $legacyLookup[$normalized] = $true
}

$requiredInstalledFiles = @(
    'memory-bus.ps1'
    'memory-bus-cache.ps1'
    'memory-bus-artifacts.ps1'
    'memory-bus-sync-time.ps1'
    'memory-watchdog.ps1'
    'runtime-platform.ps1'
    'install-client-integrations.ps1'
    'verify-client-integrations.ps1'
    'run-memory-dream.ps1'
    'bus/generate-embeddings.js'
    'bus/embedding-providers/openai-compatible-provider.js'
    'bus/store-root.js'
    'ops/check/check-memory-integrity.js'
    'ops/mcp/canonical-memory-write.js'
    'ops/util/safe-realpath.js'
    'retrieval/search_server.py'
    'retrieval/embedding_providers.py'
    'cli/ai-memory.js'
    'cli/commands/doctor.js'
    'shared/structured-files.json'
    'shared-mcp/manifest.json'
    'shared-mcp/services.registry.json'
    'shared-mcp/proto/rpc.mjs'
    'shared-mcp/proto/child-process.mjs'
    'shared-mcp/metrics/server.js'
    'shared-mcp/scripts/blackboard_query.py'
    'shared-mcp/omni-memory-server.js'
    'shared-mcp/start-default-shared-mcp.sh'
)
$missingRequired = @($requiredInstalledFiles | Where-Object { -not $managedLookup.ContainsKey($_) })
if ($missingRequired.Count -gt 0) {
    Add-Issue ("Install file graph is missing required runtime files: {0}" -f ($missingRequired -join ', '))
}

if ($issues.Count -gt 0) {
    throw ("Install layout validation failed:`n- " + ($issues -join "`n- "))
}

$report = [ordered]@{
    layoutFile = $layoutPath
    installFileGraph = $graphPath
    managedInstallFileCount = @($graph.entries).Count
    rootCompatibilityFileCount = @($graph.entries | Where-Object { $_.kind -eq 'root-compat' }).Count
    templateFileCount = $templateFiles.Count
    legacyCleanupFileCount = $legacyCleanupFiles.Count
    legacyCleanupDirectoryCount = $legacyCleanupDirectories.Count
    requiredInstalledFiles = $requiredInstalledFiles
    importClosureValid = $true
}
if ($AsJson) {
    $report | ConvertTo-Json -Depth 4
    return
}
Write-Output ("Validated generated install file graph from {0}" -f $graphPath)
Write-Output ("Managed install files: {0}" -f $report.managedInstallFileCount)
Write-Output ("Root compatibility files: {0}" -f $report.rootCompatibilityFileCount)
Write-Output "Installed relative-import closure: valid"
