# File Map

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

## Docs
- `docs/DEPLOYMENT-MATRIX.md`
- `docs/FAQ.md`
- `docs/FILES.md`
- `docs/INSTALL.md`
- `docs/INTEGRATION-MODES.md`
- `docs/MCP-DEDUP.md`
- `docs/ARCHITECTURE.md`
- `docs/NEW-AGENT-INTEGRATION.md`
- `docs/OPERATIONS.md`
- `docs/RELEASING.md`
- `docs/ROADMAP.md`
- `docs/SECURITY.md`
- `docs/TROUBLESHOOTING.md`
- `docs/VALIDATION.md`

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
