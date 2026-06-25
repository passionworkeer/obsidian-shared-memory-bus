# Local AI Memory Bus · One local memory, every AI tool

> **One line**: Claude Code, Codex, Cursor, Copilot and other AI tools share a single local memory backend — stop re-explaining your project context.

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="docs/promotion/QUICKSTART.en.md">English Quick Start</a> ·
  <a href="docs/promotion/QUICKSTART.zh-CN.md">中文快速开始</a> ·
  <a href="SKILL.md">Universal SKILL</a>
</p>

<p align="center">
  <a href="https://github.com/passionworkeer/local-ai-memory-bus/actions/workflows/test.yml"><img src="https://github.com/passionworkeer/local-ai-memory-bus/actions/workflows/test.yml/badge.svg" alt="Test CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen" alt="Node 18+"></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/Python-3.10+-orange" alt="Python 3.10+"></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen" alt="Platforms">
  <img src="https://img.shields.io/badge/Docker-ready-blue" alt="Docker">
  <img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP">
  <img src="https://img.shields.io/badge/local--first-%E2%9C%93-success" alt="Local-first">
  <img src="https://img.shields.io/github/stars/passionworkeer/local-ai-memory-bus?style=social" alt="Stars">
</p>

---

## The Problem

If you use multiple AI coding tools (Claude Code, Codex, Cursor, Copilot, etc.), each tool stores its own memory. They don't share.

**Solution**: every AI tool talks to the same local memory backend.

---

## When to Use It

### Scenario A · You switch between Claude Code and Codex

Morning: design an API contract with Claude Code. Afternoon: switch to Codex to write the OpenAPI schema. **No more copy-pasting context** — Codex sees what Claude decided.

### Scenario B · You keep project docs in Obsidian

Symlink `~/.ai-memory/derived/` into your Obsidian vault. **Edit in Obsidian = edit memory**. Graph view shows relationships for free.

### Scenario C · Long-term project knowledge base

The 5-layer memory model (L0 Working → L5 Archive) keeps temporary notes, key facts, and long-term knowledge in separate tiers — **a casual chat won't pollute your project knowledge**.

---

## Core Features

| Feature | Description |
|---------|-------------|
| **Shared memory** | Multiple AI tools share one persistent store |
| **Local-first** | Data lives in `~/.ai-memory`, never uploaded |
| **Hybrid retrieval** | BM25 + semantic vectors + Chinese tokenization |
| **MCP protocol** | Compatible with any MCP-aware tool |
| **Watcher pattern** | Background watchdog syncs tool memory automatically |
| **Multi-language** | Node.js + Python collaborate with cross-language equivalence tests |
| **ANN acceleration** | Optional hnswlib backend, 10k+ vectors at P99 < 10 ms |
| **Markdown export** | JSONL event stream → readable .md, Obsidian-friendly |
| **No SaaS** | 100% local, works offline |

---

## Quick Start (4 steps)

```bash
# 1. Clone
git clone https://github.com/passionworkeer/local-ai-memory-bus.git
cd obsidian-shared-memory-bus

# 2. Install
npm install

# 3. Start MCP server (Windows: start.bat; Unix/Mac: ./start.sh)
node start.js

# 4. Configure Claude Code (auto-writes .claude/mcp_servers.json)
node setup-mcp.js
```

Restart Claude Code / Codex / Cursor — your `memory_recall`, `memory_store`, `memory_search` tools appear.

Full English guide: [docs/promotion/QUICKSTART.en.md](docs/promotion/QUICKSTART.en.md)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       AI Clients                               │
│  Claude Code │ Codex │ Cursor │ Copilot │ OpenCode │ Trae    │
└─────────────────────────┬──────────────────────────────────────┘
                          │ MCP (stdio / HTTP)
                          ▼
┌────────────────────────────────────────────────────────────────┐
│                     Shared MCP Layer                            │
│  memory:9338  context7:9331  fetch:9332  time:9333  pw:9337   │
└─────────────────────────┬──────────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
   ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
   │ bus/         │ │ ops/     │ │ retrieval/        │
   │ memory bus   │ │ export   │ │ search + ANN     │
   │ (Node/PowerShell) │ │(Markdown) │ │(Python)        │
   └──────┬───────┘ └────┬─────┘ └────────┬─────────┘
          │              │                │
          ▼              ▼                ▼
   ┌─────────────────────────────────────────────┐
   │         Source of truth ~/.ai-memory          │
   │  structured/*.jsonl  │  derived/*.md         │
   │  embeddings/         │  cascade.sqlite3      │
   └─────────────────────────────────────────────┘
```

**Data flow**:
1. Any AI tool → MCP `memory/*` tool → write to `structured/<source>.jsonl` (append-only)
2. Cascade queue (`cascade.sqlite3`) records each change with LSN + content_sha256
3. Worker drains the queue → incrementally updates embeddings / ANN index
4. `ops/export/export-md.js` derives readable `.md` for Obsidian

---

## Tool Support

| Tool | Level | Integration |
|------|-------|-------------|
| Claude Code | ✅ Tier 1 | MCP + auto setup-mcp.js |
| Codex | ✅ Tier 1 | MCP + agent skill |
| OpenCode | ✅ Tier 1 | MCP + AGENTS.md |
| Cursor | ✅ Supported | MCP config |
| VS Code / Copilot | ✅ Supported | MCP + AGENTS.md |
| OpenClaw | ✅ Supported | Structured memory sync |
| Trae | ✅ Supported | AGENTS.md integration |

---

## Performance (10k × 384-dim internal)

| Metric | Full scan | ANN (hnswlib) | Cascade incremental |
|--------|-----------|---------------|---------------------|
| Dense scoring P99 | ~180 ms | **~6 ms** | **~10 ms / record** |
| Memory peak | ~150 MB | ~70 MB | No rebuild |
| Crash recovery | — | — | Resume from LSN |

---

## Project Structure

```
obsidian-shared-memory-bus/
├── bus/                    # Core runtime (Node + PowerShell)
├── shared-mcp/             # MCP servers
├── ops/                    # Ops + exports (cascade, export-md)
├── retrieval/              # Search (Python) + ANN index
├── tests/                  # unit / integration / cross-language / e2e
├── scripts/                # Install + ops
└── docs/                   # Architecture + guides + promotion
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_MEMORY_STORE` | `~/.ai-memory` | Shared memory store root (preferred) |
| `AI_MEMORY_STORE_ROOT` | `~/.ai-memory` | Legacy alias |
| `AI_MEMORY_PYTHON` | auto | Python runtime path |
| `AI_MEMORY_EMBED_BACKEND` | `hash` | `hash` / `transformer` / `openai-compatible` / `gemini` |
| `AI_MEMORY_EMBED_BASE_URL` | — | OpenAI-compatible API base |
| `AI_MEMORY_EMBED_API_KEY` | — | API key (env-only, never in code) |
| `AI_MEMORY_EMBED_MODEL` | — | Embedding model name |

---

## Tests

| Type | Count | Status |
|------|-------|--------|
| JS unit tests | 600+ | ✅ passing |
| Python tests | 700+ | ✅ all passing |
| Cross-language | 59 | ✅ JS ↔ Py LSH equivalent |
| Integration + E2E | 50+ | ✅ |
| **Total** | **1400+** | **✅ 99%+** |

Run: `npm test` (JS) + `npm run test:py` (Python) + `npm run test:cross` (cross-language)

---

## Security

- ❌ Never store tokens / API keys in code
- ✅ All secrets via environment variables
- ✅ Local-first, no external data transmission
- ⚠️ Scan for sensitive data before forking

---

## License

[MIT](LICENSE) — use, modify, and distribute freely.

---

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture |
| [docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md) | 5-layer memory model |
| [docs/architecture/SERVER-SPLIT.md](docs/architecture/SERVER-SPLIT.md) | MCP server split |
| [docs/guides/LOGGING.md](docs/guides/LOGGING.md) | Centralized logging |
| [docs/guides/API_REFERENCE.md](docs/guides/API_REFERENCE.md) | MCP tool API |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | FAQ |

---

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

<p align="center"><strong>One local memory, every AI tool.</strong></p>
<p align="center">
  <sub>local-first · cross-tool · bilingual · cross-language equivalent · incremental updates</sub>
</p>