# AI Memory Bus Watchdog Supervisor
# Usage: .\watchdog.ps1 -PidFile <path> -Callback <command>
# Example: .\watchdog.ps1 -PidFile "C:\.ai-memory\bus.pid" -Callback "node scripts/vault-detect.js"
#
# Cross-platform PowerShell watchdog for Windows.

param(
    [Parameter(Mandatory)][string]$PidFile,
    [Parameter(Mandatory)][string]$Callback,
    [int]$Interval = 15,
    [int]$MaxRestarts = 3
)

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
            Invoke-Expression $Callback
        }
    }
}
