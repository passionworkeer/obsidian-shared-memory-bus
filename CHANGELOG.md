# Changelog

All notable changes to this project should be documented here.

## 2026-06-28

### Changed — Architecture (A1: store/vault unification)
- Canonical memory store is now the Obsidian vault's `00-System/ai-memory` (matches CLAUDE.md: "Canonical long-term memory lives in Obsidian"). Both `resolve_store_root` (Python `retrieval/runtime_support.py`) and `resolveStoreRoot` (Node `bus/store-root.js`) vault-bridge when no `AI_MEMORY_STORE` is set. Priority: `AI_MEMORY_STORE > vault/00-System/ai-memory > AI_MEMORY_ROOT > ~/.ai-memory`.
- New `resolveFromObsidianConfig` in `bus/vault-root.js` reads Obsidian's `obsidian.json` to discover vaults on any drive (Python parity; Node previously only checked home-dir candidates).
- Retrieval now reads real vault data by default (zero env config); pure-file `.ai-memory` is fallback only (CI / no-vault machines).

### Added — Multi-agent integration (A3)
- `setup-mcp.js --target=<claude|cursor|kiro|windsurf|cline|roo|goose|qoder|all|a,b>` configures 8 AI agents. `AGENT_REGISTRY` mapping — one line per new agent. `--dry-run`, `--help`.
- `AGENTS.md` MCP integration section (recognized by Kiro/Trae/Goose/Cline/Roo/Continue).

### Fixed — Windows startup (live end-to-end testing uncovered 4 fatal bugs that tests missed)
- `shared-mcp/proto/windows-shim.mjs`: `spawnSync` import moved from `node:fs` to `node:child_process` (memory server was crashing on startup).
- `shared-mcp/singleton-stdio-mcp-proxy.mjs`: `scheduleRestart` import moved from `rpc.mjs` to `restart.mjs`.
- `start.js`: no longer forces `AI_MEMORY_STORE=~/.ai-memory` (was bypassing the vault bridge, pointing the server at an empty store).
- `shared-mcp/memory-retrieval.js`: store resolution unified to canonical `resolveStoreRoot` (vault bridge), removing a stale independent copy.

### Added — Retrieval quality
- RRF (Reciprocal Rank Fusion) in `retrieval/search_ranking.py` (default `weighted`, opt-in via `AI_MEMORY_FUSION=rrf`). Rank derived from existing scores, no upstream changes.
- NDCG benchmark at `retrieval/eval/ndcg_benchmark.py` (NDCG@5 / Recall@10 / MRR, reuses `judgments.jsonl`).
- Optional cross-encoder rerank (`AI_MEMORY_RERANK=local`, default off) in `search_ranking.py` — bge-reranker-v2-m3, graceful degradation when `sentence_transformers`/model unavailable.

### Added — Packaging & docs
- `bin.js` unified CLI entry: `npx local-ai-memory-bus [start|setup|init|doctor|status|help]`.
- `package.json` `bin` + 15 keywords; `.npmignore` (packed size **537 kB / 403 files**, down from 7.3 MB / 6083).
- README rewritten (A1 vault / A3 8 agents / search_shared_memory vs memory_search / RRF / differentiation vs mem0/Zep). New `docs/guides/INTEGRATION.md`. Updated `docs/ARCHITECTURE.md`, `docs/architecture/DATA-FLOW.md`, `docs/reference/MCP-TOOLS.md`.
- Landing Page upgraded to React+Vite (`web/src/` + `web/dist/`): interactive architecture diagram, L0-L5 layers, 8-agent tabs, copy-toasts. Old static HTML backed up to `web/legacy-html/`.

### Added — Promotion
- `docs/promotion/article.md` — community article (~2350 words, differentiation vs mem0/Zep, honest limitations).
- `docs/promotion/video-script.md` — 4.5-minute demo script (storyboard + narration, real `search_shared_memory` output).

### Verified
- `npm test`: 718 passed / 0 regressions.
- End-to-end MCP: `search_shared_memory` returns real vault data (entryCount 143, 3 results, score 1.015).


## 2026-04-10

### Fixed
- Windows background runtime launchers now use a three-layer console-hiding approach (Start-Process -WindowStyle Hidden + helper launcher wrapper + background wrapper) to reliably keep background Node.js processes invisible
- `singleton-stdio-mcp-proxy.mjs` hardened for edge cases in background execution
- `shared-mcp/start-shared-mcp.ps1` improved fallback logic, process lifecycle management, and orphaned process cleanup
- `ops/verify-client-integrations.ps1` expanded client integration checks
- `ops/run-pressure-test.ps1` hardened with broader validation coverage

### New
- Comprehensive Windows installer (`scripts/install.ps1`) with guided setup, background launcher setup, and client integration registration
- `ops/install-client-integrations.ps1` streamlined client integration installation on Windows
- `memory_wake_up` MCP tool: builds compact session bootstrap pack from canonical shared memory bus (HANDOFF records, MEMORY-LAYERS, active task records)
- `search_shared_memory` gains three new parameters:
  - `includeVerbatim` — attach query-aware exact snippet windows to results
  - `snippetWindow` — control character window around each match
  - `maxVerbatimPerResult` — limit snippets per result
- `ops/check-memory-integrity.js` validates structured JSONL files against versioned memory contract schema

### Changed
- `shared-mcp/memory-status.js` now calls `memory_wake_up` internally to build its bootstrap pack
- `docs/TROUBLESHOOTING.md` expanded with new Windows-specific guidance
- `docs/ENVIRONMENT.md` updated with all current environment variables
- `docs/reference/MCP-TOOLS.md` and JSON schema updated for new tool parameters
- `bus/memory-watchdog.ps1` watchdog improvements for more reliable auto-restart

## 2026-04-12

### New
- Added open-source community health files: `README.md` badges, `.editorconfig`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/test.yml`, `.github/workflows/release.yml`, `CONTRIBUTING.md` update, `docs/architecture/OVERVIEW.md`

### Docs
- Updated README with shields.io badges, Quick Start section, and cross-platform install commands
- Updated CONTRIBUTING.md with complete development setup, testing guide, platform support policy, and ADR references

## Unreleased

### New
- **MMR diversity reranking** (`--mmr`, `--mmr-lambda`): Exposed MMR reranking via CLI and MCP `search_shared_memory.mmr` parameter. `--mmr` automatically upgrades mode to `hybrid` (needs both BM25 + dense scores). Lambda defaults to 0.7 (higher = relevance-first, lower = diversity-first). Results now carry `mmrScore`, `filters.mmrEnabled`, and `filters.mmrLambda` metadata.
- **Python embedding worker pool** (`shared-mcp/embedding-worker-pool.cjs`): Replaces per-call `spawn` for transformer embeddings with a persistent warm pool of 3 Python workers. Each worker loads `sentence-transformers` once and reuses cached models across requests — amortizing cold-start to near-zero. Supports circuit breaker per worker (5 failures / 30 s → retire + restart), backpressure (≥50 pending → reject), and round-robin load balancing. Falls back to legacy per-call spawn if pool init fails.
- `embeddingPool` field in `memory_status` output: exposes healthy/total worker counts, per-worker pending load, circuit breaker state, and failure counts.

### Changed
- `search_shared_memory` now accepts `mmr: { enabled, lambda }` and `temporalDecay: { enabled, halfLifeDays }` parameters
- `memory-status.js` lazy-imports the worker pool to avoid blocking on unavailable pool

## 2026-04-26

### Fixed
- `semantic-search-cli.js`: `--mmr` flag now correctly parsed and forwarded to Python; `--mmr` without explicit `--mode` auto-upgrades to `hybrid`

### New
- **ADR-002 (Unified Memory Architecture v2)**: Complete redesign of memory architecture based on cross-system benchmarking (OpenClaw + Claude Code + claude-mem). Key additions: SQLite chunk schema with FTS5+BM25 Phase 1 content index, chunk-native session logs with hash tracking, typed promotion contract now enforced in frontmatter schema (not just documented), embedding cache table, MMR + temporal decay result reranking, Phase 3 consolidation lock, session-end compaction trigger. Supersedes ADR-001.
- Hardened Windows background process launch so shared MCP and watchdog flows avoid foreground console windows more reliably
- Removed shared proxy environment payloads from command-line arguments and moved them back into process environment propagation
- Taught shared MCP `start/status/stop` scripts to recover from abandoned mutexes after interrupted runs
- Added reusable `templates/agents/portable-skill` and `templates/agents/thin-plugin` starter kits
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

## 2026-04-06

### Security
- Removed hardcoded proxy defaults
- Genericized mutex names (removed personal username)
- Fixed shell injection risk in stdio proxy
- Added bearer token auth to metrics endpoint

### Feature
- Made MCP ports configurable via AI_MEMORY_BASE_PORT
- Added structured error codes documentation
- Added migration guide
- Added retry logic for remote embeddings
- Improved /health endpoint with memory/process info
- Added linting CI

### Fix
- Replaced --break-system-packages with --user
- Improved CLI error handling with --dry-run
- Added __pycache__ to .gitignore

## 2026-04-03

### Windows Runtime Hardening
- Windows shared MCP and watchdog launches now use a no-console background path instead of relying only on `WindowStyle Hidden`.
- Node child processes used by the shared runtime now opt into `windowsHide: true` so nested `node`, `cmd`, and `powershell` launches stay out of the foreground.
- Shared proxy launch no longer passes resolved environment payloads on the command line, removing a local process-list leakage path for sensitive runtime values.
- Shared MCP mutex handling now tolerates abandoned mutex recovery in `start`, `status`, and `stop` flows after interrupted runs.

### Packaging
- Added `templates/agents/portable-skill` and `templates/agents/thin-plugin` starter kits.

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
