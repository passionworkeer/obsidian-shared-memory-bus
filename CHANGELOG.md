# Changelog

All notable changes to this project should be documented here.

## 2026-07-10 (Round 2)

### Fixed — 9 个独立 PR 收尾 Wave 4/5 + 杂项
- **PR16** (commit `da3b4bc`): I-HIGH-1 stage 2 — `port-registry.js` 加 `SPLIT_MEMORY_SERVER_PORTS` (retrieval/bridge/dream/mgmt:9339-9341),扩展 `CRITICAL_PORTS`。完整 4-server 独立进程拆分留作 future PR (改动量级 1500+ 行),本 PR 仅预留端口不冲突。
- **PR15** (commit `0b9e5b3`): Q-HIGH-6 跨语言 hash parity — 实测 Python + Node 在 ASCII-only 输入下 SHA-1 输出**完全一致**(`e9e06904388700cb`, `fe398c9c8d4bc7ba`, `c47b2ee4718c14c7`)。Audit 描述失实:keys 顺序一致 → 序列化字节序列相同 → hash 相同。`tests/unit/js/shared-crypto.test.js` 新增 3 个 pinned parity test 防 drift。
- **PR14** (commit `e8c797f`): Q-HIGH-10 trace id 跨 Node→Python — `setCurrentTraceId` 与 `withTrace` 同步镜像 `process.env.AI_MEMORY_TRACE_ID`,Python 子进程通过 `os.environ` 自动读取跨边界 trace id。
- **PR13** (commit `31dce00`): Q-HIGH-5 审计描述失实 — 重排一个 fact 后 `fieldHashes[fieldName]` 改变 → 缓存正确失效,是 intended behavior 不是 bug。Audit 文档标 ⚠️ 失实。
- **PR12** (commit `77d1102`): Q-HIGH-2 partial-write 设计意图文档化 — 每个 batch 内 `writeIndexSnapshot` 走 tmp+rename atomic,有意的渐进可见性优化,注释说明 risk / reward 不实施代码改动。
- **PR11 step 3** (commit `b63ce02`): Q-HIGH-1 大文件拆分 — `loadExistingIndex` 50 行 IO streaming 抽到 `bus/generate-embeddings-load.js`,主文件 795→728 行。
- **PR11 step 2** (commit `3702de5`): Q-HIGH-1 大文件拆分 — `buildWorkerScript()` 145 行 Python template 抽到 `shared-mcp/embedding-worker-script.cjs`,`shared-mcp/embedding-worker-pool.cjs` 658→509 行。
- **PR10** (commit `796c9f4`): Q-CRIT-4 partial — `bus/embedding-provider-registry.js` 抽 `spawnPythonWorker()` helper,transformer 与 gemini 两条 per-call path 共享 spawn/stderr drain/proxy env 4 行;Python 脚本提升到模块级 constants (PER_CALL_SENTENCE_TRANSFORMER_SCRIPT / PER_CALL_GEMINI_SCRIPT)。
- **PR9** (commit `03a2dcf`): I-LOW-2/3/4/6 + Q-MED-1/7/10 审计失实标注 — 6 项 audit 描述与代码现状不符 (e.g. `bus/memory-promotion-scorer.js` 已删除、`web/shot.py` 路径是作者 dev 机配置、`bus/` 全量 grep `var` 0 命中、4 脚本走的是多路径合法 fallback 不是已删的 `ops/bus/`)。

### Verified
- `npm test`: 813 passed / 2 pre-existing failures (Python ENOENT, unrelated)
- 8 个新独立 commit (PR9 文档化 + PR10-PR16 代码改动) 全部可独立 revert

## 2026-07-10

### Fixed — Audit 复核 + 7 个独立 PR (Issue 重对账)
- **PR7 / I-HIGH-1**: `omni-memory-server.js` 激活 `AI_MEMORY_SERVER_MODE` env 入口 (`retrieval` / `bridge` / `dream` / `mgmt` / `all`),把"死代码" `toolFilter` 变为"环境变量驱动"工具子集过滤。完整 4-server 独立进程拆分 (`docs/architecture/SERVER-SPLIT.md` §7) 留作未来 PR;本次仅打通入口。
- **PR6 / Q-HIGH-1**: 抽出 `NOISE_PATTERNS` + `isNoise()` 到新模块 `bus/text-noise.js`,`bus/generate-embeddings.js` 805 → 799 行 (Q-HIGH-1 第一步)。其余 800+ 行文件拆分 (`shared-mcp/embedding-worker-pool.cjs`、`retrieval/search_ranking.py`) 留作后续 PR。
- **PR5 / Q-CRIT-1**: `retrieval/search_ranking.py` 抽出 `_resolve_query_runtime_for_dense()` helper,消除 `dense_scores` 与 `_dense_scores_fallback` 之间 ~50 行 schema+config-hash 派生重复 (`audit 提的 "3 处重复" 实测仅 2 处`)。
- **PR4 / Q-MED cleanup bundle**:
  - `cli/package.json`: `engines.node` 升 `>=16` → `>=18`,与根一致 (Q-MED-5)
  - `ops/generate/generate-context.js`: 删除重复 `getContextPath()`,改 import `bus/store-root.js` (I-LOW-1 / Q-MED-4)
- **PR3 / Q-HIGH-3**: `bus/bm25.js` 102 行加 size-bounded (1024 entries) FIFO tokenize 缓存。
- **PR2 / Q-HIGH-7**: `shared-mcp/memory-retrieval.js` + `memory-bridge.js` 重复的 `spawnProcess` helper 抽公到 `shared-mcp/proto/child-process.mjs`(已存在的 IPC 模块加 `export`)。
- **PR1 / Q-HIGH-8**: `shared-mcp/omni-handlers.js` `buildHandlerRegistry` 同名 handler 注册抛 `Error`(原 for-of 静默覆盖)。

### Docs — 审计复核真伪报告
- 新增 `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md`:22 项 ⏸️ 留待项逐条复核,识别 5 项审计描述失准 / 1 项已悄悄修复 / 13 项仍真遗留。后续 PR 排序见 §5。
- `docs/PROJECT_AUDIT_2026-07-09.md` Wave 4 / Wave 5 区段保留 ⏸️ 标识 (本次只完成 6 项真遗留,其余 9 项需独立 PR)。

### Verified
- `npm test`: 810 passed / 2 pre-existing failures (`python ast.parse ENOENT`,unrelated)。
- 单 commit 可独立回滚 (8 个 commit messages 见 `git log --oneline -8`)。


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
