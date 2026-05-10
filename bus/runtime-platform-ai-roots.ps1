Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# runtime-platform-ai-roots.ps1
# AI tool path roots: OpenCode, Copilot, Trae, VS Code.
# Depends on: runtime-platform-paths.ps1, runtime-platform-store.ps1
# ---------------------------------------------------------------------------

. "$PSScriptRoot\runtime-platform-paths.ps1"
. "$PSScriptRoot\runtime-platform-store.ps1"

function Get-SharedOpenCodeDataRoot {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        return (Join-SharedPath @($userHome, ".local", "share", "opencode"))
    }

    return (Join-SharedPath @((Get-SharedDataHome), "opencode"))
}

function Get-SharedOpenCodeConfigRoot {
    $userHome = Get-SharedUserHome
    if (Test-SharedIsWindows) {
        return (Join-SharedPath @($userHome, ".config", "opencode"))
    }

    return (Join-SharedPath @((Get-SharedConfigHome), "opencode"))
}

function Get-SharedCopilotHomeRoot {
    return (Join-SharedPath @((Get-SharedUserHome), ".copilot"))
}

function Get-SharedTraeUserRoot {
    param([Parameter(Mandatory = $true)][string]$ProductName)

    return (Join-SharedPath @((Get-SharedConfigHome), $ProductName, "User"))
}

function Get-SharedWatchdogStartupHookPath {
    if (-not (Test-SharedIsWindows)) {
        return ""
    }

    return (Join-SharedPath @(
        (Get-SharedConfigHome),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "AI Memory Watchdog.vbs"
    ))
}

function Get-SharedVsCodeUserRoot {
    param([Parameter(Mandatory = $true)][string]$ProductName)

    return (Join-SharedPath @((Get-SharedConfigHome), $ProductName, "User"))
}

# ---------------------------------------------------------------------------
# Process listeners (also placed here since they are cross-cutting utilities
# used by launch scripts that may already depend on ai-roots)
# ---------------------------------------------------------------------------

function Get-SharedListeningProcessIds {
    param([Parameter(Mandatory = $true)][int]$Port)

    if ($Port -le 0) {
        return @()
    }

    if (Test-SharedIsWindows) {
        $processIds = New-Object System.Collections.Generic.List[int]
        try {
            foreach ($tcp in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)) {
                if ($tcp -and $tcp.OwningProcess) {
                    $processIds.Add([int]$tcp.OwningProcess) | Out-Null
                }
            }
        } catch {
        }

        try {
            $pattern = ":{0}\s+.*LISTENING\s+(\d+)\s*$" -f $Port
            foreach ($line in @(netstat -ano -p tcp | Select-String -Pattern $pattern)) {
                if ($line -and ([string]$line.Line -match "LISTENING\s+(\d+)\s*$")) {
                    $processIds.Add([int]$Matches[1]) | Out-Null
                }
            }
        } catch {
        }

        return @($processIds | Sort-Object -Unique)
    }

    try {
        $lsof = Get-Command lsof -ErrorAction SilentlyContinue
        if ($lsof) {
            $output = & $lsof.Source "-nP" "-iTCP:$Port" "-sTCP:LISTEN" "-t" 2>$null
            $processIds = @(
                $output |
                    ForEach-Object { [string]$_ } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    ForEach-Object { $_.Trim() } |
                    Select-Object -Unique
            )
            if ($processIds.Count -gt 0) {
                return @($processIds | ForEach-Object { [int]$_ })
            }
        }
    } catch {
    }

    return @()
}

function Get-SharedListeningProcessId {
    param([Parameter(Mandatory = $true)][int]$Port)

    $processIds = @(Get-SharedListeningProcessIds -Port $Port)
    if ($processIds.Count -gt 0) {
        return [int]$processIds[0]
    }

    return 0
}

function Get-SharedChildProcessIds {
    param([Parameter(Mandatory = $true)][int]$ParentId)

    $children = New-Object System.Collections.Generic.List[int]
    if ($ParentId -le 0 -or (Test-SharedIsWindows)) {
        return @()
    }

    try {
        $psCommand = Get-Command ps -ErrorAction SilentlyContinue
        if (-not $psCommand) {
            return @()
        }

        $lines = & $psCommand.Source "-o" "pid=" "--ppid" "$ParentId" 2>$null
        foreach ($line in @($lines)) {
            $value = [string]$line
            if ([string]::IsNullOrWhiteSpace($value)) {
                continue
            }

            $childId = 0
            if ([int]::TryParse($value.Trim(), [ref]$childId) -and $childId -gt 0) {
                $children.Add($childId) | Out-Null
                foreach ($descendant in @(Get-SharedChildProcessIds -ParentId $childId)) {
                    $children.Add([int]$descendant) | Out-Null
                }
            }
        }
    } catch {
    }

    return @($children | Select-Object -Unique)
}

function Stop-SharedProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    if ($ProcessId -le 0) {
        return
    }

    if (Test-SharedIsWindows) {
        try {
            $null = cmd.exe /d /c "taskkill /PID $ProcessId /T /F" 2>$null
        } catch {
            try {
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            } catch {
            }
        }
        return
    }

    $targets = New-Object System.Collections.Generic.List[int]
    foreach ($childId in @(Get-SharedChildProcessIds -ParentId $ProcessId)) {
        $targets.Add([int]$childId) | Out-Null
    }
    $targets.Add($ProcessId) | Out-Null

    foreach ($target in @($targets | Sort-Object -Descending -Unique)) {
        try {
            Stop-Process -Id ([int]$target) -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Get-SharedMutexName {
    param([Parameter(Mandatory = $true)][string]$BaseName)

    if (Test-SharedIsWindows) {
        return "Global\$BaseName"
    }

    return $BaseName
}
