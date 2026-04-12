---
title: macOS Setup Guide
description: Detailed installation and configuration guide for macOS, covering Homebrew, PowerShell, Python, and shared MCP setup.
platform: macos
---

# macOS Setup Guide / macOS 安装配置指南

> English: Step-by-step guide for installing and running the shared memory bus on macOS.
> 中文：一步步指南，教你在 macOS 上安装和运行共享内存总线。

---

## Prerequisites / 前提条件

### Required Software / 必需软件

| Software | Version | Install command | Verify |
|----------|---------|----------------|--------|
| Homebrew | latest | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` | `brew --version` |
| Node.js | 18+ | `brew install node` | `node -v` |
| Python | 3.10+ | `brew install python@3.11` | `python3 --version` |
| PowerShell | 7+ | `brew install powershell` | `pwsh --version` |

### Verify All Prerequisites / 验证所有前提条件

```bash
brew --version
node -v
python3 --version
pwsh --version
```

All four commands should print version numbers without errors.

### Ports / 端口

Ensure ports **9331–9338** are available:

```bash
# Check if any of the shared MCP ports are in use
lsof -i :9331 -i :9332 -i :9333 -i :9334 -i :9335 -i :9336 -i :9337 -i :9338
```

If ports are in use, stop the conflicting process before installing.

---

## Installation / 安装

### Step 1 — Clone or Download the Repository / 第一步 — 克隆或下载仓库

```bash
# If using git:
git clone https://github.com/your-org/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus

# Or download and extract the release archive
```

### Step 2 — Run the Installer / 第二步 — 运行安装程序

```bash
# Full install with client integrations
./scripts/install.sh -WorkspaceRoot "$(pwd)"

# The installer will:
#   1. Copy runtime to ~/.ai-memory
#   2. Detect Python 3.10+ runtime
#   3. Install rank-bm25 and jieba
#   4. Generate activation scripts and .sh wrappers
#   5. Register startup via LaunchAgent
#   6. Apply supported client integrations
#   7. Start watchdog and shared MCP stack
```

Expected output:
```
[install] ai-memory runtime installed to ~/.ai-memory
[install] Python 3.11.5 detected at /usr/local/bin/python3
[install] rank-bm25 and jieba installed
[install] ~/.ai-memory/activate-ai-memory.sh generated
[install] LaunchAgent registered at ~/Library/LaunchAgents/com.ai-memory.watchdog.plist
[install] shared MCP stack started on ports 9331-9338
```

### Step 3 — Activate Environment in Shell / 第三步 — 在 Shell 中激活环境

After install, activate the environment in your current shell:

```bash
source ~/.ai-memory/activate-ai-memory.sh
```

This sets `AI_MEMORY_ROOT`, `AI_MEMORY_PYTHON`, and `AI_MEMORY_PWSH` for the current session. Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) for persistence:

```bash
# ~/.zshrc (or ~/.bashrc)
if [ -f ~/.ai-memory/activate-ai-memory.sh ]; then
    source ~/.ai-memory/activate-ai-memory.sh
fi
```

### Step 4 — Verify the Installation / 第四步 — 验证安装

```bash
# Read-only health check (no side effects)
~/.ai-memory/shared-mcp/status-shared-mcp.sh

# JSON output for automation
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json
```

Expected: All shared MCP services show `running: true` or `skipped: ...`.

---

## Configuration / 配置

### Set Vault Path / 设置保险库路径

If your Obsidian vault is not in a standard location, set the environment variable:

```bash
# In your shell profile (~/.zshrc)
export AI_MEMORY_OBSIDIAN_VAULT="$HOME/path/to/your/vault"
```

Reload the profile:
```bash
source ~/.zshrc
```

### Use Remote Embeddings (Optional) / 使用远程 Embedding（可选）

For higher quality dense retrieval, configure a remote embedding provider:

```bash
# ~/.zshrc
export AI_MEMORY_EMBED_PROVIDER="openai-compatible-remote"
export AI_MEMORY_EMBED_ADAPTER="openai-compatible"
export AI_MEMORY_EMBED_BASE_URL="https://your-endpoint/v1"
export AI_MEMORY_EMBED_API_KEY="<your-api-key>"
export AI_MEMORY_EMBED_MODEL="<your-model-id>"
export AI_MEMORY_EMBED_PROFILE="openai-compatible"
```

After setting, rebuild the embeddings index:

```bash
node ~/.ai-memory/generate-embeddings.js
```

### Configure MiniMax MCP (Optional) / 配置 MiniMax MCP（可选）

```bash
# ~/.zshrc
export MINIMAX_API_HOST="https://api.minimax.chat"
export MINIMAX_API_KEY="<your-key>"
```

---

## Common Tasks / 常用任务

### Start the Shared MCP Stack / 启动共享 MCP 栈

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

### Stop the Shared MCP Stack / 停止共享 MCP 栈

```bash
~/.ai-memory/shared-mcp/stop-shared-mcp.sh
```

### Restart Everything / 重启所有服务

```bash
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

### Rebuild Memory Layers / 重建内存层

```bash
node ~/.ai-memory/ops/build-memory-layers.js
node ~/.ai-memory/ops/build-handoff-pack.js
pwsh "$HOME/.ai-memory/ops/run-memory-dream.ps1" -Force
```

### Check Shared MCP Status / 检查共享 MCP 状态

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

### Run Validation / 运行验证

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <repo-root> -RunCliChecks -RunRuntimeChecks
```

### Run Pressure Test / 运行压力测试

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <repo-root> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

---

## Startup Registration / 启动注册

The installer registers a LaunchAgent so the shared memory bus starts automatically on login.

### Check LaunchAgent Status / 检查 LaunchAgent 状态

```bash
# List all ai-memory related agents
ls -la ~/Library/LaunchAgents/ | grep ai-memory

# Check if loaded
launchctl list | grep ai-memory
```

### Manual Registration / 手动注册

```bash
# If registration was skipped, rerun the installer
./scripts/install.sh -WorkspaceRoot "$(pwd)"
```

### Unregister / 取消注册

```bash
launchctl unload ~/Library/LaunchAgents/com.ai-memory.watchdog.plist
launchctl unload ~/Library/LaunchAgents/com.ai-memory.shared-mcp.plist
```

Or run the uninstaller:
```bash
./scripts/uninstall.sh
```

---

## Troubleshooting / 故障排查

### `pwsh` Not Found / pwsh 未找到

**Symptom**: `~/.ai-memory/shared-mcp/status-shared-mcp.sh: line 1: pwsh: command not found`

**Fix**:

1. Install PowerShell:
   ```bash
   brew install powershell
   ```

2. Verify:
   ```bash
   pwsh --version
   ```

3. Set the path explicitly if needed:
   ```bash
   export AI_MEMORY_PWSH="/usr/local/bin/pwsh"
   ~/.ai-memory/shared-mcp/status-shared-mcp.sh
   ```

### Python Not Found / Python 未找到

**Symptom**: `search_shared_memory` returns `spawn python3 ENOENT`

**Fix**:

1. Verify Python 3.10+ is installed:
   ```bash
   python3 --version
   ```

2. If missing, install:
   ```bash
   brew install python@3.11
   ```

3. Re-run installer to detect the interpreter:
   ```bash
   ./scripts/install.sh
   ```

4. Or set explicitly:
   ```bash
   export AI_MEMORY_PYTHON="/usr/local/bin/python3"
   ```

### `rank-bm25` or `jieba` Not Installed / rank-bm25 或 jieba 未安装

**Symptom**: `search_shared_memory` works but `bm25Available: false` or Chinese recall feels weak.

**Fix**:

```bash
# Install into the detected Python interpreter
python3 -m pip install rank-bm25 jieba

# Or use uv
uv pip install rank-bm25 jieba --system
```

### Port Already In Use / 端口已被占用

**Symptom**: `EADDRINUSE` when starting shared MCP

**Fix**:

```bash
# Find what's using the port
lsof -i :9338

# Kill the conflicting process
kill <PID>

# Then restart
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

### LaunchAgent Not Starting / LaunchAgent 未启动

**Symptom**: Shared MCP services not running after reboot.

**Fix**:

```bash
# Load the LaunchAgent manually
launchctl load ~/Library/LaunchAgents/com.ai-memory.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.ai-memory.shared-mcp.plist

# Check status
launchctl list | grep ai-memory
```

### macOS Gatekeeper Blocking Scripts / macOS Gatekeeper 阻止脚本

**Symptom**: `cannot be opened because the developer cannot be verified` error.

**Fix**:

```bash
# Allow a specific script (least privilege)
xattr -dr com.apple.quarantine ~/.ai-memory/shared-mcp/start-default-shared-mcp.sh

# Or allow all scripts from this app
xattr -dr com.apple.quarantine ~/.ai-memory/
```

---

## Homebrew Formula Reference / Homebrew 公式参考

| Formula | Purpose | Install |
|---------|---------|---------|
| `node` | Node.js runtime | `brew install node` |
| `python@3.11` | Python 3.11 | `brew install python@3.11` |
| `powershell` | PowerShell 7+ | `brew install powershell` |

To keep Homebrew up to date:
```bash
brew update && brew upgrade
```
