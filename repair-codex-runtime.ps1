param(
    [string]$CodexRoot = "$env:USERPROFILE\.codex",
    [switch]$Watch,
    [int]$TimeoutMinutes = 720,
    [int]$PollSeconds = 15,
    [string]$ResultPath = ""
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ResultPath)) {
    $ResultPath = Join-Path $CodexRoot "repair-codex-runtime.last.json"
}

function Get-CodexProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -eq "Codex" -or $_.ProcessName -eq "codex"
    })
}

function Move-IfExists {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Suffix
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    $target = "{0}.{1}" -f $Path, $Suffix
    Move-Item -LiteralPath $Path -Destination $target -Force
    return $target
}

function Repair-CodexRuntime {
    param([Parameter(Mandatory = $true)][string]$Root)

    $stamp = "broken-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
    $moved = New-Object System.Collections.Generic.List[string]

    foreach ($name in @("logs_1.sqlite", "logs_1.sqlite-shm", "logs_1.sqlite-wal")) {
        $movedPath = Move-IfExists -Path (Join-Path $Root $name) -Suffix $stamp
        if ($movedPath) {
            $moved.Add($movedPath) | Out-Null
        }
    }

    [pscustomobject]@{
        repairedAt = (Get-Date).ToString("o")
        moved = @($moved)
    }
}

function Write-Result {
    param([Parameter(Mandatory = $true)]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $Watch) {
    if ((Get-CodexProcesses).Count -gt 0) {
        throw "Codex is still running. Re-run with -Watch or close Codex first."
    }
    $result = Repair-CodexRuntime -Root $CodexRoot
    Write-Result -Payload $result
    $result | ConvertTo-Json -Depth 4
    exit 0
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
    if ((Get-CodexProcesses).Count -eq 0) {
        $result = Repair-CodexRuntime -Root $CodexRoot
        Write-Result -Payload $result
        $result | ConvertTo-Json -Depth 4
        exit 0
    }
    Start-Sleep -Seconds $PollSeconds
}

$timeoutResult = [pscustomobject]@{
    failedAt = (Get-Date).ToString("o")
    error = ("Timed out waiting for Codex to exit after {0} minutes." -f $TimeoutMinutes)
}
Write-Result -Payload $timeoutResult
throw $timeoutResult.error
