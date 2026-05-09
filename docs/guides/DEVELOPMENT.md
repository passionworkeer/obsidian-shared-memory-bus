---
title: Development Guide
description: How to set up a local development environment, run tests, and follow the project's code style.
platform: cross-platform
---

# Development Guide / 开发指南

> English: Everything you need to know to develop, test, and contribute to this project.
> 中文：开发、测试和贡献本项目所需了解的一切。

---

## Project Structure / 项目结构

```
local-ai-memory-bus/
├── bus/                        # Core bus runtime (PowerShell orchestration)
│   ├── memory-bus.ps1          # Memory write/filter/distribute engine
│   ├── memory-watchdog.ps1      # Background sync watchdog (daemon)
│   ├── memory-watchdog-supervisor.ps1  # Auto-restart supervisor
│   ├── register-agent.ps1       # Agent registration hook
│   ├── generate-embeddings.js  # Embeddings index builder (Node.js)
│   ├── platform/               # Cross-platform abstraction
│   │   ├── index.js            # Platform detection (win32 / darwin / linux)
│   │   ├── windows.js          # Windows adapter
│   │   ├── darwin.js           # macOS adapter
│   │   └── linux.js            # Linux adapter
│   ├── embedding-provider-registry.js  # Embedding provider config
│   ├── runtime-config.js       # Runtime config reader/writer
│   └── shared-crypto.js       # SHA-256 content hashing utilities
│
├── shared-mcp/                 # Shared MCP transport layer
│   ├── omni-memory-server.js   # Main MCP server (HTTP on port 9338)
│   ├── singleton-stdio-mcp-proxy.mjs  # Process deduplication proxy
│   ├── playwright-stdio-proxy.js       # Playwright session proxy
│   ├── manifest.json           # Server manifest (shared / isolated / optional)
│   ├── python-runtime.cjs      # Python runtime resolver (ESM compat)
│   ├── package.json            # MCP server npm dependencies
│   ├── start-shared-mcp.ps1 / .sh     # Start named servers
│   ├── start-default-shared-mcp.ps1 / .sh  # Default stack launcher
│   ├── stop-shared-mcp.ps1 / .sh
│   ├── status-shared-mcp.ps1 / .sh
│   └── logs/                   # Per-server log files
│
├── ops/                        # Operations tooling
│   ├── build-memory-layers.js         # MEMORY-LAYERS.json builder
│   ├── build-handoff-pack.js         # HANDOFF.json builder
│   ├── run-memory-dream.ps1          # AUTO-DREAM consolidator
│   ├── check-memory-integrity.js     # Schema/contract validator
│   ├── generate-memory-hygiene-report.js  # Duplicate/invalid record detector
│   ├── sync-openclaw-to-obsidian.js  # OpenClaw → structured JSONL
│   ├── obsidian-blackboard-daemon.js # Chokidar vault watcher
│   ├── install-client-integrations.ps1 / .sh  # Client MCP wiring
│   ├── verify-client-integrations.ps1 / .sh   # Hard validation gate
│   └── run-pressure-test.ps1 / .sh    # Multi-wave load test
│
├── retrieval/                  # Search and embedding layer (Python)
│   ├── semantic-search.py      # BM25 + dense + hybrid + MMR + caching
│   ├── embedding_providers.py  # Provider abstraction (hashing-v1 / Ollama / OpenAI)
│   ├── runtime_support.py     # Vault/Python runtime detection
│   ├── lsh_utils.py            # LSH hashing utilities
│   ├── benchmark-architecture.py   # Architecture benchmarking
│   ├── benchmark-backends.py      # Embedding backend comparison
│   └── probe-models.py            # Model probing utility
│
├── scripts/                    # Install and upgrade scripts
│   ├── install.ps1 / install.sh   # Full install
│   ├── uninstall.ps1 / .sh        # Uninstall
│   ├── upgrade.ps1 / .sh          # Upgrade runtime
│   ├── validate-layout.ps1 / .sh  # Source-to-install contract check
│   └── install-layout.psd1        # Source-to-install path mapping
│
├── docs/                       # Documentation
│   ├── architecture/           # Architecture docs (see below)
│   ├── platform/               # Platform setup guides
│   ├── guides/                 # How-to guides
│   ├── reference/              # API and data format references
│   ├── adr/                    # Architecture Decision Records
│   └── *.md                    # Top-level docs (INSTALL, FAQ, etc.)
│
├── templates/                  # Reusable template skeletons
│   ├── agents/                 # Per-agent starter kits
│   │   ├── portable-skill/     # Portable skill file template
│   │   └── thin-plugin/        # Thin plugin adapter template
│   └── config/
│       └── runtime.json        # Default embedding runtime config
│
├── .github/workflows/          # CI/CD
│   ├── windows-validate.yml    # Windows full validation
│   └── portable-core.yml      # POSIX smoke + core layout
│
└── SKILL.md                   # Root universal skill entry point
```

---

## Setting Up Dev Environment / 设置开发环境

### Prerequisites / 前提条件

| Software | Required version | Install |
|----------|----------------|---------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| Python | 3.10+ | [python.org](https://www.python.org) or `uv python install 3.11` |
| PowerShell | 7+ | `brew install powershell` (macOS) / [Microsoft repo](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux) (Linux) / built-in (Windows) |
| Git | any recent | `brew install git` / system package |

### Clone and Install / 克隆并安装依赖

```bash
git clone https://github.com/your-org/local-ai-memory-bus.git
cd local-ai-memory-bus

# Install Node.js dependencies for shared MCP
cd shared-mcp && npm install && cd ..

# Install Python dependencies for retrieval
python3 -m pip install rank-bm25 jieba

# Or with uv:
uv pip install rank-bm25 jieba --system
```

### Environment Variables for Development / 开发环境变量

```bash
# ~/.bashrc / ~/.zshrc (macOS/Linux) or PowerShell profile (Windows)

# Use the repo itself as the runtime (no install needed for dev)
export AI_MEMORY_ROOT="$(pwd)"

# Store root (use a temp dir for dev to avoid touching prod data)
export AI_MEMORY_STORE="/tmp/.ai-memory-dev"

# Python interpreter
export AI_MEMORY_PYTHON="python3"

# PowerShell (macOS/Linux only)
export AI_MEMORY_PWSH="pwsh"
```

### Create Dev Store Directories / 创建开发存储目录

```bash
mkdir -p /tmp/.ai-memory-dev/{inbox,structured,generated,kg,embeddings}
```

---

## Running Tests / 运行测试

### Layout Validation / 布局验证

Before any code change, validate the source-to-install contract:

```powershell
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
```

```bash
# macOS / Linux
./scripts/validate-layout.sh
```

### Memory Integrity Check / 内存完整性检查

```bash
node ops/check-memory-integrity.js --strict
```

### Client Integration Validation / 客户端集成验证

```bash
~/.ai-memory/verify-client-integrations.sh -WorkspaceRoot "$(pwd)" -RunCliChecks -RunRuntimeChecks
```

### Pressure Test / 压力测试

```bash
~/.ai-memory/run-pressure-test.sh -WorkspaceRoot "$(pwd)" -Waves 3 -RunCliChecks -RunToolCalls
```

### Manual Smoke Test / 手动冒烟测试

```bash
# Start the shared MCP stack from source tree
node shared-mcp/omni-memory-server.js &

# Test memory_status
curl -s -X POST http://127.0.0.1:9338/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}'

# Test search
curl -s -X POST http://127.0.0.1:9338/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_shared_memory","arguments":{"query":"test","limit":3}}}'

# Kill the server
pkill -f "node shared-mcp/omni-memory-server.js"
```

---

## Code Style / 代码风格

### JavaScript / Node.js

- **Immutability**: Always create new objects. Never mutate parameters.
- **Error handling**: Use `try/catch` with descriptive error messages. Never swallow errors silently.
- **Naming**: `camelCase` for variables and functions; `PascalCase` for classes; `SCREAMING_SNAKE_CASE` for constants.
- **Module pattern**: Use `"use strict"` at the top of every module.
- **ESM vs CJS**: Use `.mjs` for ESM-only code; `.cjs` for CommonJS compatibility shims; `.js` defaults to CJS unless `"type": "module"` in `package.json`.
- **No `console.log` in production code** — use structured logging or write to `shared-mcp/logs/`.

### PowerShell

- Use `param()` blocks for script parameters.
- Use `-ErrorAction Stop` on critical operations.
- Prefix module-level variables with `$` (standard PowerShell).
- Format: 4-space indentation, no tabs.
- Comment conventions: `# Single line` for inline; `<# block #>` for block comments.

### Python

- Follow [PEP 8](https://pep8.org/).
- Use `typing` for type hints.
- Use `logging` module, not `print()`.
- Import order: stdlib → third-party → local.

---

## Debugging / 调试

### Watchdog Not Responding / 看门狗无响应

```bash
# Check watchdog status
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json | jq '.watchdog'

# Manually trigger one watchdog cycle
~/.ai-memory/bus/memory-watchdog.sh -Once
```

### Search Worker Not Running / 搜索工作进程未运行

```bash
# Inspect search worker state
~/.ai-memory/shared-mcp/status-shared-mcp.sh -Json | jq '.searchWorker'

# Clear cache and check worker logs
curl -s http://127.0.0.1:9338/mcp ... # call clear_shared_memory_search_cache
tail -n 50 ~/.ai-memory/shared-mcp/logs/search-worker.log
```

### Python Retrieval Issues / Python 检索问题

```bash
# Test Python retrieval directly
python3 retrieval/semantic-search.py --query "test" --limit 3

# Check Python runtime
python3 -c "import sys; print(sys.version)"

# Verify rank-bm25 and jieba
python3 -c "import rank_bm25; import jieba; print('OK')"
```

### Structured JSONL Issues / 结构化 JSONL 问题

```bash
# Check JSONL validity
node ops/check-memory-integrity.js --strict

# Find corrupted lines
node -e "
const fs = require('fs');
const lines = fs.readFileSync(process.env.AI_MEMORY_STORE + '/structured/shared-inbox.jsonl', 'utf8').split('\n');
lines.forEach((line, i) => {
  if (line.trim()) {
    try { JSON.parse(line); }
    catch(e) { console.error('Line ' + (i+1) + ': ' + e.message); }
  }
});
"
```

### Cross-Language Call Chain / 跨语言调用链

```
Node.js (omni-memory-server.js)
    │ spawns Python (semantic-search.py)
    ▼
Python: BM25 + dense + hybrid + rerank
    │ returns JSON over stdout
    ▼
Node.js: parses results, returns MCP response
```

If the chain breaks:
1. Check `AI_MEMORY_PYTHON` resolves to a real interpreter
2. Check `python3 -c "import rank_bm25; import jieba"` succeeds
3. Run `semantic-search.py` directly to isolate the issue

---

## Branching and Commit / 分支和提交

- **Branch naming**: `type/short-description` (e.g., `fix/memory-integrity-check`, `feat/new-platform`)
- **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **PR size**: Keep PRs small and focused. One feature or fix per PR.
- **Validate before commit**: Run `scripts/validate-layout.ps1` (or `.sh`) and `node ops/check-memory-integrity.js --strict` before pushing.

---

## Releasing / 发布

See [`CHANGELOG.md`](../CHANGELOG.md) for the full release process.
