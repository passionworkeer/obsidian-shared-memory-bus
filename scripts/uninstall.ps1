param(
    [Parameter(Mandatory = $false)]
    [switch]$WhatIf
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Split-Path -Parent $root
$helperPath = @(
    (Join-Path $sourceRoot "runtime-platform.ps1"),
    (Join-Path $sourceRoot (Join-Path "bus" "runtime-platform.ps1"))
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $helperPath) {
    throw "Unable to locate runtime-platform.ps1 from $root"
}

. $helperPath

$aiMemoryRoot = Get-SharedDefaultAiMemoryRoot
$watchdogStatePath = Join-Path $aiMemoryRoot "watchdog-state.json"
$sharedMcpStatePath = Join-Path $aiMemoryRoot "shared-mcp", "state.json"
$startupDir = Join-SharedPath @((Get-SharedConfigHome), "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
$manifestPath = Join-Path $sourceRoot (Join-Path "shared-mcp" "manifest.json")

# Track what was removed for the final summary.
$removed = [ordered]@{
    watchdogProcess = $false
    sharedMcpServers = @()
    startupVbs       = @()
    launchAgents     = @()   # macOS only — noted on Windows
    aiMemoryDir      = $false
    envVars          = @()
    autostartDesktop = @()   # Linux only
}

function Remove-ItemSafely {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Recurse
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    if ($WhatIf) {
        Write-Output "[WhatIf] Would remove: $Path"
        return
    }

    if ($Recurse) {
        Remove-Item -LiteralPath $Path -Force -Recurse -ErrorAction Stop
    } else {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
}

# ---------------------------------------------------------------------------
# Step 1: Stop the watchdog process
# ---------------------------------------------------------------------------
Write-Output "==> Stopping watchdog process..."

if (Test-Path -LiteralPath $watchdogStatePath -PathType Leaf) {
    try {
        $watchdogState = Get-Content -Raw -LiteralPath $watchdogStatePath -Encoding utf8 | ConvertFrom-Json
        $watchdogPid = if ($null -ne $watchdogState.pid) { [int]$watchdogState.pid } else { 0 }
        if ($watchdogPid -gt 0) {
            $alive = $null -ne (Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue)
            if ($alive) {
                if ($WhatIf) {
                    Write-Output "[WhatIf] Would kill watchdog PID $watchdogPid"
                } else {
                    Stop-SharedProcessTree -ProcessId $watchdogPid
                    Write-Output "      Killed watchdog PID $watchdogPid"
                    $removed.watchdogProcess = $true
                }
            } else {
                Write-Output "      Watchdog PID $watchdogPid is already dead"
                $removed.watchdogProcess = $true
            }
        } else {
            Write-Output "      No PID recorded in watchdog-state.json"
            $removed.watchdogProcess = $true
        }
    } catch {
        Write-Warning "      Could not read watchdog-state.json: $($_.Exception.Message)"
    }
} else {
    Write-Output "      watchdog-state.json not found at $watchdogStatePath"
    $removed.watchdogProcess = $true
}

# ---------------------------------------------------------------------------
# Step 2: Stop all shared MCP servers
# ---------------------------------------------------------------------------
Write-Output "==> Stopping shared MCP servers..."

$stoppedFromState = $false
if (Test-Path -LiteralPath $sharedMcpStatePath -PathType Leaf) {
    try {
        $state = Get-Content -Raw -LiteralPath $sharedMcpStatePath -Encoding utf8 | ConvertFrom-Json
        $killed = 0
        foreach ($property in @($state.PSObject.Properties)) {
            $entry = $property.Value
            $serverId = [string]$property.Name
            $recordedPid = 0
            if ($entry.PSObject.Properties.Name -contains "pid") {
                $recordedPid = [int]$entry.pid
            }
            if ($recordedPid -le 0) {
                continue
            }
            $alive = $null -ne (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)
            if ($alive) {
                if ($WhatIf) {
                    Write-Output "[WhatIf] Would kill server '$serverId' PID $recordedPid"
                } else {
                    Stop-SharedProcessTree -ProcessId $recordedPid
                    $killed++
                    $removed.sharedMcpServers += "$serverId (PID $recordedPid)"
                    Write-Output "      Killed server '$serverId' PID $recordedPid"
                }
            }
        }
        $stoppedFromState = $true
    } catch {
        Write-Warning "      Could not read shared-mcp/state.json: $($_.Exception.Message)"
    }
}

# Fallback: probe ports from manifest if state.json does not exist or is empty.
if (-not $stoppedFromState -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding utf8 | ConvertFrom-Json
        foreach ($server in @($manifest.servers)) {
            if (-not ($server.PSObject.Properties.Name -contains "port")) {
                continue
            }
            if ($server.mode -eq "isolated") {
                continue
            }
            $port = [int]$server.port
            $serverId = [string]$server.id
            foreach ($listenerPid in @(Get-SharedListeningProcessIds -Port $port)) {
                if ([int]$listenerPid -gt 0) {
                    if ($WhatIf) {
                        Write-Output "[WhatIf] Would kill server '$serverId' on port $port (PID $listenerPid)"
                    } else {
                        Stop-SharedProcessTree -ProcessId ([int]$listenerPid)
                        $removed.sharedMcpServers += "$serverId (PID $listenerPid, port $port)"
                        Write-Output "      Killed server '$serverId' on port $port PID $listenerPid"
                    }
                }
            }
        }
    } catch {
        Write-Warning "      Could not probe manifest ports: $($_.Exception.Message)"
    }
}

if ($removed.sharedMcpServers.Count -eq 0) {
    Write-Output "      No running shared MCP servers found"
}

# ---------------------------------------------------------------------------
# Step 3: Remove VBS startup entries (Windows)
# ---------------------------------------------------------------------------
Write-Output "==> Removing VBS startup entries..."

if (Test-SharedIsWindows) {
    $vbsPattern = Join-Path $startupDir "*.vbs"
    $matchedVbs = @()
    try {
        $matchedVbs = @(Get-ChildItem -LiteralPath $vbsPattern -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match "ai-memory"
        })
    } catch {
        Write-Warning "      Could not enumerate startup directory: $($_.Exception.Message)"
    }

    if ($matchedVbs.Count -eq 0) {
        Write-Output "      No ai-memory VBS entries found in Startup folder"
    }

    foreach ($vbsFile in $matchedVbs) {
        Remove-ItemSafely -Path $vbsFile.FullName
        if (-not $WhatIf) {
            $removed.startupVbs += $vbsFile.Name
            Write-Output "      Removed: $($vbsFile.Name)"
        }
    }
} else {
    # Startup management on non-Windows is handled by uninstall.sh / .launchd.plist cleanup.
    Write-Output "      [Non-Windows] VBS startup entries are Windows-specific (managed by uninstall.sh on macOS/Linux)"
}

# ---------------------------------------------------------------------------
# Step 4: Remove macOS LaunchAgent plists (macOS only — skip on Windows)
# ---------------------------------------------------------------------------
Write-Output "==> Removing macOS LaunchAgent plists..."

if (Test-SharedIsMacOS) {
    $launchAgentsDir = Join-SharedPath @((Get-SharedUserHome), "Library", "LaunchAgents")
    $patterns = @("com.ai-memory.watchdog.plist", "com.ai-memory.shared-mcp.plist")

    foreach ($pattern in $patterns) {
        $plistPath = Join-Path $launchAgentsDir $pattern
        if (Test-Path -LiteralPath $plistPath) {
            # unload first if launchctl is available
            $launchctl = Get-Command launchctl -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($launchctl) {
                try {
                    if (-not $WhatIf) {
                        & $launchctl.Source unload $plistPath 2>$null | Out-Null
                    }
                } catch { }
            }
            Remove-ItemSafely -Path $plistPath
            if (-not $WhatIf) {
                $removed.launchAgents += $pattern
                Write-Output "      Removed: $pattern"
            }
        } else {
            Write-Output "      Not found (skipped): $pattern"
        }
    }
} else {
    Write-Output "      [Non-macOS] LaunchAgent plists are macOS-specific"
}

# ---------------------------------------------------------------------------
# Step 5: Remove ~/.ai-memory directory
# ---------------------------------------------------------------------------
Write-Output "==> Removing ~/.ai-memory directory..."

if (Test-Path -LiteralPath $aiMemoryRoot -PathType Container) {
    Remove-ItemSafely -Path $aiMemoryRoot -Recurse
    if (-not $WhatIf) {
        $removed.aiMemoryDir = $true
        Write-Output "      Removed: $aiMemoryRoot"
    }
} else {
    Write-Output "      Not present — nothing to remove"
    $removed.aiMemoryDir = $true
}

# ---------------------------------------------------------------------------
# Step 6: Remove User-scope environment variables
# ---------------------------------------------------------------------------
Write-Output "==> Removing environment variables (User scope)..."

foreach ($varName in @("AI_MEMORY_ROOT", "AI_MEMORY_PYTHON", "AI_MEMORY_MCP_PYTHON")) {
    $currentValue = [Environment]::GetEnvironmentVariable($varName, "User")
    if ([string]::IsNullOrWhiteSpace($currentValue)) {
        Write-Output "      $varName is not set — nothing to remove"
    } else {
        if ($WhatIf) {
            Write-Output "[WhatIf] Would remove $varName (currently: $currentValue)"
        } else {
            [Environment]::SetEnvironmentVariable($varName, $null, "User")
            $removed.envVars += $varName
            Write-Output "      Removed: $varName"
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Output ""
Write-Output "=== Uninstall Summary ==="

if ($WhatIf) {
    Write-Output "  (Preview only — no changes were made)"
    Write-Output ""
}

if ($removed.watchdogProcess) {
    Write-Output "  [OK] Watchdog: no zombie process left behind"
} else {
    Write-Output "  [!!] Watchdog may still be running — please check manually"
}

if ($removed.sharedMcpServers.Count -gt 0) {
    foreach ($s in $removed.sharedMcpServers) {
        Write-Output "  [OK] Stopped server: $s"
    }
} else {
    Write-Output "  [OK] Shared MCP servers: none running"
}

if (Test-SharedIsWindows) {
    if ($removed.startupVbs.Count -gt 0) {
        foreach ($v in $removed.startupVbs) {
            Write-Output "  [OK] Removed startup entry: $v"
        }
    } else {
        Write-Output "  [OK] Startup entries: none found"
    }
} elseif (Test-SharedIsMacOS) {
    if ($removed.launchAgents.Count -gt 0) {
        foreach ($p in $removed.launchAgents) {
            Write-Output "  [OK] Removed LaunchAgent: $p"
        }
    } else {
        Write-Output "  [OK] LaunchAgent plists: none found"
    }
} else {
    # Linux: remove XDG autostart .desktop entries
    $autostartDir = Join-SharedPath @((Get-SharedConfigHome), "autostart")
    $desktopFiles = @("ai-memory-watchdog.desktop", "ai-memory-shared-mcp.desktop")
    foreach ($deskFile in $desktopFiles) {
        $deskPath = Join-Path $autostartDir $deskFile
        if (Test-Path -LiteralPath $deskPath) {
            Remove-ItemSafely -Path $deskPath
            if (-not $WhatIf) {
                $removed.autostartDesktop += $deskFile
                Write-Output "  [OK] Removed XDG autostart: $deskFile"
            }
        }
    }

    # Also check systemd user services
    $systemdUserDir = Join-SharedPath @((Get-SharedConfigHome), "systemd", "user")
    $serviceFiles = @("ai-memory-watchdog.service", "ai-memory-shared-mcp.service")
    foreach ($svcFile in $serviceFiles) {
        $svcPath = Join-Path $systemdUserDir $svcFile
        if (Test-Path -LiteralPath $svcPath) {
            $systemctl = Get-Command systemctl -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($systemctl -and -not $WhatIf) {
                try { & $systemctl.Source --user disable $svcFile 2>$null | Out-Null } catch { }
            }
            Remove-ItemSafely -Path $svcPath
            if (-not $WhatIf) {
                Write-Output "  [OK] Removed systemd service: $svcFile"
            }
        }
    }
}

if ($removed.aiMemoryDir) {
    Write-Output "  [OK] ~/.ai-memory directory: removed"
}

if ($removed.envVars.Count -gt 0) {
    foreach ($v in $removed.envVars) {
        Write-Output "  [OK] Removed env var: $v"
    }
} else {
    Write-Output "  [OK] Environment variables: none were set"
}

Write-Output ""
if ($WhatIf) {
    Write-Output "Re-run without -WhatIf to perform the actual uninstallation."
}
