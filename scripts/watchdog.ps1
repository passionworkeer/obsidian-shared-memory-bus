# AI Memory Bus Watchdog Supervisor
# Usage: .\watchdog.ps1 -PidFile <path> -CallbackExe <exe> -CallbackArgs <string[]>
# Example: .\watchdog.ps1 -PidFile "$env:AI_MEMORY_STORE\bus.pid" -CallbackExe "node" -CallbackArgs @("scripts/vault-detect.js")
#
# Cross-platform PowerShell watchdog for Windows.
#
# Security (S-HIGH-1): -Callback 改为 -CallbackExe + -CallbackArgs,
# 运行时 & \$CallbackExe @CallbackArgs,避免 Invoke-Expression 等价 eval。
# 当前唯一调用方是 package.json:26 的静态 "node scripts/vault-detect.js"。

param(
    [Parameter(Mandatory)][string]$PidFile,
    [Parameter(Mandatory)][string]$CallbackExe,
    [string[]]$CallbackArgs = @(),
    [int]$Interval = 15,
    [int]$MaxRestarts = 3
)

# Guard against busy-loop: $Interval=0 (or non-int coerced to 0) would make
# Start-Sleep -Seconds 0 spin, pinning a CPU core. Clamp to a sane floor.
if ($Interval -lt 5) { $Interval = 15 }
if ($MaxRestarts -lt 1) { $MaxRestarts = 3 }

$restartCount = 0

function Get-CdpRunning([string]$pid) {
    if ($pid -match '^\d+$') {
        try {
            $proc = Get-Process -Id $pid -ErrorAction Stop
            return $true
        } catch {
            return $false
        }
    }
    return $false
}

while ($true) {
    Start-Sleep -Seconds $Interval

    if (Test-Path $PidFile) {
        $pid = (Get-Content $PidFile | Select-Object -First 1).Trim()
        if (-not (Get-CdpRunning $pid)) {
            Write-Host "[watchdog] Process $pid died, restart $($restartCount+1)/$MaxRestarts" -ForegroundColor Yellow
            $restartCount++
            if ($restartCount -gt $MaxRestarts) {
                Write-Host "[watchdog] Max restarts reached" -ForegroundColor Red
                exit 1
            }
            & $CallbackExe @CallbackArgs
        }
    }
}
