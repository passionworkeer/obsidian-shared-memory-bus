# Changelog

All notable changes to this project should be documented here.

## Unreleased
- Expanded generated onboarding packs to bundle shared HTTP MCP snippets, a portable skill template, and a thin plugin-adapter guide
- Documented the recommended cross-platform `MCP + skill + thin plugin` integration bundle more explicitly
- Sanitized tracked public overlay files to use portable placeholders instead of workstation-specific absolute paths
- Documented publish-time checks for machine-path leakage and overlay regeneration safety
- Added `ops/build-handoff-pack.js` plus watchdog/MCP integration so the stack now produces a bounded resume packet instead of relying only on layered summaries
- Added layered memory generation and auto-dream consolidation docs to describe the Claude-style session/handoff layer plus OpenClaw-style task blackboard layer
- Added portable-core CI coverage for Windows, macOS, and Linux memory smoke tests
- Reworked `ops/obsidian-blackboard-daemon.js` to remove native Node dependencies and use the resolved Python runtime plus standard-library `sqlite3`
- Removed `sqlite3` from `shared-mcp/package.json`; current shared MCP lockfile now audits cleanly
- Documented the recommended MCP plus skill integration pattern and clarified when plugins are actually needed
- Added open-source community health files and contributor guidance
- Expanded documentation for operations, validation, deployment shapes, and new-agent onboarding
- Added `scripts/install-layout.psd1` so the grouped source tree and flat installed runtime have one explicit contract
- Added `scripts/validate-layout.ps1` plus a Windows GitHub Actions smoke-install workflow to keep the source/install contract from drifting
- Added root `SECURITY.md` and `.gitattributes` for cleaner GitHub metadata and line-ending hygiene
- Fixed bundle regressions introduced during the directory reorganization, including strict JSON parsing for `shared-mcp/manifest.json`
- Clarified in docs that the source tree is grouped by responsibility while `%USERPROFILE%\.ai-memory` remains intentionally flat for compatibility
- Installer upgrades now prune stale managed runtime files and remove known legacy renamed entrypoints from older layouts
- Shared external MCP launch specs now prefer current registry-resolvable package targets instead of brittle pinned versions that can disappear upstream
- Fixed `run-obsidian-mcp.ps1` to resolve its bundle-local `mcpvault` path via `$PSScriptRoot`, which avoids strict-mode failures when launched behind the shared proxy

## 2026-04-01

### Added
- Shared `memory` MCP as a canonical default shared service
- Optional OpenAI-compatible embedding backend while keeping offline `hashing-v1` as the default dense path
- Portable public bundle for the shared-memory architecture
- Multi-client wiring for Codex, Claude Code, OpenCode, Cursor, VS Code/Copilot, and OpenClaw-related bridges

### Changed
- Shared Playwright backend introduced on `http://127.0.0.1:9337/mcp`
- Default shared starter now includes `playwright`
- Public docs were aligned with actual runtime behavior and sanitized for release

### Validated
- Shared MCP ports `9331-9336`, `9337`, and `9338`
- Pressure tests with stable shared listener PIDs
- Real Playwright MCP browser task validation against the shared backend
- Hybrid retrieval with `bm25 + dense`
