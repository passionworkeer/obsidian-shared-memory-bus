# Part of memory-bus.ps1 - extracted for size compliance
# Auto-optimized memory/working section generation and canonical note updates

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Build-AutoOptimizedMemorySection {
    $generatedAt = Get-OptimizationSourceTimestampString
    $parts = New-Object System.Collections.Generic.List[string]
    $sourceCount = 0

    $parts.Add("## Auto-Optimized Durable Signals") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("Generated at: $generatedAt") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("This managed block keeps high-signal cross-tool memory additive and non-destructive.") | Out-Null

    foreach ($definition in @(Get-AgentDefinitions)) {
        $items = @(Get-ImportedSignalItems -Path (Get-AgentImportedPath -Slug $definition.slug) -Mode "durable" -MaxItems 6)
        if ($items.Count -eq 0) {
            continue
        }

        $sourceCount += 1
        $parts.Add("") | Out-Null
        $parts.Add(("### {0}" -f $definition.displayName)) | Out-Null
        $parts.Add("") | Out-Null
        foreach ($item in $items) {
            $parts.Add("- $item") | Out-Null
        }
    }

    if ($sourceCount -eq 0) {
        $parts.Add("") | Out-Null
        $parts.Add("- No durable signals detected yet.") | Out-Null
    }

    return (($parts.ToArray() -join "`n").Trim())
}

function Build-AutoOptimizedWorkingSection {
    $generatedAt = Get-OptimizationSourceTimestampString
    $parts = New-Object System.Collections.Generic.List[string]
    $sourceCount = 0

    $parts.Add("## Auto-Optimized Current Context") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("Generated at: $generatedAt") | Out-Null
    $parts.Add("") | Out-Null
    $parts.Add("This managed block keeps the freshest cross-tool context available for session handoff.") | Out-Null

    foreach ($definition in @(Get-AgentDefinitions)) {
        $mergedItems = New-Object System.Collections.Generic.List[string]
        $seen = @{}

        foreach ($item in @(Get-ImportedSignalItems -Path (Get-AgentImportedPath -Slug $definition.slug) -Mode "working" -MaxItems 4)) {
            $key = $item.ToLowerInvariant()
            if ($seen.ContainsKey($key)) {
                continue
            }

            $seen[$key] = $true
            $mergedItems.Add($item) | Out-Null
        }

        foreach ($item in @(Get-InboxSignalItems -Path (Get-AgentInboxPath -Slug $definition.slug) -MaxItems 3)) {
            $key = $item.ToLowerInvariant()
            if ($seen.ContainsKey($key)) {
                continue
            }

            $seen[$key] = $true
            $mergedItems.Add($item) | Out-Null
        }

        if ($mergedItems.Count -eq 0) {
            continue
        }

        $sourceCount += 1
        $parts.Add("") | Out-Null
        $parts.Add(("### {0}" -f $definition.displayName)) | Out-Null
        $parts.Add("") | Out-Null
        foreach ($item in @($mergedItems | Select-Object -First 6)) {
            $parts.Add("- $item") | Out-Null
        }
    }

    if ($sourceCount -eq 0) {
        $parts.Add("") | Out-Null
        $parts.Add("- No active cross-tool context detected yet.") | Out-Null
    }

    return (($parts.ToArray() -join "`n").Trim())
}

function Optimize-CanonicalNotes {
    Ensure-BusTemplates

    $memoryExisting = Read-Text -Path $Script:CanonicalMemory
    $memoryUpdated = Upsert-MarkedSection -ExistingText $memoryExisting `
        -StartMarker "<!-- AUTO-OPTIMIZED-MEMORY:START -->" `
        -EndMarker "<!-- AUTO-OPTIMIZED-MEMORY:END -->" `
        -SectionBody (Build-AutoOptimizedMemorySection) `
        -Position "append"
    Write-TextIfChanged -Path $Script:CanonicalMemory -Content $memoryUpdated | Out-Null

    $workingExisting = Read-Text -Path $Script:CanonicalWorking
    $workingUpdated = Upsert-MarkedSection -ExistingText $workingExisting `
        -StartMarker "<!-- AUTO-OPTIMIZED-WORKING:START -->" `
        -EndMarker "<!-- AUTO-OPTIMIZED-WORKING:END -->" `
        -SectionBody (Build-AutoOptimizedWorkingSection) `
        -Position "append"
    Write-TextIfChanged -Path $Script:CanonicalWorking -Content $workingUpdated | Out-Null
}