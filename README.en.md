# yt · One local memory shared by multiple AI tools

> `yt-memory-bus` is a local-first shared-memory runtime. MCP-capable clients connect to the same local HTTP endpoints and share structured memory, retrieval indexes, and derived Markdown documents.

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="docs/promotion/QUICKSTART.en.md">Quick Start</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml"><img src="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen" alt="Node 22+">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen" alt="Platforms">
</p>

## What it solves

When Claude Desktop, Cursor, Codex, Claude Code, or other AI clients keep separate context, switching tools means repeating project background. yt provides one local persistent store and exposes retrieval, write, and management capabilities through MCP.

Core capabilities:

- Multiple MCP clients share one structured-memory store.
- JSONL events, indexes, and derived Markdown remain on the local machine by default.
- BM25 and local hash embeddings work without an external API; other embedding backends are optional.
- Split memory services are the default, with a legacy monolithic compatibility mode.
- Obsidian is an optional UI, not a runtime requirement.

## Current stable boundary

`npm start` launches the core services maintained by this repository:

| Service | Default port | Purpose |
|---|---:|---|
| `fetch` | 9332 | HTTP fetch; requires the corresponding Python MCP package |
| `time` | 9333 | Time utilities; requires the corresponding Python MCP package |
| `memory-retrieval` | 9338 | Retrieval and status queries |
| `memory-bridge` | 9339 | Cross-tool memory bridges |
| `memory-dream` | 9340 | Async rebuild and dream tasks |
| `memory-mgmt` | 9341 | Index, embedding, and knowledge-graph management |

With `AI_MEMORY_SERVER_MODE=monolithic`, the four memory services are replaced by one `memory` service on port 9338. `AI_MEMORY_BASE_PORT` shifts the complete port range; for example, a base port of `10000` makes fetch use `10002`.

`shared-mcp/manifest.json` also documents optional or experimental MCP integrations. They are not automatically launched by `npm start`. Docker files are currently an experimental deployment path and are not recommended for first-time installation.

## Requirements

- Node.js 22 or later; the runtime uses the built-in `node:sqlite` module.
- Python 3.10 or later for Python retrieval components and fetch/time services.
- PowerShell 7 for some installation and operational scripts.
- Obsidian is optional.

## Quick start

```bash
git clone https://github.com/passionworkeer/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus
npm install
npm start
```

In another terminal, diagnose the environment:

```bash
node bin.js doctor
```

Generate configuration for a supported client:

```bash
node setup-mcp.js --help
node setup-mcp.js --target=cursor
node setup-mcp.js --target=cursor --dry-run
```

Automatic configuration currently supports Claude Desktop, Cursor, Kiro, Windsurf, Cline, Roo Code, and Goose. Qoder's on-disk path is not officially verified, so the script prints a manual configuration hint unless the file already exists. Claude Code, Codex, Copilot, OpenCode, and other MCP clients can use the HTTP endpoints manually or through the repository's Agent Skill/templates; `setup-mcp.js` does not modify those clients automatically.

## Store-root resolution

The runtime resolves the store root in this order:

1. Explicit `AI_MEMORY_STORE`, or the compatibility alias `AI_MEMORY_STORE_ROOT`.
2. `00-System/ai-memory` inside a detected Obsidian vault.
3. The configured/source-tree `AI_MEMORY_ROOT`.
4. A final `.ai-memory` fallback in the user's home directory.

Run `node bin.js doctor` before backup or migration to confirm the active path.

## Memory tiers

Persistent records use five tiers:

| Tier | Name | Purpose |
|---:|---|---|
| 1 | Event / Working | Real-time session working buffer |
| 2 | Session Durable | Confirmed session-level learnings |
| 3 | Project Durable | Cross-session project facts |
| 4 | Shared Durable | Cross-project truths, preferences, and references |
| 5 | Archive | Records excluded from vector retrieval |

See [docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md) for TTL, promotion, and embedding rules. Temporary conversation context is not an additional persisted L0 tier.

## Configuration

Common environment variables:

| Variable | Purpose |
|---|---|
| `AI_MEMORY_STORE` | Explicit shared-store root |
| `AI_MEMORY_OBSIDIAN_VAULT` | Explicit Obsidian vault |
| `AI_MEMORY_SERVER_MODE` | `split` (default) or `monolithic` |
| `AI_MEMORY_BASE_PORT` | Core MCP base port; default 9330 |
| `AI_MEMORY_PYTHON` | Python executable |
| `AI_MEMORY_EMBED_BACKEND` | `hash`, `transformer`, `openai-compatible`, or `gemini` |
| `AI_MEMORY_EMBED_BASE_URL` | OpenAI-compatible endpoint |
| `AI_MEMORY_EMBED_API_KEY` | Embedding API key; environment variables are recommended |
| `AI_MEMORY_EMBED_MODEL` | Embedding model name |

See [.env.example](.env.example) for a fuller example.

## Tests

The README intentionally does not maintain a test-count or pass-rate claim that becomes stale. GitHub Actions is the source of truth.

```bash
npm run lint
npm test
npm run test:concurrent
npm run test:integration
npm run test:cross
npm run test:py
npm run test:e2e
```

`npm run test:all` runs a broader combination, but some checks require Python, PowerShell, or a local runtime environment.

## Security and privacy

The default hash-embedding and local retrieval paths do not send memory to an external service. When an OpenAI-compatible, Gemini, or other remote backend is configured, relevant text may be transmitted to that provider. Therefore “local-first” is not the same as “no network traffic under every configuration.”

Do not commit API keys. Prefer environment variables. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Project structure

```text
bus/          Memory bus and platform abstraction
shared-mcp/   MCP servers, ports, and process logic
retrieval/    Python retrieval and ANN components
ops/          Export, migration, validation, and operations
cli/          Command-line entry points
tests/        Unit, integration, cross-language, and E2E tests
docs/         Architecture, specifications, and guides
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Memory tiering](docs/MEMORY-TIERING.md)
- [Server split](docs/architecture/SERVER-SPLIT.md)
- [Data flow](docs/architecture/DATA-FLOW.md)
- [API reference](docs/guides/API_REFERENCE.md)
- [Troubleshooting](docs/guides/TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
