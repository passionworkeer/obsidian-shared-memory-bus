# scripts/setup-hooks.ps1
# 配置 Claude Code Stop Hooks
# 用法: .\setup-hooks.ps1 [-Uninstall]

param(
    [switch]$Uninstall
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot
$HooksDir = "$env:USERPROFILE\.claude\hooks"
$HooksFile = Join-Path $HooksDir "hooks.json"
$SettingsFile = "$env:USERPROFILE\.claude\settings.json"

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  Claude Code Hooks 配置" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

if ($Uninstall) {
    Write-Step "卸载 Hooks..."
    if (Test-Path -LiteralPath $HooksFile) {
        Remove-Item -LiteralPath $HooksFile -Force
        Write-Success "已删除 hooks.json"
    } else {
        Write-Warn "hooks.json 不存在"
    }
    exit 0
}

# ========================================
# 创建 Claude Code hooks 配置
# ========================================
Write-Step "配置 Claude Code Stop Hook..."

# 确保 hooks 目录存在
if (-not (Test-Path -LiteralPath $HooksDir -PathType Container)) {
    New-Item -ItemType Directory -Path $HooksDir -Force | Out-Null
}

# Stop Hook 配置
# 会话结束时自动提取结构化记忆
$stopHookCommand = "node `"$ProjectRoot\hooks\stop-hook-llm-extract\stop-extract.mjs`""

$hooksConfig = @{
    description = "AI Memory Bus Stop Hooks"
    hooks = @{
        Stop = @(
            @{
                hooks = @(
                    @{
                        type = "command"
                        command = $stopHookCommand
                        description = "AI Memory Bus: 提取会话记忆到 .ai-memory"
                        timeout = 30
                    }
                )
            }
        )
    }
} | ConvertTo-Json -Depth 10

# 写入 hooks.json
Set-Content -Path $HooksFile -Value $hooksConfig -Encoding utf8
Write-Success "已创建 $HooksFile"

# ========================================
# 配置 MCP 服务器到 Claude Code
# ========================================
Write-Step "配置 Claude Code MCP 服务器..."

# 读取现有 settings.json 或创建新的
$settings = @{}
if (Test-Path -LiteralPath $SettingsFile) {
    try {
        $settings = Get-Content -Raw -Path $SettingsFile -Encoding utf8 | ConvertFrom-Json
    } catch {
        Write-Warn "无法读取现有 settings.json，将创建新的"
    }
}

# 添加 MCP 服务器配置
$settings | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([ordered]@{
    context7 = @{ type = "http"; url = "http://127.0.0.1:9331/mcp" }
    fetch = @{ type = "http"; url = "http://127.0.0.1:9332/mcp" }
    time = @{ type = "http"; url = "http://127.0.0.1:9333/mcp" }
    sequential-thinking = @{ type = "http"; url = "http://127.0.0.1:9334/mcp" }
    obsidian = @{ type = "http"; url = "http://127.0.0.1:9335/mcp" }
    memory = @{ type = "http"; url = "http://127.0.0.1:9338/mcp" }
}) -ErrorAction SilentlyContinue

# 保存 settings.json
$newSettings = $settings | ConvertTo-Json -Depth 10
Set-Content -Path $SettingsFile -Value $newSettings -Encoding utf8
Write-Success "已更新 $SettingsFile"

# ========================================
# 完成
# ========================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  Hooks 配置完成！" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

Write-Host "`n现在 Claude Code 将:" -ForegroundColor White
Write-Host "  1. 启动时调用 memory_boot 获取 L0/L1 记忆"
Write-Host "  2. 结束时自动提取会话记忆到 .ai-memory"
Write-Host ""
Write-Host "重启 Claude Code 使配置生效。" -ForegroundColor Yellow
