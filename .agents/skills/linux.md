---
name: linux-agent-setup
description: Linux-specific agent setup — auto-detect environment and connect to memory bus
version: 1.0.0
agent: universal
platform: linux
---

# Linux Agent Setup

> **For any AI agent on Linux.** Clone the repo, read `AGENT_BOOT.md`, then apply Linux specifics below.

---

## Linux Environment Detection

```bash
# Platform check (must return 'linux')
node -e "console.log(require('./bus/platform/index.js').platform.name)"
# Expected: linux

# Node.js check
node --version  # must be >=18

# Python check
python3 --version  # must be >=3.9

# Linux distro detection (for package manager identification)
cat /etc/os-release | grep "^ID="  # debian, ubuntu, fedora, arch, etc.
```

---

## Linux-Specific Store Resolution

**Priority order:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` env var
2. `AI_MEMORY_ROOT/.ai-memory` (if AI_MEMORY_ROOT is set)
3. Auto-detect best available mount point
4. Platform default: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`

```bash
# Resolve store root (auto-detects if AI_MEMORY_STORE is set)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

---

## Linux Memory Store Root

**Platform default:** `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`

```bash
# Resolve (auto-detects if AI_MEMORY_STORE is set)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"

# XDG paths (verify):
echo "XDG_DATA_HOME: ${XDG_DATA_HOME:-$HOME/.local/share}"
echo "XDG_CONFIG_HOME: ${XDG_CONFIG_HOME:-$HOME/.config}"
```

---

## Linux MCP Server Startup

```bash
# Memory Bus MCP — Node.js HTTP server
node shared-mcp/omni-memory-server.js --port 9338 &

# Optional: Obsidian MCP (port 9335) — requires obsidian plugin
# obsidian://open?vault=<vault-name>
# Note: No Obsidian dependency required for core memory bus functionality

# Verify:
curl -s http://127.0.0.1:9338/health | python3 -m json.tool
```

---

## Linux Dependency Installation

**Debian/Ubuntu:**
```bash
sudo apt update && sudo apt install -y \
  nodejs npm \
  python3 python3-pip \
  python3-venv

# Optional: pwsh for Windows-compatible scripts
# https://docs.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux

# Search dependencies:
pip3 install numpy scipy scikit-learn sentence-transformers
```

**Fedora/RHEL:**
```bash
sudo dnf install -y \
  nodejs \
  python3 python3-pip

pip3 install numpy scipy scikit-learn sentence-transformers
```

**Arch Linux:**
```bash
sudo pacman -S \
  nodejs \
  python python-pip

pip3 install numpy scipy scikit-learn sentence-transformers
```

---

## Linux Watchdog

Uses `scripts/watchdog.sh` (POSIX bash):

```bash
# Start watchdog supervisor:
bash scripts/watchdog.sh /tmp/memory-bus.pid "node shared-mcp/omni-memory-server.js --port 9338"

# Or via systemd (for production):
sudo systemctl enable memory-bus
sudo systemctl start memory-bus
```

---

## Linux Permissions Notes

- Store root directory: must be writable by the agent's user
- SQLite KG: requires write access to `~/.ai-memory/kg/`
- FIFO/named pipes: supported (POSIX)
- Ports <1024: may require `sudo` on some distros — use ports >=9338 to avoid

---

## Linux Quick Bootstrap

```bash
cd /path/to/obsidian-shared-memory-bus && \
  node -e "console.log('Platform:', require('./bus/platform/index.js').platform.name)" && \
  node -e "console.log('Store:', require('./bus/store-root.js').resolveStoreRoot())" && \
  node scripts/env-check.js && \
  echo "Linux bootstrap complete"
```

---

## systemd Service (Optional)

For production deployment on Linux:

```ini
# /etc/systemd/system/memory-bus.service
[Unit]
Description=Obsidian Shared Memory Bus MCP
After=network.target

[Service]
Type=simple
User=<username>
WorkingDirectory=/path/to/obsidian-shared-memory-bus
ExecStart=/usr/bin/node shared-mcp/omni-memory-server.js --port 9338
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable memory-bus
sudo systemctl start memory-bus
```

---

## Cross-Platform Test on Linux

```bash
# Run all Linux-compatible tests:
node --test tests/unit/js/platform.test.js && \
node --test tests/unit/js/store-root-platform.test.js && \
node scripts/cross-platform-test.js

# Python tests:
python3 -m pytest tests/unit/py/test_platform.py -v
python3 -m pytest tests/unit/py/test_streaming_index.py -v
```
