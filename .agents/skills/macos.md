---
name: macos-agent-setup
description: macOS-specific agent setup — auto-detect environment and connect to memory bus
version: 1.0.0
agent: universal
platform: darwin
---

# macOS Agent Setup

> **For any AI agent on macOS.** Clone the repo, read `AGENT_BOOT.md`, then apply macOS specifics below.

---

## macOS Environment Detection

```bash
# Platform check (must return 'darwin')
node -e "console.log(require('./bus/platform/index.js').platform.name)"
# Expected: darwin

# Node.js check
node --version  # must be >=18

# Python check  
python3 --version  # must be >=3.9

# Homebrew check (for dependency installation)
which brew && brew --version
```

---

## macOS-Specific Store Resolution

**Priority order:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` env var
2. `AI_MEMORY_ROOT/.ai-memory` (if AI_MEMORY_ROOT is set)
3. Auto-detect best available volume
4. Platform default: `~/Library/Application Support/.ai-memory`

```bash
# Resolve store root (auto-detects if AI_MEMORY_STORE is set)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

---

## macOS Memory Store Root

**Platform default:** `~/Library/Application Support/.ai-memory`

```bash
# Resolve (auto-detects if AI_MEMORY_STORE is set)
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
```

---

## macOS MCP Server Startup

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

## macOS Dependency Installation

```bash
# Install Node.js if needed (via homebrew):
brew install node@20

# Install Python if needed:
brew install python@3.11

# Install search dependencies:
pip3 install numpy scipy scikit-learn sentence-transformers

# Optional: pwsh for Windows-compatible PowerShell scripts:
brew install --cask powershell
```

---

## macOS Watchdog

Uses `scripts/watchdog.sh` (POSIX bash):

```bash
# Start watchdog supervisor:
bash scripts/watchdog.sh /tmp/memory-bus.pid "node shared-mcp/omni-memory-server.js --port 9338"
```

---

## macOS Path Configuration

Typical `$HOME` values on macOS:
- `HOME=/Users/<username>`
- `PATH` includes `/usr/local/bin:/opt/homebrew/bin` (M1/M2 Macs)

**Store root auto-resolution checks in order:**
1. `AI_MEMORY_STORE` / `AI_MEMORY_STORE_ROOT` env var
2. `XDG_DATA_HOME/.ai-memory` if `XDG_DATA_HOME` is set
3. `~/Library/Application Support/.ai-memory`

---

## macOS Firewall / Permissions

If MCP servers fail to bind to ports:
```bash
# Check if ports are available:
lsof -i :9338
lsof -i :9335

# Kill existing processes if needed:
kill $(lsof -t -i :9338)
```

---

## macOS Quick Bootstrap

```bash
cd /path/to/obsidian-shared-memory-bus && \
  node -e "console.log('Platform:', require('./bus/platform/index.js').platform.name)" && \
  node -e "console.log('Store:', require('./bus/store-root.js').resolveStoreRoot())" && \
  node scripts/env-check.js && \
  echo "macOS bootstrap complete"
```

---

## Agent-Specific Notes

### Claude Code on macOS
- MCP config: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-code/settings蹬?
- Or: `~/.claude/settings.json`
- Skill file: `.agents/skills/claude-code.md`

### GitHub Copilot on macOS
- Config: `~/Library/Application Support/Copilot/index/`
- Skill file: `.agents/skills/copilot.md`

### Cursor on macOS
- Config: `~/Library/Application Support/Cursor/User/globalStorage/`
- Skill file: `.agents/skills/cursor.md`

---

## Cross-Platform Test on macOS

```bash
# Run all macOS-compatible tests:
node --test tests/unit/js/platform.test.js && \
node --test tests/unit/js/store-root-platform.test.js && \
node scripts/cross-platform-test.js

# Python tests:
python3 -m pytest tests/unit/py/test_platform.py -v
python3 -m pytest tests/unit/py/test_streaming_index.py -v
```
