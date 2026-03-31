param(
    [string]$WorkspaceRoot = "",
    [string]$AiMemoryRoot = "",
    [switch]$Quiet
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

if ([string]::IsNullOrWhiteSpace($AiMemoryRoot)) {
    $AiMemoryRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_MEMORY_ROOT)) { $env:AI_MEMORY_ROOT } else { Join-Path $env:USERPROFILE ".ai-memory" }
}

function Resolve-ObsidianVaultRoot {
    param([AllowEmptyString()][string]$FallbackPath = "")

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

    foreach ($candidate in @($FallbackPath, (Join-Path $env:USERPROFILE "Documents\Obsidian Vault"))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }

    return $FallbackPath
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$DefaultObject
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $DefaultObject
    }

    $content = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    if ([string]::IsNullOrWhiteSpace($content)) {
        return $DefaultObject
    }

    try {
        return ($content | ConvertFrom-Json)
    } catch {
        return $DefaultObject
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Object
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    $json = $Object | ConvertTo-Json -Depth 16
    [System.IO.File]::WriteAllText($Path, ($json.Trim() + "`n"), $Utf8NoBom)
}

function Write-TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    Ensure-Directory -Path (Split-Path -Parent $Path)
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Set-MapValue {
    param(
        [Parameter(Mandatory = $true)]$Map,
        [Parameter(Mandatory = $true)][string]$Key,
        [AllowNull()]$Value
    )

    $Map[$Key] = $Value
}

function Get-FrontmatterValue {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key
    )

    if ($Text -notmatch "(?ms)^---\s*(?<front>.*?)\s*---") {
        return ""
    }

    $front = $Matches["front"]
    foreach ($line in @($front -split "`r?`n")) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*:\s*(.+?)\s*$") {
            $value = [string]$Matches[1]
            $value = $value.Trim().Trim('"').Trim("'")
            if ($value -eq "|" -or $value -eq ">") {
                return ""
            }
            return $value
        }
    }

    return ""
}

function Get-FallbackDescription {
    param([Parameter(Mandatory = $true)][string]$Text)

    $normalized = $Text
    if ($normalized -match "(?ms)^---\s*.*?\s*---\s*(?<body>.*)$") {
        $normalized = $Matches["body"]
    }

    foreach ($line in @($normalized -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
            continue
        }
        if ($trimmed.StartsWith("#")) {
            continue
        }
        return $trimmed
    }

    return ""
}

function Get-SkillRecords {
    param(
        [AllowEmptyString()][string]$Root,
        [Parameter(Mandatory = $true)][string]$SourceKind,
        [Parameter(Mandatory = $true)][string]$PublishMode
    )

    $records = New-Object System.Collections.Generic.List[object]
    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
        return $records
    }

    foreach ($dir in @(Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
        if ($dir.Name -eq ".system") {
            continue
        }

        $skillPath = Join-Path $dir.FullName "SKILL.md"
        if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf)) {
            continue
        }

        $text = Get-Content -Raw -LiteralPath $skillPath -Encoding utf8
        $declaredName = Get-FrontmatterValue -Text $text -Key "name"
        if ([string]::IsNullOrWhiteSpace($declaredName)) {
            $declaredName = $dir.Name
        }

        $description = Get-FrontmatterValue -Text $text -Key "description"
        if ([string]::IsNullOrWhiteSpace($description)) {
            $description = Get-FallbackDescription -Text $text
        }

        $records.Add([pscustomobject]@{
            slug = $dir.Name
            key = $dir.Name.ToLowerInvariant()
            declaredName = $declaredName
            description = $description
            path = $dir.FullName
            skillFile = $skillPath
            sourceKind = $SourceKind
            publishMode = $PublishMode
        }) | Out-Null
    }

    return $records
}

function New-RecordMap {
    param([Parameter(Mandatory = $true)][System.Collections.Generic.List[object]]$Records)

    $map = @{}
    foreach ($record in @($Records)) {
        if (-not $map.ContainsKey($record.key)) {
            $map[$record.key] = $record
        }
    }
    return $map
}

function Resolve-NormalizedPath {
    param([AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    try {
        return (Get-Item -LiteralPath $Path -Force).FullName
    } catch {
        try {
            return [System.IO.Path]::GetFullPath($Path)
        } catch {
            return $Path
        }
    }
}

function Get-LinkTargetPath {
    param([Parameter(Mandatory = $true)]$Item)

    $linkType = if ($Item.PSObject.Properties["LinkType"]) { [string]$Item.LinkType } else { "" }
    if ([string]::IsNullOrWhiteSpace($linkType)) {
        return ""
    }

    if (-not $Item.PSObject.Properties["Target"]) {
        return ""
    }

    $target = [string](@($Item.Target) | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($target)) {
        return ""
    }

    return (Resolve-NormalizedPath -Path $target)
}

function Test-PathWithinRoot {
    param(
        [AllowEmptyString()][string]$Path,
        [AllowEmptyString()][string]$Root
    )

    $normalizedPath = Resolve-NormalizedPath -Path $Path
    $normalizedRoot = Resolve-NormalizedPath -Path $Root
    if ([string]::IsNullOrWhiteSpace($normalizedPath) -or [string]::IsNullOrWhiteSpace($normalizedRoot)) {
        return $false
    }

    $pathKey = $normalizedPath.ToLowerInvariant()
    $rootKey = $normalizedRoot.TrimEnd('\', '/').ToLowerInvariant()
    return ($pathKey -eq $rootKey -or $pathKey.StartsWith($rootKey + "\"))
}

function Get-ObservedManagedLinks {
    param(
        [AllowEmptyString()][string]$PortableRoot,
        [AllowEmptyString()][string]$AllowedSourceRoot,
        [Parameter(Mandatory = $true)][string]$Scope
    )

    $links = New-Object System.Collections.Generic.List[object]
    if ([string]::IsNullOrWhiteSpace($PortableRoot) -or -not (Test-Path -LiteralPath $PortableRoot -PathType Container)) {
        return $links
    }

    if ([string]::IsNullOrWhiteSpace($AllowedSourceRoot) -or -not (Test-Path -LiteralPath $AllowedSourceRoot -PathType Container)) {
        return $links
    }

    foreach ($dir in @(Get-ChildItem -LiteralPath $PortableRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $linkType = if ($dir.PSObject.Properties["LinkType"]) { [string]$dir.LinkType } else { "" }
        if ($linkType -ne "Junction" -and $linkType -ne "SymbolicLink") {
            continue
        }

        $sourcePath = Get-LinkTargetPath -Item $dir
        if ([string]::IsNullOrWhiteSpace($sourcePath)) {
            continue
        }

        if (-not (Test-PathWithinRoot -Path $sourcePath -Root $AllowedSourceRoot)) {
            continue
        }

        if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "SKILL.md") -PathType Leaf)) {
            continue
        }

        $links.Add([pscustomobject]@{
            scope = $Scope
            skill = $dir.Name
            target = $dir.FullName
            source = $sourcePath
        }) | Out-Null
    }

    return $links
}

function New-ManagedLink {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$Scope,
        [Parameter(Mandatory = $true)][string]$SkillName,
        [Parameter(Mandatory = $true)][hashtable]$ExistingManagedMap,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Created,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Kept,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Skipped
    )

    $existingManaged = $null
    if ($ExistingManagedMap.ContainsKey($TargetPath.ToLowerInvariant())) {
        $existingManaged = $ExistingManagedMap[$TargetPath.ToLowerInvariant()]
    }

    $targetExists = Test-Path -LiteralPath $TargetPath
    if ($targetExists -and $null -eq $existingManaged) {
        $existingItem = Get-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
        $existingLinkType = if ($null -ne $existingItem -and $existingItem.PSObject.Properties["LinkType"]) { [string]$existingItem.LinkType } else { "" }
        $existingTarget = ""
        if ($null -ne $existingItem -and $existingItem.PSObject.Properties["Target"]) {
            $existingTarget = [string](@($existingItem.Target) | Select-Object -First 1)
        }
        $resolvedSource = if (Test-Path -LiteralPath $SourcePath) { (Get-Item -LiteralPath $SourcePath).FullName } else { $SourcePath }
        if ($existingLinkType -eq "Junction" -and -not [string]::IsNullOrWhiteSpace($existingTarget)) {
            try {
                $resolvedExistingTarget = (Get-Item -LiteralPath $existingTarget).FullName
                if ($resolvedExistingTarget -eq $resolvedSource) {
                    $Kept.Add([pscustomobject]@{
                        skill = $SkillName
                        target = $TargetPath
                        source = $SourcePath
                        scope = $Scope
                    }) | Out-Null
                    return [pscustomobject]@{
                        created = $false
                        kept = $true
                        skipped = $false
                    }
                }
            } catch {
            }
        }

        $Skipped.Add([pscustomobject]@{
            skill = $SkillName
            target = $TargetPath
            source = $SourcePath
            reason = "exists-unmanaged"
            scope = $Scope
        }) | Out-Null
        return [pscustomobject]@{
            created = $false
            kept = $false
            skipped = $true
        }
    }

    if ($targetExists -and $null -ne $existingManaged) {
        if ($existingManaged.source -eq $SourcePath) {
            $Kept.Add([pscustomobject]@{
                skill = $SkillName
                target = $TargetPath
                source = $SourcePath
                scope = $Scope
            }) | Out-Null
            return [pscustomobject]@{
                created = $false
                kept = $true
                skipped = $false
            }
        }

        Remove-Item -LiteralPath $TargetPath -Force -Recurse
    }

    Ensure-Directory -Path (Split-Path -Parent $TargetPath)
    try {
        [void](New-Item -ItemType Junction -Path $TargetPath -Target $SourcePath -Force)
    } catch {
        $mklink = cmd.exe /d /c ('mklink /J "{0}" "{1}"' -f $TargetPath, $SourcePath) 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ("Failed to create junction for skill '{0}': {1}" -f $SkillName, (($mklink | Out-String).Trim()))
        }
    }

    $Created.Add([pscustomobject]@{
        skill = $SkillName
        target = $TargetPath
        source = $SourcePath
        scope = $Scope
    }) | Out-Null

    return [pscustomobject]@{
        created = $true
        kept = $false
        skipped = $false
    }
}

function Remove-StaleManagedLinks {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$ExistingLinks,
        [Parameter(Mandatory = $true)][hashtable]$DesiredTargets
    )

    $removed = New-Object System.Collections.Generic.List[object]
    foreach ($link in @($ExistingLinks)) {
        $target = [string]$link.target
        if ([string]::IsNullOrWhiteSpace($target)) {
            continue
        }

        if ($DesiredTargets.ContainsKey($target.ToLowerInvariant())) {
            continue
        }

        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force -Recurse
            $removed.Add($link) | Out-Null
        }
    }

    return $removed
}

function Format-SkillBullet {
    param([Parameter(Mandatory = $true)]$Record)

    $description = [string]$Record.description
    if ([string]::IsNullOrWhiteSpace($description)) {
        $description = "(no description)"
    }
    $description = ($description -replace "\s+", " ").Trim()
    if ($description.Length -gt 180) {
        $description = $description.Substring(0, 177) + "..."
    }

    return ("- `{0}`: {1}" -f $Record.slug, $description)
}

$userHome = $env:USERPROFILE
$vaultRoot = Resolve-ObsidianVaultRoot -FallbackPath (Join-Path $userHome "Documents\Obsidian Vault")
$generatedRoot = Join-Path $vaultRoot "00-System\ai-memory\generated"
$sharedGuidePath = Join-Path $generatedRoot "SHARED-SKILLS.md"
$sharedJsonPath = Join-Path $generatedRoot "SHARED-SKILLS.json"
$catalogRoot = Join-Path $AiMemoryRoot "shared-skills"
$managedLinksPath = Join-Path $catalogRoot "managed-links.json"
$catalogReadmePath = Join-Path $catalogRoot "README.md"

$globalPortableRoot = Join-Path $userHome ".agents\skills"
$globalCodexRoot = Join-Path $userHome ".codex\skills"
$globalClaudeRoot = Join-Path $userHome ".claude\skills"

$workspacePortableRoot = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { "" } else { Join-Path $WorkspaceRoot ".agents\skills" }
$workspaceGenericRoot = if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) { "" } else { Join-Path $WorkspaceRoot "skills" }

Ensure-Directory -Path $catalogRoot
Ensure-Directory -Path $generatedRoot
Ensure-Directory -Path $globalPortableRoot
if (-not [string]::IsNullOrWhiteSpace($workspacePortableRoot)) {
    Ensure-Directory -Path $workspacePortableRoot
}

$globalPortable = Get-SkillRecords -Root $globalPortableRoot -SourceKind "global-portable" -PublishMode "portable"
$globalCodex = Get-SkillRecords -Root $globalCodexRoot -SourceKind "global-codex" -PublishMode "publish-to-portable"
$globalClaude = Get-SkillRecords -Root $globalClaudeRoot -SourceKind "global-claude" -PublishMode "index-only"
$workspacePortable = Get-SkillRecords -Root $workspacePortableRoot -SourceKind "workspace-portable" -PublishMode "portable"
$workspaceGeneric = Get-SkillRecords -Root $workspaceGenericRoot -SourceKind "workspace-generic" -PublishMode "publish-to-portable"

$globalPortableMap = New-RecordMap -Records $globalPortable
$workspacePortableMap = New-RecordMap -Records $workspacePortable

$managedState = Read-JsonFile -Path $managedLinksPath -DefaultObject ([pscustomobject]@{ version = 1; links = @() })
$managedMap = @{}
foreach ($link in @($managedState.links)) {
    if ($null -ne $link.target) {
        $managedMap[[string]$link.target.ToLowerInvariant()] = $link
    }
}

$createdLinks = New-Object System.Collections.Generic.List[object]
$keptLinks = New-Object System.Collections.Generic.List[object]
$skippedLinks = New-Object System.Collections.Generic.List[object]
$desiredLinks = New-Object System.Collections.Generic.List[object]
$desiredTargetMap = @{}

foreach ($record in @($globalCodex | Sort-Object slug)) {
    if ($globalPortableMap.ContainsKey($record.key)) {
        continue
    }

    $targetPath = Join-Path $globalPortableRoot $record.slug
    $result = New-ManagedLink -TargetPath $targetPath -SourcePath $record.path -Scope "global-portable" -SkillName $record.slug -ExistingManagedMap $managedMap -Created $createdLinks -Kept $keptLinks -Skipped $skippedLinks
    if (-not $result.skipped) {
        $link = [pscustomobject]@{
            scope = "global-portable"
            skill = $record.slug
            target = $targetPath
            source = $record.path
        }
        $desiredLinks.Add($link) | Out-Null
        $desiredTargetMap[$targetPath.ToLowerInvariant()] = $true
    }
}

foreach ($record in @($workspaceGeneric | Sort-Object slug)) {
    if ($workspacePortableMap.ContainsKey($record.key)) {
        continue
    }

    $targetPath = Join-Path $workspacePortableRoot $record.slug
    $result = New-ManagedLink -TargetPath $targetPath -SourcePath $record.path -Scope "workspace-portable" -SkillName $record.slug -ExistingManagedMap $managedMap -Created $createdLinks -Kept $keptLinks -Skipped $skippedLinks
    if (-not $result.skipped) {
        $link = [pscustomobject]@{
            scope = "workspace-portable"
            skill = $record.slug
            target = $targetPath
            source = $record.path
        }
        $desiredLinks.Add($link) | Out-Null
        $desiredTargetMap[$targetPath.ToLowerInvariant()] = $true
    }
}

$observedManagedLinks = New-Object System.Collections.Generic.List[object]
foreach ($link in @(Get-ObservedManagedLinks -PortableRoot $globalPortableRoot -AllowedSourceRoot $globalCodexRoot -Scope "global-portable")) {
    $observedManagedLinks.Add($link) | Out-Null
}
foreach ($link in @(Get-ObservedManagedLinks -PortableRoot $workspacePortableRoot -AllowedSourceRoot $workspaceGenericRoot -Scope "workspace-portable")) {
    $observedManagedLinks.Add($link) | Out-Null
}

$createdLinkMap = @{}
foreach ($link in $createdLinks) {
    $createdLinkMap[("{0}|{1}|{2}" -f [string]$link.scope, [string]$link.skill, [string]$link.target).ToLowerInvariant()] = $true
}

$keptLinkMap = @{}
foreach ($link in $keptLinks) {
    $keptLinkMap[("{0}|{1}|{2}" -f [string]$link.scope, [string]$link.skill, [string]$link.target).ToLowerInvariant()] = $true
}

$desiredLinks = New-Object System.Collections.Generic.List[object]
$desiredTargetMap = @{}
foreach ($link in @($observedManagedLinks | Sort-Object scope, skill, target)) {
    $desiredLinks.Add($link) | Out-Null
    $desiredTargetMap[[string]$link.target.ToLowerInvariant()] = $true

    $linkKey = ("{0}|{1}|{2}" -f [string]$link.scope, [string]$link.skill, [string]$link.target).ToLowerInvariant()
    if (-not $createdLinkMap.ContainsKey($linkKey) -and -not $keptLinkMap.ContainsKey($linkKey)) {
        $keptLinks.Add($link) | Out-Null
        $keptLinkMap[$linkKey] = $true
    }
}

$removedLinks = Remove-StaleManagedLinks -ExistingLinks @($managedState.links) -DesiredTargets $desiredTargetMap
$managedPayload = [ordered]@{
    version = 1
    generatedAt = (Get-Date).ToString("o")
    links = @($desiredLinks | Sort-Object scope, skill, target)
}
Write-JsonFile -Path $managedLinksPath -Object $managedPayload

$globalPortableFinal = Get-SkillRecords -Root $globalPortableRoot -SourceKind "global-portable" -PublishMode "portable"
$workspacePortableFinal = Get-SkillRecords -Root $workspacePortableRoot -SourceKind "workspace-portable" -PublishMode "portable"
$workspaceRootsText = if (-not [string]::IsNullOrWhiteSpace($workspacePortableRoot)) {
    "- Workspace portable root: $workspacePortableRoot`n- Workspace generic root: $workspaceGenericRoot"
} else {
    "- Workspace portable root: (not provided)"
}
$globalPortableSection = if (@($globalPortableFinal).Count -gt 0) {
    [string]::Join("`n", @($globalPortableFinal | Sort-Object slug | ForEach-Object { Format-SkillBullet -Record $_ }))
} else {
    "(none)"
}
$workspacePortableSection = if (@($workspacePortableFinal).Count -gt 0) {
    [string]::Join("`n", @($workspacePortableFinal | Sort-Object slug | ForEach-Object { Format-SkillBullet -Record $_ }))
} else {
    "(none)"
}
$createdLinksSection = if ($createdLinks.Count -gt 0) {
    [string]::Join("`n", @($createdLinks | Sort-Object scope, skill | ForEach-Object { "- ``{0}`` -> ``{1}``" -f $_.skill, $_.source }))
} else {
    "(none)"
}

$guide = @"
# Shared Skills Catalog

Generated at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## Shared Skill Roots
- Global portable root: $globalPortableRoot
- Global Codex root: $globalCodexRoot
- Global Claude root: $globalClaudeRoot
$workspaceRootsText
- Managed link manifest: $managedLinksPath

## Publish Policy
- `~/.agents/skills` is treated as the cross-tool portable skill root.
- Missing skills from `~/.codex/skills` are mirrored into `~/.agents/skills` as managed junctions so Codex-origin skills become visible to other skill-compatible agents.
- Plain workspace `skills/*/SKILL.md` folders are mirrored into `<workspace>/.agents/skills` so repo-local skills are visible to Codex, Claude-compatible agents, Copilot, and OpenCode.
- `~/.claude/skills` is indexed as a native library, but is not auto-mirrored into `~/.agents/skills` by default because that library is much larger and more heterogeneous.

## Counts
- Global portable skills: $(@($globalPortableFinal).Count)
- Global Codex-native skills: $(@($globalCodex).Count)
- Global Claude-native skills: $(@($globalClaude).Count)
- Workspace portable skills: $(@($workspacePortableFinal).Count)
- Workspace generic skills: $(@($workspaceGeneric).Count)
- Managed links created this run: $($createdLinks.Count)
- Managed links kept this run: $($keptLinks.Count)
- Managed links skipped due to existing unmanaged targets: $($skippedLinks.Count)
- Managed links removed this run: $(@($removedLinks).Count)

## Global Portable Skills
$globalPortableSection

## Workspace Portable Skills
$workspacePortableSection

## Managed Links Created This Run
$createdLinksSection

## Native Libraries Indexed But Not Auto-Mirrored
- Claude native skills remain available under: $globalClaudeRoot
- Full inventory with source paths and publish status is in: $sharedJsonPath
"@

$rootsPayload = @{}
Set-MapValue -Map $rootsPayload -Key "globalPortable" -Value $globalPortableRoot
Set-MapValue -Map $rootsPayload -Key "globalCodex" -Value $globalCodexRoot
Set-MapValue -Map $rootsPayload -Key "globalClaude" -Value $globalClaudeRoot
Set-MapValue -Map $rootsPayload -Key "workspacePortable" -Value $workspacePortableRoot
Set-MapValue -Map $rootsPayload -Key "workspaceGeneric" -Value $workspaceGenericRoot
Set-MapValue -Map $rootsPayload -Key "manifest" -Value $managedLinksPath

$countsPayload = @{}
Set-MapValue -Map $countsPayload -Key "globalPortable" -Value @($globalPortableFinal).Count
Set-MapValue -Map $countsPayload -Key "globalCodex" -Value @($globalCodex).Count
Set-MapValue -Map $countsPayload -Key "globalClaude" -Value @($globalClaude).Count
Set-MapValue -Map $countsPayload -Key "workspacePortable" -Value @($workspacePortableFinal).Count
Set-MapValue -Map $countsPayload -Key "workspaceGeneric" -Value @($workspaceGeneric).Count
Set-MapValue -Map $countsPayload -Key "createdLinks" -Value $createdLinks.Count
Set-MapValue -Map $countsPayload -Key "keptLinks" -Value $keptLinks.Count
Set-MapValue -Map $countsPayload -Key "skippedLinks" -Value $skippedLinks.Count
Set-MapValue -Map $countsPayload -Key "removedLinks" -Value @($removedLinks).Count

$inventoryPayload = @{}
Set-MapValue -Map $inventoryPayload -Key "globalPortable" -Value @($globalPortableFinal | Sort-Object slug)
Set-MapValue -Map $inventoryPayload -Key "globalCodex" -Value @($globalCodex | Sort-Object slug)
Set-MapValue -Map $inventoryPayload -Key "globalClaude" -Value @($globalClaude | Sort-Object slug)
Set-MapValue -Map $inventoryPayload -Key "workspacePortable" -Value @($workspacePortableFinal | Sort-Object slug)
Set-MapValue -Map $inventoryPayload -Key "workspaceGeneric" -Value @($workspaceGeneric | Sort-Object slug)

$jsonPayload = @{}
Set-MapValue -Map $jsonPayload -Key "generatedAt" -Value (Get-Date).ToString("o")
Set-MapValue -Map $jsonPayload -Key "roots" -Value $rootsPayload
Set-MapValue -Map $jsonPayload -Key "counts" -Value $countsPayload
Set-MapValue -Map $jsonPayload -Key "createdLinks" -Value @($createdLinks | ForEach-Object { $_ })
Set-MapValue -Map $jsonPayload -Key "keptLinks" -Value @($keptLinks | ForEach-Object { $_ })
Set-MapValue -Map $jsonPayload -Key "skippedLinks" -Value @($skippedLinks | ForEach-Object { $_ })
Set-MapValue -Map $jsonPayload -Key "removedLinks" -Value @($removedLinks | ForEach-Object { $_ })
Set-MapValue -Map $jsonPayload -Key "inventory" -Value $inventoryPayload

Write-TextFile -Path $sharedGuidePath -Content ($guide.Trim() + "`n")
Write-JsonFile -Path $sharedJsonPath -Object $jsonPayload
Write-TextFile -Path $catalogReadmePath -Content @"
# Shared Skills Sync

This folder tracks the managed skill-sharing layer.

- Portable global root: $globalPortableRoot
- Generated guide: $sharedGuidePath
- Generated inventory: $sharedJsonPath
- Managed links manifest: $managedLinksPath
"@

if (-not $Quiet) {
    $jsonPayload | ConvertTo-Json -Depth 16
}
