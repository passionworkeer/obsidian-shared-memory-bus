# Changelog

All notable changes to this project should be documented here.

## Unreleased
- Added open-source community health files and contributor guidance
- Expanded documentation for operations, validation, deployment shapes, and new-agent onboarding

## 2026-04-01

### Added
- Shared `memory` MCP as a canonical default shared service
- Optional OpenAI-compatible embedding backend while keeping offline `hashing-v1` as the default dense path
- Portable public bundle under `E:\desktop\obsidian-shared-memory-bus`
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
