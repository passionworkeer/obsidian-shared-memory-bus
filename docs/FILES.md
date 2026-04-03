# File Map

> **Storage note**: The retrieval layer uses Python's standard-library `sqlite3` (no native Node.js bindings required). The shared `memory` MCP and OpenClaw blackboard daemon both route through Python for SQLite access.

## Core Bus Runtime (`bus/`)
- `bus/memory-bus.ps1`
- `bus/memory-watchdog.ps1`
- `bus/register-agent.ps1`
- `bus/generate-embeddings.js`
- `bus/python-runtime.js`
- `bus/vault-root.js`

## Operations Scripts (`ops/`)
- `ops/build-handoff-pack.js`
- `ops/build-memory-layers.js`
- `ops/cleanup-inbox.ps1`
- `ops/install-client-integrations.ps1`
- `ops/obsidian-blackboard-daemon.js`
- `ops/refresh-generated-artifacts.js`
- `ops/repair-codex-runtime.ps1`
- `ops/run-memory-dream.ps1`
- `ops/run-minimax-mcp.ps1`
- `ops/run-obsidian-mcp.ps1`
- `ops/run-pressure-test.ps1`
- `ops/sync-claudemem-to-obsidian.ps1`
- `ops/sync-openclaw-to-obsidian.js`
- `ops/sync-shared-skills.ps1`
- `ops/verify-client-integrations.ps1`
- `ops/verify-integrations.ps1` (compatibility alias to `ops/install-client-integrations.ps1`)

## Retrieval and Embeddings (`retrieval/`)
- `retrieval/benchmark-architecture.py`
- `retrieval/benchmark-backends.py`
- `retrieval/probe-models.py`
- `retrieval/semantic-search-cli.js`
- `retrieval/semantic-search.py`
- `retrieval/semantic-search.js`

## Shared MCP
- `shared-mcp/manifest.json`
- `shared-mcp/omni-memory-server.js`
- `shared-mcp/python-runtime.cjs`
- `shared-mcp/start-default-shared-mcp.ps1`
- `shared-mcp/start-shared-mcp.ps1`
- `shared-mcp/stop-shared-mcp.ps1`
- `shared-mcp/status-shared-mcp.ps1`
- `shared-mcp/write-config-snippets.ps1`
- `shared-mcp/singleton-stdio-mcp-proxy.mjs`
- `shared-mcp/playwright-stdio-proxy.js`
- `shared-mcp/package.json`

## Install Helpers
- `scripts/install-layout.psd1`
- `scripts/install-client-integrations.ps1`
- `scripts/install-client-integrations.sh`
- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/upgrade.ps1`
- `scripts/validate-layout.sh`
- `scripts/validate-layout.ps1`

## Templates
- `templates/agents.json`
- `templates/agents/README.md`
- `templates/agents/portable-skill/SKILL.md`
- `templates/agents/thin-plugin/.codex-plugin/plugin.json`
- `templates/config/runtime.json`

## Architecture Decision Records (`docs/adr/`)
- `docs/adr/README.md` — ADR index
- `docs/adr/ADR-001-shared-memory-architecture.md` — Superseded by ADR-002
- `docs/adr/ADR-002-unified-memory-architecture-v2.md` — Unified architecture (OpenClaw + Claude Code + claude-mem benchmark)

## Research & Analysis (`docs/research/`)
- `docs/research/README.md` — Research index
- `docs/research/openclaw-memory-architecture.md` — OpenClaw architecture analysis (Chinese)

## Release Notes (`docs/releases/`)
- `docs/releases/README.md` — Release notes index
- `docs/releases/RELEASE-NOTES-2026-04-03.md` — 2026-04-03 operator release summary

## Technical Reference (`docs/reference/`)
- `docs/reference/README.md` — Reference index
- `docs/reference/QUICKSTART.md` — 5-step 30-minute getting-started guide
- `docs/reference/DATA-FLOW.md` — End-to-end data flow, write/read paths, cross-language call chains
- `docs/reference/CROSS-LANGUAGE-MAP.md` — PowerShell/Node.js/Python ownership matrix and calling conventions
- `docs/reference/PERFORMANCE.md` — Retrieval latency, scale limits, BM25 vs dense vs hybrid benchmarks
- `docs/reference/OBSERVABILITY.md` — Log format, key metrics, alert thresholds, error taxonomy
- `docs/reference/MCP-TOOLS.md` — All MCP tool definitions, input/output schemas
- `docs/reference/MCP-TOOLS.schema.json` — Machine-readable JSON Schema (Draft-07) for MCP tools

## Repo Metadata
- `AGENTS.md`
- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `SECURITY.md`
- `SUPPORT.md`
- `.gitattributes`
- `.gitignore`

## Agent Overlays
- `.trae/rules/project_rules.md`

## GitHub Community Files
- `.github/workflows/portable-core.yml`
- `.github/workflows/windows-validate.yml`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/pull_request_template.md`
