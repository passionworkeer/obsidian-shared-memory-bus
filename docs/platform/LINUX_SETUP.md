---
title: Linux Setup Guide
description: Detailed installation and configuration guide for Linux, covering PowerShell Core, Python, Node.js, and shared MCP setup.
platform: linux
---

# Linux Setup Guide / Linux 安装配置指南

> English: Step-by-step guide for installing and running the shared memory bus on Linux (including WSL2, systemd, and headless environments).
> 中文：一步步指南，教你在 Linux（包括 WSL2、systemd 和无头环境）上安装和运行共享内存总线。

---

## Supported Distributions / 支持的发行版

| Distribution | Status | Notes |
|-------------|--------|-------|
| Ubuntu 20.04+ | Supported | Full validation in CI |
| Debian 11+ | Supported | |
| Fedora 36+ | Supported | |
| Arch Linux | Supported | |
| WSL2 (Ubuntu) | Supported | Treat as native Linux |
| openSUSE | Supported | |
| Other .deb/.rpm distros | Portable | May need minor tweaks |

---

## Prerequisites / 前提条件

### Required Software / 必需软件

| Software | Version | Install | Verify |
|----------|---------|--------|--------|
| Node.js | 18+ | See below | `node -v` |
| Python | 3.10+ | See below | `python3 --version` |
| PowerShell | 7+ | See below | `pwsh --version` |
| unzip / curl | system | `apt install unzip curl` (Debian) | `which unzip curl` |

### Install Node.js / 安装 Node.js

**Option A — NodeSource (recommended for Ubuntu/Debian):**

```bash
# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node -v   # Should print v20.x.x
npm -v
```

**Option B — nvm (supports multiple versions):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
nvm install 20
nvm use 20
node -v
```

**Option C — Distribution package (may be outdated):**

```bash
# Debian/Ubuntu
sudo apt install nodejs npm

# Fedora
sudo dnf install nodejs npm

# Arch
sudo pacman -S nodejs npm
```

### Install Python / 安装 Python

```bash
# Debian/Ubuntu
sudo apt install python3 python3-pip python3-venv

# Fedora
sudo dnf install python3 python3-pip

# Arch
sudo pacman -S python python-pip
```

**Option — uv (faster, recommended):**

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.cargo/env   # uv installs to ~/.cargo/bin

# Create a Python environment
uv python install 3.11
uv python pin 3.11

# Verify
uv python list
python3 --version
```

### Install PowerShell / 安装 PowerShell

**Ubuntu/Debian (Microsoft repo):**

```bash
# Download and install the Microsoft repository package
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | \
    sudo gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg

echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] \
    https://packages.microsoft.com/repos/microsoft-ubuntu-$(lsb_release -cs)-prod $(lsb_release -cs) main" | \
    sudo tee /etc/apt/sources.list.d/microsoft.list

sudo apt update
sudo apt install -y powershell

# Verify
pwsh --version
```

**Fedora:**

```bash
sudo dnf install https://packages.microsoft.com/config/fedora/$(rpm -E %fedora)/packages-microsoft-prod.rpm
sudo dnf check-update
sudo dnf install powershell
```

**Arch Linux (AUR):**

```bash
# Using yay or paru
yay -S powershell-bin
```

**Verify PowerShell:**

```bash
pwsh --version
# Should print: PowerShell 7.x.y
```

### Verify All Prerequisites / 验证所有前提条件

```bash
node -v      # 18+
python3 --version  # 3.10+
pwsh --version    # 7+
```

---

## Installation / 安装

### Step 1 — Get the Repository / 第一步 — 获取仓库

```bash
git clone https://github.com/your-org/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus
```

### Step 2 — Run the Installer / 第二步 — 运行安装程序

```bash
chmod +x ./scripts/install.sh
./scripts/install.sh -WorkspaceRoot "$(pwd)"
```

The installer will:
1. Copy the runtime to `~/.ai-memory`
2. Detect a usable Python 3.10+ interpreter (system Python or uv-managed)
3. Install `rank-bm25` and `jieba` into the detected interpreter
4. Generate POSIX `sh` wrappers for all runtime commands
5. Generate `activate-ai-memory.sh` and `activate-ai-memory.ps1`
6. Register startup — prefers `systemd --user`, falls back to XDG autostart
7. Apply supported client integrations to the workspace
8. Start the watchdog and shared MCP stack for the current session

### Step 3 — Activate Environment in Shell / 第三步 — 在 Shell 中激活环境

```bash
source ~/.ai-memory/activate-ai-memory.sh
```

Add to your shell profile for persistence:

```bash
# ~/.bashrc or ~/.zshrc
if [ -f ~/.ai-memory/activate-ai-memory.sh ]; then
    source ~/.ai-memory/activate-ai-memory.sh
fi
```

### Step 4 — Verify / 第四步 — 验证

```bash
# Read-only health check
~/.ai-memory/shared-mcp/status-shared-mcp.sh

# JSON output for scripting
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json
```

Expected: All shared MCP services show `running: true` or `skipped: ...`.

---

## Configuration / 配置

### Store Root / 存储根目录

The store root defaults to `~/.ai-memory`. Override with:

```bash
# ~/.bashrc
export AI_MEMORY_STORE="$HOME/path/to/custom/store"
```

If the store is on a Windows partition mounted in WSL2, use the WSL path:

```bash
# WSL2 example — mount Windows E: drive at /mnt/e
export AI_MEMORY_STORE="/mnt/e/.ai-memory"
```

### Store Root on Large Drive / 将存储根目录放在大硬盘上

If your home directory is on a small SSD, store data on a larger drive:

```bash
# ~/.bashrc
export AI_MEMORY_STORE="/mnt/data/.ai-memory"
```

### Remote Embeddings / 远程 Embedding

```bash
# ~/.bashrc
export AI_MEMORY_EMBED_PROVIDER="openai-compatible-remote"
export AI_MEMORY_EMBED_ADAPTER="openai-compatible"
export AI_MEMORY_EMBED_BASE_URL="https://your-endpoint/v1"
export AI_MEMORY_EMBED_API_KEY="<your-key>"
export AI_MEMORY_EMBED_MODEL="<your-model-id>"
export AI_MEMORY_EMBED_PROFILE="openai-compatible"
```

Rebuild the index after configuring:

```bash
node ~/.ai-memory/generate-embeddings.js
```

---

## Startup Registration / 启动注册

### systemd (Recommended) / systemd（推荐）

If `systemctl --user` is available, the installer creates `systemd --user` units:

```bash
# Check if systemd is available
systemctl --user status
```

```bash
# Enable and start on boot
systemctl --user enable com.ai-memory.watchdog.service
systemctl --user start com.ai-memory.watchdog.service

# Check status
systemctl --user status com.ai-memory.watchdog.service
```

### XDG Autostart (Fallback) / XDG 自动启动（备选）

If systemd is not available, the installer creates `.desktop` files in `~/.config/autostart/`:

```bash
ls ~/.config/autostart/ | grep ai-memory
```

### Manual Start on Boot / 手动配置开机启动

If neither systemd nor XDG autostart is available, add to your shell profile or `cron @reboot`:

```bash
# ~/.bash_profile
if [ -f ~/.ai-memory/activate-ai-memory.sh ]; then
    source ~/.ai-memory/activate-ai-memory.sh
    nohup ~/.ai-memory/bus/memory-watchdog-supervisor.sh -Daemon > /dev/null 2>&1 &
fi
```

---

## Headless / SSH Environment / 无头 / SSH 环境

The shared memory bus runs fully in headless mode. For SSH-based workflows:

```bash
# SSH into the machine
ssh user@linux-host

# Activate the environment
source ~/.ai-memory/activate-ai-memory.sh

# Check status
~/.ai-memory/shared-mcp/status-shared-mcp.sh

# Run validation
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <repo> -RunCliChecks -RunRuntimeChecks
```

**Note**: The watchdog supervisor must be started in a persistent session or as a background daemon. Starting it in a non-persistent SSH session without `nohup` or `screen` will terminate it when the SSH session closes.

---

## Common Tasks / 常用任务

### Start / Stop / Restart / 启动 / 停止 / 重启

```bash
# Start
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh

# Stop
~/.ai-memory/shared-mcp/stop-shared-mcp.sh

# Force restart
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh -ForceRestart
```

### Check Status / 检查状态

```bash
~/.ai-memory/shared-mcp/status-shared-mcp.sh
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json  # machine-readable
```

### Rebuild Memory / 重建内存

```bash
node ~/.ai-memory/ops/build-memory-layers.js
node ~/.ai-memory/ops/build-handoff-pack.js
~/.ai-memory/ops/run-memory-dream.sh -Force
```

### Run Validation / 运行验证

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot <repo> -RunCliChecks -RunRuntimeChecks
```

### Run Pressure Test / 运行压力测试

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot <repo> -Waves 5 -RunCliChecks -RunToolCalls -RunClientTaskChecks
```

---

## Troubleshooting / 故障排查

### `pwsh` Not Found / pwsh 未找到

**Symptom**: `pwsh: command not found` in `.sh` wrappers.

**Fix**:

1. Verify PowerShell is installed:
   ```bash
   which pwsh
   /usr/bin/pwsh
   ```

2. If not installed, install from the [Microsoft install guide](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux).

3. If installed but not on PATH, set `AI_MEMORY_PWSH` explicitly:
   ```bash
   export AI_MEMORY_PWSH="/usr/bin/pwsh"
   ```

### Python Not Found / Python 未找到

**Symptom**: `search_shared_memory` returns `spawn python3 ENOENT`.

**Fix**:

1. Verify Python 3.10+ is installed:
   ```bash
   python3 --version
   ```

2. If using uv-managed Python, ensure the uv Python is accessible:
   ```bash
   export AI_MEMORY_PYTHON="$HOME/.local/share/uv/python/.../bin/python3"
   ```

3. Re-run installer:
   ```bash
   ./scripts/install.sh
   ```

### `rank-bm25` / `jieba` Missing / rank-bm25 / jieba 缺失

**Symptom**: BM25 scores are weak or Chinese text search returns no results.

**Fix**:

```bash
# Install into the active Python interpreter
python3 -m pip install rank-bm25 jieba

# Or with uv
uv pip install rank-bm25 jieba --system
```

### Port Already In Use / 端口已被占用

**Symptom**: `EADDRINUSE` on ports 9331–9338.

**Fix**:

```bash
# Find what's using the port
sudo ss -tlnp | grep -E '9331|9332|9333|9334|9335|9336|9337|9338'
# or
lsof -i :9338

# Kill the process
sudo kill <PID>

# Restart
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh
```

### systemd --user Not Working / systemd --user 不工作

**Symptom**: Services do not start on boot, but work manually.

**Fix**:

1. Check if `systemd --user` is available:
   ```bash
   systemctl --user status
   ```

2. If it fails with `Failed to connect to bus`, enable lingering:
   ```bash
   loginctl enable-linger $USER
   ```

3. Then reload and restart:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now com.ai-memory.watchdog.service
   ```

### WSL2 Specific Issues / WSL2 特定问题

**Symptom**: Shared MCP works in WSL2 but stops after closing the terminal.

**Cause**: Background processes in WSL2 are killed when the last WSL2 process exits by default.

**Fix**:

1. Enable `systemd` in WSL2:
   ```bash
   # Add to /etc/wsl.conf
   echo -e "[boot]\nsystemd=true" | sudo tee -a /etc/wsl.conf
   ```

2. Restart WSL2:
   ```powershell
   wsl --shutdown
   # Then reopen the WSL2 terminal
   ```

3. Use `systemd` for startup registration as described above.

### Permission Denied on Scripts / 脚本权限被拒绝

**Symptom**: `Permission denied: ./scripts/install.sh`

**Fix**:

```bash
chmod +x ./scripts/install.sh
chmod +x ~/.ai-memory/shared-mcp/*.sh
```

---

## Package Manager Quick Reference / 包管理器速查

### Ubuntu / Debian

```bash
# Essential build tools
sudo apt install build-essential curl unzip git

# Node.js (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs

# Python
sudo apt install python3 python3-pip python3-venv

# PowerShell
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | sudo gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/repos/microsoft-ubuntu-$(lsb_release -cs)-prod $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/microsoft.list
sudo apt update && sudo apt install powershell
```

### Fedora

```bash
sudo dnf install curl unzip git
curl -fsSL https://packages.microsoft.com/config/fedora/$(rpm -E %fedora)/packages-microsoft-prod.rpm | sudo rpm --import -
sudo dnf install powershell
```

### Arch

```bash
sudo pacman -S curl unzip git nodejs npm python python-pip
# PowerShell from AUR:
yay -S powershell-bin
```
