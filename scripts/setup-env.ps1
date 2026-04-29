# scripts/setup-env.ps1
# 设置环境变量并创建配置文件
# 用法: .\setup-env.ps1

param(
    [string]$ObsidianVault = "",
    [string]$AiMemoryRoot = "",
    [switch]$Permanent
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  环境变量配置" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

# ========================================
# 1. 检测 Obsidian Vault
# ========================================
Write-Step "检测 Obsidian Vault..."

# 自动检测 Obsidian 配置
$obsidianConfigPaths = @(
    "$env:APPDATA\obsidian\obsidian.json",
    "$env:LOCALAPPDATA\Obsidian\obsidian.json",
    "$HOME/Library/Application Support/obsidian/obsidian.json"
)

$detectedVault = ""
foreach ($configPath in $obsidianConfigPaths) {
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -Raw -Path $configPath -Encoding utf8 | ConvertFrom-Json
            if ($config.vaultPath) {
                $detectedVault = $config.vaultPath
                break
            }
        } catch {}
    }
}

# 如果用户没有指定，使用检测到的
if ([string]::IsNullOrWhiteSpace($ObsidianVault)) {
    if (-not [string]::IsNullOrWhiteSpace($detectedVault)) {
        Write-Host "  检测到 Vault: $detectedVault"
        $ObsidianVault = $detectedVault
    } else {
        # 默认值
        $ObsidianVault = "$env:USERPROFILE\Documents\Obsidian Vault"
    }
}

# 验证 Vault 路径
if (-not (Test-Path -LiteralPath $ObsidianVault -PathType Container)) {
    Write-Fail "Obsidian Vault 不存在: $ObsidianVault"
    Write-Host "请手动指定: .\setup-env.ps1 -ObsidianVault '你的Vault路径'"
    exit 1
}
Write-Success "Vault 路径: $ObsidianVault"

# ========================================
# 2. 设置 AI_MEMORY_ROOT
# ========================================
Write-Step "设置 AI_MEMORY_ROOT..."

if ([string]::IsNullOrWhiteSpace($AiMemoryRoot)) {
    # 默认使用项目目录
    $AiMemoryRoot = $ProjectRoot
}

if ($Permanent) {
    [Environment]::SetEnvironmentVariable("AI_MEMORY_ROOT", $AiMemoryRoot, "User")
    [Environment]::SetEnvironmentVariable("OBSIDIAN_VAULT_ROOT", $ObsidianVault, "User")
    Write-Success "已永久设置环境变量"
} else {
    $env:AI_MEMORY_ROOT = $AiMemoryRoot
    $env:OBSIDIAN_VAULT_ROOT = $ObsidianVault
    Write-Success "已设置会话环境变量 (仅当前会话)"
}

Write-Host "  AI_MEMORY_ROOT: $AiMemoryRoot"
Write-Host "  OBSIDIAN_VAULT_ROOT: $ObsidianVault"

# ========================================
# 3. 创建 .env 文件（便于参考）
# ========================================
Write-Step "创建 .env.example 文件..."

$envFile = @"
# AI Memory Bus 环境变量配置
# 复制此文件为 .env 并根据需要修改

# 记忆存储根目录
AI_MEMORY_ROOT=$AiMemoryRoot

# Obsidian Vault 路径
OBSIDIAN_VAULT_ROOT=$ObsidianVault

# MCP 服务基础端口（默认 9330）
# AI_MEMORY_BASE_PORT=9330

# 是否启用 Watchdog（1=启用，0=禁用）
# AI_MEMORY_WATCHDOG_ENABLED=1

# 嵌入模型（默认 hash）
# AI_MEMORY_EMBED_MODEL=hashing-v1

# MiniMax API（可选）
# MINIMAX_API_KEY=your_api_key
# MINIMAX_API_HOST=https://api.minimax.chat

# Anthropic 代理（如果使用本地代理）
# ANTHROPIC_BASE_URL=http://127.0.0.1:15721
"@

$envExamplePath = Join-Path $ProjectRoot ".env.example"
Set-Content -Path $envExamplePath -Value $envFile -Encoding utf8
Write-Success "已创建 $envExamplePath"

# ========================================
# 4. 创建 .ai-memory 目录结构
# ========================================
Write-Step "初始化记忆目录..."

$memoryRoot = if ($env:AI_MEMORY_ROOT) { $env:AI_MEMORY_ROOT } else { $AiMemoryRoot }
$aiMemoryDir = Join-Path $memoryRoot ".ai-memory"

$dirs = @(
    "inbox",
    "generated",
    "structured",
    "imported",
    "events",
    "projects"
)

foreach ($dir in $dirs) {
    $dirPath = Join-Path $aiMemoryDir $dir
    if (-not (Test-Path -LiteralPath $dirPath -PathType Container)) {
        New-Item -ItemType Directory -Path $dirPath -Force | Out-Null
        Write-Host "  创建: $dirPath"
    }
}

Write-Success "记忆目录初始化完成: $aiMemoryDir"

# ========================================
# 完成
# ========================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  环境配置完成！" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

Write-Host "`n下一步:" -ForegroundColor White
Write-Host "  1. 启动服务: .\scripts\start-all.ps1"
Write-Host "  2. 配置 hooks: .\scripts\setup-hooks.ps1"
Write-Host ""
Write-Host "注意: 如果需要永久环境变量，运行:" -ForegroundColor Yellow
Write-Host "  .\scripts\setup-env.ps1 -Permanent" -ForegroundColor Yellow
