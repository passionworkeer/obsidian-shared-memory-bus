# Architecture Migration Plan: obsidian-shared-memory-bus

> Status: Draft for Review
> Generated: 2026-04-12
> Scope: Cross-platform refactoring and open-source preparation

---

## A. Current Project Structure

### Directory Tree with Responsibilities

```
obsidian-shared-memory-bus/
├── .agents/skills/             [8 files] Per-agent skill overlays (claude-code, codex, openclaw, trae, cursor, copilot, template)
├── .claude/rules/              [1 file]  Claude Code local rules
├── .cursor/                    [2 files] Cursor MCP config + rules
├── .github/
│   ├── workflows/              [4 files] CI: lint, tests, portable-core, windows-validate
│   ├── ISSUE_TEMPLATE/        [3 files] Bug report, feature request, config
│   └── pull_request_template.md
├── .trae/rules/               [1 file]  Trae project rules
├── .vscode/                   [1 file]  VS Code MCP config
│
├── bus/                       [15 files] CORE — PowerShell orchestration + JS runtime helpers
│   ├── memory-bus.ps1         Memory write pipeline (JSONL ops)
│   ├── memory-watchdog.ps1    Background watchdog/supervisor loop
│   ├── memory-bus-sync.ps1    Sync between structured layers
│   ├── memory-bus-agents.ps1  Per-agent memory registration
│   ├── memory-watchdog-supervisor.ps1  Supervised watchdog launcher
│   ├── register-agent.ps1     Agent session registration
│   ├── runtime-platform.ps1   CRITICAL: 1500+ line cross-platform PowerShell abstraction
│   ├── python-runtime.js      Python runtime detection (cross-platform capable)
│   ├── store-root.js          Store root resolution (platform-aware)
│   ├── store-root.cjs         Duplicate of store-root.js (CJS fallback, maintenance burden)
│   ├── vault-root.js          Vault root resolution (deprecated → delegates to store-root.js)
│   ├── embedding-provider-registry.js  Embedding backend registry
│   ├── generate-embeddings.js  LSH embedding pipeline
│   ├── lsh-hash.js            LSH hash utilities
│   └── runtime-config.js      Runtime config reader
│
├── cli/                       [2 files] Node.js CLI entry point (ai-memory.js)
│   ├── ai-memory.js
│   └── package.json
│
├── docs/                      [~30 files] Architecture, install, troubleshooting, reference, ADR
│   ├── reference/
│   │   ├── MCP-TOOLS.md
│   │   ├── MCP-TOOLS.schema.json
│   │   ├── DATA-FLOW.md
│   │   └── QUICKSTART.md
│   ├── adr/                   Architecture decision records
│   ├── releases/              Release notes
│   ├── ARCHITECTURE.md        Primary architecture doc (324 lines)
│   ├── INSTALL.md             Cross-platform install guide
│   ├── TROUBLESHOOTING.md     Operational FAQ
│   └── *.md                   FAQ, MEMORY-TIERING, ENV, etc.
│
├── hooks/                     [7 files] Claude Code lifecycle hooks
│   └── stop-hook-llm-extract/  LLM-extracted session summarisation
│       └── src/               Parser, dedup, replay, slice utilities
│
├── ops/                       [~35 files] Build, migrate, verify, sync, KG operations
│   ├── build-memory-layers.js  L0-L4 layer builder
│   ├── build-handoff-pack.js   HANDOFF pack builder
│   ├── knowledge-graph.js      Knowledge graph operations (JS)
│   ├── knowledge-graph.cjs     Knowledge graph operations (CJS)
│   ├── mcp-memory-tools.js      MCP tool implementations
│   ├── mcp-memory-tools.cjs     MCP tool implementations (CJS)
│   ├── mcp-memory-tools-handler.js
│   ├── entity-extractor.js      Entity extraction from sessions
│   ├── migrate-to-store.js      Migration tool
│   ├── check-memory-integrity.js Contract validation
│   ├── generate-memory-hygiene-report.js
│   ├── obsidian-blackboard-daemon.js  OpenClaw bridge
│   ├── sync-claudemem-to-obsidian.ps1
│   ├── sync-openclaw-to-obsidian.js
│   ├── sync-shared-skills.ps1
│   ├── cleanup-inbox.ps1
│   ├── install-client-integrations.ps1
│   ├── verify-client-integrations.ps1
│   ├── verify-integrations.ps1
│   ├── run-pressure-test.ps1    Multi-wave stress test
│   ├── run-memory-dream.ps1
│   ├── run-obsidian-mcp.ps1
│   ├── run-minimax-mcp.ps1
│   ├── run-background-extraction.ps1
│   ├── post-checkout-hook.ps1
│   ├── post-merge-hook.ps1
│   ├── pre-commit-hook.ps1
│   ├── setup-wizard.ps1
│   ├── refresh-generated-artifacts.js
│   ├── memory-archival.js
│   ├── entity-backfill.js
│   ├── memory-contract.js
│   ├── jsonl-stream.js
│   └── migrations/             Schema migration scripts
│       └── kg-v1-to-v2.js
│
├── retrieval/                 [~15 files] Python + JS retrieval/embedding pipeline
│   ├── semantic-search.py     Core BM25 + dense hybrid search
│   ├── semantic-search.js     JS wrapper around Python search
│   ├── semantic-search-cli.js CLI wrapper
│   ├── embedding_providers.py Python embedding backend abstraction
│   ├── runtime_support.py    Python runtime detection
│   ├── lsh_utils.py          LSH hash utilities (Python)
│   ├── schema_validation.py  JSONL schema validation
│   ├── benchmark-architecture.py
│   ├── benchmark-backends.py
│   ├── probe-models.py
│   ├── eval-routing.py
│   └── eval/                 Evaluation fixtures + results
│       ├── judgments-sample.jsonl
│       └── results.json
│
├── scripts/                  [~10 files] Install, upgrade, validate, uninstall
│   ├── install.ps1           Windows installer (1500+ lines)
│   ├── install.sh            macOS/Linux installer
│   ├── install-client-integrations.ps1
│   ├── install-client-integrations.sh
│   ├── install-git-hooks.ps1
│   ├── validate-layout.ps1
│   ├── validate-layout.sh
│   ├── upgrade.ps1 / upgrade.sh
│   ├── uninstall.ps1 / uninstall.sh
│   └── install-layout.psd1  PowerShell data file for layout definition
│
├── shared-mcp/               [~25 files] Shared MCP server (HTTP transport, Node.js)
│   ├── omni-memory-server.js  Main MCP server entry point
│   ├── memory-tools.js        Tool implementations
│   ├── memory-retrieval.js    Retrieval tool with Python backend
│   ├── memory-generation.js   Memory generation tools
│   ├── memory-bridge.js       OpenClaw blackboard bridge
│   ├── memory-status.js       Status/health tools
│   ├── memory-embeddings.js   Embedding tools
│   ├── manifest.json          Server manifest (shared/isolated modes)
│   ├── singleton-stdio-mcp-proxy.mjs  Console window elimination proxy
│   ├── playwright-stdio-proxy.js       Playwright stdio proxy
│   ├── start-shared-mcp.ps1 / .sh
│   ├── start-default-shared-mcp.ps1 / .sh
│   ├── stop-shared-mcp.ps1 / .sh
│   ├── status-shared-mcp.ps1 / .sh
│   ├── write-config-snippets.ps1
│   ├── package.json
│   ├── package-lock.json
│   └── state.json             RUNTIME STATE (absolute paths, should not be committed)
│
├── templates/                Agent + memory configuration templates
│   ├── .memory/               Memory template (ai-memory structure)
│   ├── agents/                Agent integration templates
│   │   ├── portable-skill/
│   │   └── thin-plugin/
│   └── config/
│       └── runtime.json       Default runtime configuration
│
├── tests/                    [~40 files] Unit + integration + cross-language tests
│   ├── unit/js/              Node.js unit tests (Node's built-in test runner)
│   ├── unit/py/              Python unit tests (pytest)
│   ├── cross-language/        Cross-runtime consistency tests
│   ├── integration/js/       Integration tests (MCP + KG flows)
│   ├── bus/                  Bus-specific tests
│   ├── helpers/              Shared test utilities
│   └── fixtures/            JSONL + JSON test fixtures
│
├── types/                    [empty] TypeScript type declarations placeholder
│
├── AGENTS.md
├── ARCHITECTURE_MIGRATION.md  THIS FILE
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md
├── SKILL.md                  Root universal skill entry point
├── SUPPORT.md
└── USAGE.md

Total source files (excluding node_modules, .git): ~150 files
```

### File Count by Directory

| Directory | Source Files | Notes |
|---|---|---|
| `bus/` | 15 | Core PowerShell + JS; highest platform coupling |
| `ops/` | ~35 | Mixed JS + PS; scattered hardcoded paths |
| `shared-mcp/` | ~25 | Node.js MCP server; `state.json` is runtime state |
| `retrieval/` | ~15 | Python + JS; most portable layer |
| `scripts/` | ~10 | Install/upgrade/validate |
| `tests/` | ~40 | JS (Node test runner) + Python (pytest) |
| `docs/` | ~30 | Comprehensive; some docs reference private paths |
| `hooks/` | 7 | Session lifecycle hooks |
| `cli/` | 2 | CLI entry point |
| `templates/` | ~15 | Agent + memory templates |
| `.agents/skills/` | 8 | Per-agent skill files |

---

## B. Target Project Structure (Post-Migration)

```
obsidian-shared-memory-bus/
├── .editorconfig              [NEW] Consistent coding style across editors
├── .github/
│   ├── workflows/
│   │   ├── test.yml           [UPDATE] Multi-platform matrix: windows, macos, linux
│   │   ├── release.yml        [NEW]  Semantic-release + multi-platform asset upload
│   │   ├── portable-core.yml  [KEEP] Cross-platform layout validation
│   │   ├── windows-validate.yml [KEEP] Windows smoke tests
│   │   └── lint.yml           [KEEP]
│   ├── ISSUE_TEMPLATE/        [KEEP + ADD bug_report.md enhancement.md]
│   └── pull_request_template.md [KEEP]
│
├── src/                       [NEW top-level source root]
│   ├── core/                  [KEEP from bus/ops — platform-neutral business logic]
│   │   ├── memory-bus.js      [MOVE from bus/memory-bus.ps1 logic → JS]
│   │   ├── watchdog.js        [MOVE from bus/memory-watchdog.ps1 logic → JS]
│   │   ├── register-agent.js
│   │   ├── build-memory-layers.js
│   │   ├── build-handoff-pack.js
│   │   ├── entity-extractor.js
│   │   ├── check-integrity.js
│   │   ├── sync-claudemem.js
│   │   ├── sync-openclaw.js
│   │   ├── obsidian-blackboard-daemon.js
│   │   ├── knowledge-graph.js
│   │   ├── memory-archival.js
│   │   ├── memory-contract.js
│   │   └── migrations/
│   ├── platform/              [EXTRACTED from bus/ + scattered PS code]
│   │   ├── index.js           Platform detection API (resolve, isWindows, isMacOS, isLinux)
│   │   ├── store-root.js      [REFACTORED: remove E:\ hardcode, use os.homedir() + XDG fallback]
│   │   ├── vault-root.js      [REFACTORED: clean up, remove duplicate]
│   │   ├── python-runtime.js  [REFACTORED: clean up, same logic]
│   │   ├── powershell/        [KEEP bus/runtime-platform.ps1, bus/memory-bus*.ps1 as-is]
│   │   │   ├── runtime-platform.ps1
│   │   │   ├── memory-bus.ps1
│   │   │   ├── memory-bus-sync.ps1
│   │   │   ├── memory-bus-agents.ps1
│   │   │   ├── memory-watchdog.ps1
│   │   │   ├── memory-watchdog-supervisor.ps1
│   │   │   └── register-agent.ps1
│   │   ├── darwin/            [NEW] macOS-specific helpers (if any)
│   │   └── linux/             [NEW] Linux-specific helpers (if any)
│   └── adapters/              [KEEP existing shared-mcp/ + retrieval/ as adapters]
│       ├── mcp/               [MOVE shared-mcp/ here]
│       │   ├── omni-memory-server.js
│       │   ├── memory-tools.js
│       │   ├── memory-retrieval.js
│       │   ├── memory-generation.js
│       │   ├── memory-bridge.js
│       │   ├── memory-status.js
│       │   ├── memory-embeddings.js
│       │   ├── singleton-stdio-mcp-proxy.mjs
│       │   ├── playwright-stdio-proxy.js
│       │   └── manifest.json
│       └── retrieval/          [KEEP retrieval/ as-is]
│           ├── semantic-search.py
│           ├── semantic-search.js
│           ├── embedding_providers.py
│           ├── runtime_support.py
│           ├── lsh_utils.py
│           ├── schema_validation.py
│           └── benchmark-*.py
│
├── scripts/                   [KEEP as-is; installer responsibility boundary]
│   ├── install.ps1 / install.sh
│   ├── upgrade.ps1 / upgrade.sh
│   ├── validate-layout.ps1 / validate-layout.sh
│   └── uninstall.ps1 / uninstall.sh
│
├── cli/                       [KEEP as-is]
│   └── ai-memory.js
│
├── hooks/                     [KEEP; platform-specific hook entries]
│   ├── stop-hook-llm-extract/
│   └── post-*.ps1
│
├── tests/                     [KEEP structure]
│   ├── unit/
│   ├── integration/
│   ├── cross-language/
│   └── fixtures/
│
├── docs/                      [KEEP; update path references]
│
├── templates/                 [KEEP]
│
├── package.json               [UPDATE: scripts → cross-platform]
├── pyproject.toml            [NEW] Python package + dependencies
├── requirements-test.txt      [VERIFY + UPDATE]
├── README.md                  [UPDATE: installation + quick start]
├── LICENSE                    [KEEP (MIT)]
├── CONTRIBUTING.md            [UPDATE: new project structure + dev flow]
├── CHANGELOG.md               [KEEP]
└── ARCHITECTURE_MIGRATION.md  [THIS FILE]
```

### Migration Rules

1. **Core business logic** (`bus/`, `ops/`, `retrieval/`, `shared-mcp/`) stays at root level as aliases or moves under `src/core/` + `src/adapters/`
2. **All platform-specific code** extracted to `src/platform/`
3. **Platform abstraction API** defined in `src/platform/index.js` with a clear contract
4. **PowerShell scripts** stay under `src/platform/powershell/` as the Windows orchestration layer (they are inherently Windows)
5. **New cross-platform operations** go into `src/core/` as Node.js (not PowerShell)
6. **Python retrieval** stays under `src/adapters/retrieval/`
7. **CLI** (`cli/`) remains at root level as the public entry point

---

## C. Cross-Platform Issues (by Severity)

### CRITICAL

---

#### [CRITICAL] `bus/store-root.js` — Hardcoded Windows default store root

**Files:** `bus/store-root.js:99`, `bus/store-root.cjs:118`

```js
const DEFAULT_STORE_ROOT = "E:\\.ai-memory";  // Line 99
```

**Problem:** This constant is used as the final fallback when `AI_MEMORY_STORE`, `AI_MEMORY_ROOT`, and drive auto-detection all fail. It is a Windows-only absolute path hardcoded into the portable source tree. Any macOS or Linux user who hits this fallback will get a path containing a drive letter that will never exist on their system.

**Impact:** Any open-source user on macOS/Linux whose env vars are misconfigured will silently fail to resolve the store root, causing cascading file-not-found errors.

**Recommended fix:**
```js
// Use os.homedir() for cross-platform fallback
const os = require("node:os");
const DEFAULT_STORE_ROOT = path.join(os.homedir(), ".ai-memory");
```

Also update the JSDoc comment to reflect the portable fallback:
```js
 *   3. Fallback: os.homedir() + "/.ai-memory"
```

---

#### [CRITICAL] `bus/store-root.cjs` — Hardcoded Windows fallback with machine-specific username

**File:** `bus/store-root.cjs:150`

```js
: path.join(process.env.USERPROFILE || "C:\\Users\\wang", STORE_NAME);
```

**Problem:** `USERPROFILE` is Windows-only. The hardcoded `"C:\\Users\\wang"` is a machine-specific path that was committed to source control.

**Recommended fix:**
```js
const os = require("node:os");
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
: path.join(USER_HOME, STORE_NAME);
```

---

#### [CRITICAL] `shared-mcp/state.json` — Hardcoded absolute paths in committed file

**File:** `shared-mcp/state.json` (multiple lines)

```json
"stderrPath": "E:\\desktop\\obsidian-shared-memory-bus\\shared-mcp\\logs\\playwright.err.log"
```

**Problem:** This is a committed runtime state file. It contains absolute Windows paths generated from the current machine. This file should never have been committed — it is machine-specific generated state, not source.

**Recommended fix:**
- Add `shared-mcp/state.json` to `.gitignore`
- Add `shared-mcp/startup/` to `.gitignore`
- Add a `.gitignore` entry for all `*.state.json` patterns
- On first run, generate `state.json` from a `state.json.template`

---

#### [CRITICAL] `ops/knowledge-graph.cjs` — Fallback to hardcoded `E:\.ai-memory`

**File:** `ops/knowledge-graph.cjs:53`

```js
return process.env.AI_MEMORY_STORE || "E:\\.ai-memory";
```

**Problem:** The `resolveStoreRoot()` in this file implements its own fallback instead of importing from `bus/store-root.js`. The same issue appears in `ops/knowledge-graph.js:53`.

**Recommended fix:** Import from the central `store-root.js`:
```js
const { resolveStoreRoot } = require("../bus/store-root");
// Remove local resolveStoreRoot() — use the imported one
```

---

#### [CRITICAL] `ops/mcp-memory-tools.cjs` + `ops/mcp-memory-tools.js` — Same `E:\.ai-memory` hardcode

**Files:** `ops/mcp-memory-tools.cjs:44`, `ops/mcp-memory-tools.js:44`

```js
return process.env.AI_MEMORY_STORE || "E:\\.ai-memory";
```

**Problem:** Identical hardcode. These files also implement local path resolution instead of using the central module.

**Recommended fix:** Same as above — import from `bus/store-root.js`.

---

#### [CRITICAL] `ops/migrate-to-store.js` — Multiple hardcoded vault + store paths

**File:** `ops/migrate-to-store.js:53, 72–74`

```js
// Line 53
return process.env.AI_MEMORY_STORE || "E:\\.ai-memory";
// Lines 72-74
"E:\\desktop\\Obsidian Vault",
"E:\\Obsidian Vault",
"D:\\Obsidian Vault",
```

**Problem:** Both store root and vault root are hardcoded with Windows-only paths. The hardcoded vault candidates will never match on macOS/Linux.

**Recommended fix:**
```js
const { resolveStoreRoot } = require("../bus/store-root");
const { resolveVaultRoot } = require("../bus/vault-root");
// Use the central resolution functions; remove hardcoded candidates
```

---

#### [CRITICAL] `ops/sync-openclaw-to-obsidian.js` — Hardcoded `E:\\.ai-memory` in PYTHON source

**File:** `ops/sync-openclaw-to-obsidian.js:506`

```js
command: PYTHON.command,  // PYTHON resolved from bus/python-runtime.js
// but used with E:\.ai-memory in the spawned script
```

**Problem:** The spawned Python script inline uses `E:\\.ai-memory`. Needs to pass the resolved store root as an argument.

**Recommended fix:** Compute `resolveStoreRoot()` in the Node.js wrapper and pass it as a `--store-root` argument to the Python subprocess.

---

#### [CRITICAL] `hooks/stop-hook-llm-extract/stop-extract.mjs` — Hardcoded vault path

**File:** `hooks/stop-hook-llm-extract/stop-extract.mjs:13`

```js
const VAULT_ROOT = process.env.AI_MEMORY_OBSIDIAN_VAULT ?? 'E:\\desktop\\Obsidian Vault'
```

**Recommended fix:**
```js
const os = require("node:os");
const VAULT_ROOT = process.env.AI_MEMORY_OBSIDIAN_VAULT
  ?? path.join(os.homedir(), "Obsidian Vault");  // portable default
```

Also update `hooks/stop-hook-llm-extract/src/session-start-replay.mjs:8` with the same fix.

---

### HIGH

---

#### [HIGH] `bus/python-runtime.js` — Hardcoded `C:\Program Files` in Windows-only fallback

**File:** `bus/python-runtime.js:11–12`

```js
const PROGRAM_FILES = IS_WINDOWS ? process.env.ProgramFiles || "C:\\Program Files" : "";
const PROGRAM_FILES_X86 = IS_WINDOWS ? process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)" : "";
```

**Problem:** Hardcoded program file paths. The `||` fallback paths are only used if the environment variables are missing, which is unlikely on a Windows machine with proper env setup. However, this is still a maintenance risk.

**Recommended fix:** Remove the hardcoded fallbacks and rely solely on the env var:
```js
const PROGRAM_FILES = process.env.ProgramFiles || "";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || "";
// Guard usage with `if (!PROGRAM_FILES) return null;`
```

---

#### [HIGH] `bus/python-runtime.js` — Hardcoded Python version paths for Python 3.11–3.13

**File:** `bus/python-runtime.js:186–196`

```js
// Inside IS_WINDOWS block:
resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python313", "python.exe"), "python313"),
resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"), "python312"),
resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"), "python311"),
```

**Problem:** This hardcoded scan for Python 3.11–3.13 leaves out 3.14+ and is maintenance burden. The `resolveLatestPythonFromDirectory()` function at line 62 already handles arbitrary Python version discovery by scanning the parent directory.

**Recommended fix:** Remove the explicit hardcoded version scans; rely on `resolveLatestPythonFromDirectory()` which is more general.

---

#### [HIGH] `bus/python-runtime.js` — Hardcoded Python path on macOS (`/opt/homebrew/bin/python3`)

**File:** `bus/python-runtime.js:177`

```js
resolveAbsoluteCandidate("/opt/homebrew/bin/python3", "homebrew"),
```

**Problem:** `/opt/homebrew` is macOS-specific (Homebrew on Intel/Apple Silicon on macOS). This path should be guarded with `IS_MACOS`.

**Recommended fix:**
```js
IS_MACOS ? resolveAbsoluteCandidate("/opt/homebrew/bin/python3", "homebrew") : null,
```

---

#### [HIGH] `bus/python-runtime.js` — Hardcoded `/usr/bin/python3` and `/usr/local/bin/python3`

**File:** `bus/python-runtime.js:175–176`

```js
resolveAbsoluteCandidate("/usr/bin/python3", "system"),
resolveAbsoluteAbsolute("/usr/local/bin/python3", "system"),
```

**Problem:** These are standard Unix paths. They are fine in isolation but should be guarded with `!IS_WINDOWS` to be explicit.

**Recommended fix:** Wrap in `!IS_WINDOWS` block or move to the non-Windows candidate list.

---

#### [HIGH] Duplicate `store-root.js` / `store-root.cjs` — Maintenance burden

**Files:** `bus/store-root.js`, `bus/store-root.cjs`

**Problem:** Both files implement the same logic (store root resolution with drive detection). They are not identical — the `.cjs` version has slightly different formatting and is missing `DEFAULT_STORE_ROOT` export. Any fix applied to one must be manually applied to the other, creating a guaranteed drift bug.

**Recommended fix:**
1. Keep `bus/store-root.js` as the canonical implementation
2. Replace `bus/store-root.cjs` with a thin re-export:
```js
// bus/store-root.cjs
module.exports = require("./store-root.js");
```
3. Add `require("node:fs")`, `require("node:path")` shims if needed for CJS compatibility
4. OR: consolidate all consumers to use the `.js` version and delete the `.cjs` one

---

### MEDIUM

---

#### [MEDIUM] `retrieval/eval/results.json` — Machine-specific test result with absolute paths

**File:** `retrieval/eval/results.json:4`

```json
"judgments_file": "E:\\desktop\\obsidian-shared-memory-bus\\retrieval\\eval/judgments-sample.jsonl"
```

**Problem:** This is a committed test result file with a machine-specific path. Should not be committed.

**Recommended fix:** Either remove `retrieval/eval/results.json` from git tracking (add to `.gitignore`), or replace with a template with relative paths.

---

#### [MEDIUM] `retrieval/eval/` fixture files contain absolute path in results

**File:** `retrieval/eval/results.json`

**Problem:** Same as above. The results file should not be in source control or should use relative paths.

---

#### [MEDIUM] `shared-mcp/state.json` in git — should be generated, not committed

**File:** `shared-mcp/state.json`

**Problem:** Runtime state with absolute paths tracked in git. This creates noise in `git diff` and will conflict across users.

**Recommended fix:** Move to `.gitignore`, add `scripts/generate-state-template.js` that produces a `state.json.template`.

---

#### [MEDIUM] `scripts/validate-layout.ps1` — Hardcoded `layoutPath` reference

**File:** `scripts/validate-layout.ps1:10`

```powershell
$layout = Import-PowerShellDataFile -Path $layoutPath
```

**Problem:** This script uses `Import-PowerShellDataFile` which is Windows-only. The `.sh` equivalent (`scripts/validate-layout.sh`) exists and is cross-platform. The PS1 script should remain Windows-only (which is fine), but the layout validation should also work cross-platform.

**Recommended fix:** Keep Windows-specific PS1. Ensure the POSIX shell version covers the same checks for macOS/Linux CI.

---

### LOW

---

#### [LOW] `bus/runtime-platform.ps1` — 1500+ line monolithic file

**File:** `bus/runtime-platform.ps1`

**Problem:** This single file contains platform detection, PowerShell executable resolution, argument building, process spawning (detached, hidden, encoded), path joining, and Windows-specific console elimination. It is hard to test and review.

**Recommended fix (post-migration):** Split into:
- `runtime-platform/core.ps1` — platform detection only
- `runtime-platform/spawn.ps1` — process spawning abstractions
- `runtime-platform/paths.ps1` — path utilities
- `runtime-platform/windows.ps1` — Windows-specific helpers (console elimination, VBS generation)

Keep `runtime-platform.ps1` as the aggregator that dot-sources all the parts, preserving backward compatibility.

---

#### [LOW] `scripts/install.ps1` — 1800+ line monolithic installer

**File:** `scripts/install.ps1`

**Problem:** The Windows installer is a single 1800+ line script. It mixes install logic, startup registration, VBS generation, and environment setup.

**Recommended fix:** Extract:
- `scripts/install/startup.ps1` — startup registration (Windows Task Scheduler, macOS LaunchAgents, Linux systemd)
- `scripts/install/environment.ps1` — env var setup
- `scripts/install/mcp-stack.ps1` — shared MCP startup

---

## D. Open-Source File Checklist

### Present and Complete

| File | Status | Notes |
|---|---|---|
| `README.md` | OK | Comprehensive; 500+ lines; cross-platform install documented |
| `LICENSE` | OK | MIT |
| `CONTRIBUTING.md` | OK | 100 lines; dev loop, PR checklist, scope matrix |
| `CHANGELOG.md` | OK | Keep changelog |
| `CODE_OF_CONDUCT.md` | OK | Contributor Covenant 2.1 |
| `SECURITY.md` | OK | Private reporting path, no hardcoded secrets |
| `SUPPORT.md` | OK | Links to issues + troubleshooting docs |
| `.github/workflows/tests.yml` | OK | Multi-platform test coverage |
| `.github/workflows/portable-core.yml` | OK | Windows + macOS + Linux layout validation |
| `.github/workflows/windows-validate.yml` | OK | Windows smoke tests |
| `.github/workflows/lint.yml` | OK | ESLint |
| `.github/ISSUE_TEMPLATE/` | OK | bug_report.md, feature_request.md, config.yml |
| `.github/pull_request_template.md` | OK | Breaking changes + test plan + scope matrix |
| `.github/copilot-instructions.md` | OK | AI pair programming hints |
| `requirements-test.txt` | OK | Python test dependencies |
| `.eslintrc.js` + `.eslintignore` | OK | JS linting |
| `jsconfig.json` | OK | Node.js path mapping |

### Missing or Incomplete

---

#### `.editorconfig` [MISSING — HIGH priority]

**Why needed:** Without `.editorconfig`, contributors using different editors (VS Code, IntelliJ, Vim, etc.) will produce inconsistent line endings, indentation, and charset settings. This causes noise in `git diff` and `git blame`.

**Recommended content:**

```ini
# .editorconfig — Cross-platform consistent formatting
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true

[*.{js,mjs,cjs,ts,json,jsonl,yaml,yml}]
indent_style = space
indent_size = 2

[*.{ps1,psm1}]
indent_style = space
indent_size = 4

[*.py]
indent_style = space
indent_size = 4

[*.md]
trim_trailing_whitespace = false
indent_style = space
indent_size = 2

[*.sh]
indent_style = space
indent_size = 2
end_of_line = lf

[Makefile]
indent_style = tab
```

---

#### `pyproject.toml` [MISSING — HIGH priority]

**Why needed:** The project has significant Python code (`retrieval/`) but no `pyproject.toml`. `requirements-test.txt` exists but is incomplete — it only covers test dependencies, not the runtime dependencies (`rank-bm25`, `jieba`, `numpy`, etc.) needed for the retrieval layer.

**Recommended structure:**

```toml
# pyproject.toml — Python package + dependency management
[project]
name = "obsidian-shared-memory-bus-retrieval"
version = "3.1.0"
description = "BM25 + dense hybrid retrieval layer for obsidian-shared-memory-bus"
requires-python = ">=3.10"
license = {text = "MIT"}
authors = [{name = "passionworkeer"}]
keywords = ["obsidian", "memory", "retrieval", "bm25"]

dependencies = [
    "rank-bm25>=0.2.2",
    "jieba>=0.42.1",
    "numpy>=1.26.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "pytest-asyncio>=0.21",
    "pytest-cov>=4.0",
]
all = [
    "openai>=1.0",
    "anthropic>=0.18",
]

[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[tool.pytest.ini_options]
testpaths = ["tests/unit/py"]
python_files = ["test_*.py"]
addopts = "-v --tb=short"

[tool.coverage.run]
source = ["retrieval"]
omit = ["*/tests/*", "*/__pycache__/*"]

[tool.coverage.report]
exclude_lines = ["pragma: no cover", "def __repr__", "raise NotImplementedError"]
```

---

#### `requirements-test.txt` [INCOMPLETE — MEDIUM priority]

**Current state:** Exists but likely incomplete. Should list all Python runtime dependencies needed for retrieval + testing.

**Recommended update:** Move content to `pyproject.toml` (as above) and keep `requirements-test.txt` as a generated artifact for users who prefer pip-style installs:
```
# requirements-test.txt — Auto-generated from pyproject.toml
# Run: pip install -e ".[dev]"  or  pip install -r requirements-test.txt
-r requirements.txt
pytest>=7.0
pytest-asyncio>=0.21
pytest-cov>=4.0
```

---

#### `scripts/install-client-integrations.ps1` [DUPLICATE — MEDIUM]

**File:** Both `scripts/install-client-integrations.ps1` and `ops/install-client-integrations.ps1` exist with identical content.

**Recommended fix:** Keep one canonical location (`scripts/`). Either:
- Delete `ops/install-client-integrations.ps1` and have `ops/` scripts call `../scripts/install-client-integrations.ps1`
- OR: add a comment in `ops/install-client-integrations.ps1` noting it is a forwarding alias

---

## E. Implementation Plan (5 Phases)

---

### Phase 1: Directory Structure Reorganisation

**Goal:** Create the `src/` layout while keeping `bus/`, `ops/`, `retrieval/`, `shared-mcp/` as stable anchors.

**Steps:**

1. Create `src/core/` directory
2. Create `src/platform/` directory tree:
   - `src/platform/index.js` — Platform detection API
   - `src/platform/store-root.js` — Refactored from `bus/store-root.js`
   - `src/platform/vault-root.js` — Clean refactor
   - `src/platform/powershell/` — Move `bus/runtime-platform.ps1`, `bus/memory-bus*.ps1`, `bus/register-agent.ps1`
   - `src/platform/darwin/` — macOS-specific helpers (initially empty)
   - `src/platform/linux/` — Linux-specific helpers (initially empty)
3. Create `src/adapters/mcp/` — Placeholder for future shared-mcp reorganisation
4. Update `.gitignore` to exclude runtime-generated files:
   - `shared-mcp/state.json` → generated state
   - `shared-mcp/startup/` → generated scripts
   - `retrieval/eval/results.json` → machine-specific
5. Add `.editorconfig` to project root

**Acceptance criteria:**
- `git ls-files src/` returns the new structure
- `git status` shows only new/changed files (no mass deletions of old files if using symlinks)
- All existing tests still pass in-place (no file moves that break imports)

**Risks:** Moving files breaks `git blame` history and external references (e.g., documentation links). **Recommendation:** Use `git mv` to preserve history, and add redirect comments in old locations pointing to new ones.

---

### Phase 2: Cross-Platform Abstraction Layer

**Goal:** Fix all CRITICAL + HIGH platform hardcodes. Establish `src/platform/index.js` as the single source of truth for platform detection.

**Steps:**

1. **Create `src/platform/index.js`:**
```js
// src/platform/index.js
const os = require("node:os");

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

module.exports = { IS_WINDOWS, IS_MACOS, IS_LINUX, USER_HOME };
```

2. **Refactor `src/platform/store-root.js`:**
   - Import from `src/platform/index.js`
   - Replace `DEFAULT_STORE_ROOT = "E:\\.ai-memory"` with `path.join(USER_HOME, ".ai-memory")`
   - Replace `process.env.USERPROFILE || "C:\\Users\\wang"` with `USER_HOME`
   - Export `resolveStoreRoot`, `getInboxRoot`, `getGeneratedRoot`, `getKgRoot`, `getStructuredRoot`

3. **Delete `bus/store-root.cjs`** (replace with re-export in CJS form OR update all consumers to use the JS version)

4. **Fix all consumers** (`ops/knowledge-graph.js`, `ops/mcp-memory-tools.js`, `ops/migrate-to-store.js`, `ops/sync-openclaw-to-obsidian.js`, etc.):
   - Add `const { resolveStoreRoot } = require("../platform/store-root");`
   - Remove local fallback to `"E:\\.ai-memory"`

5. **Refactor `src/platform/python-runtime.js`:**
   - Remove hardcoded `C:\\Program Files` fallbacks
   - Remove explicit Python 3.11–3.13 scans; rely on `resolveLatestPythonFromDirectory()`
   - Guard `/opt/homebrew/bin/python3` with `IS_MACOS`
   - Move Unix system paths to `!IS_WINDOWS` block

6. **Fix `hooks/stop-hook-llm-extract/stop-extract.mjs`:**
   - Replace `'E:\\desktop\\Obsidian Vault'` with `path.join(os.homedir(), 'Obsidian Vault')`
   - Fix `session-start-replay.mjs:8` with the same fix

7. **Handle `shared-mcp/state.json`:**
   - Add to `.gitignore`
   - Create `shared-mcp/state.json.template` with placeholder paths using `<repo-root>`, `<store-root>` tokens
   - On startup, read the template and substitute real paths to generate `state.json`

**Acceptance criteria:**
- `node -e "require('./src/platform/store-root').resolveStoreRoot()"` returns a path inside the user's home directory on all platforms
- `node -e "require('./src/platform/python-runtime').resolvePythonRuntime()"` does not reference `C:\Program Files` in its output

---

### Phase 3: Open-Source Files

**Goal:** Complete all missing open-source files and validate existing ones.

**Steps:**

1. Add `pyproject.toml` for Python retrieval layer
2. Verify `requirements-test.txt` covers all Python + JS test dependencies
3. Audit `CONTRIBUTING.md` for accuracy with the new `src/` structure
4. Audit all `.md` docs for accidental hardcoded paths (`E:\`, `C:\Users\`, `/Users/`, `/home/`)
   - Use: `git grep -n -I -e "C:\\Users\\" -e "E:\\" -e "/Users/" -e "/home/" -- '*.md'`
   - Fix any findings (RELEASING.md already has this check as a safeguard — good)
5. Add `.github/ISSUE_TEMPLATE/enhancement.md` if missing
6. Ensure `.github/workflows/release.yml` exists (or add one for semantic-release)

**Acceptance criteria:**
- `pyproject.toml` is valid TOML and all listed Python packages are installable
- `CONTRIBUTING.md` references the `src/` layout accurately
- No `.md` files in the repo contain machine-specific absolute paths

---

### Phase 4: CI/CD Enhancement

**Goal:** Add multi-platform test matrix and cross-platform release automation.

**Steps:**

1. **Update `.github/workflows/tests.yml`** to add macOS and Linux runners to the matrix:
```yaml
strategy:
  matrix:
    os: [windows-latest, macos-latest, ubuntu-latest]
    node: ["18", "20", "22"]
```

2. **Add `.github/workflows/release.yml`**:
   - Semantic-release on `main` branch
   - Multi-platform asset upload (Windows `.zip`, macOS `.tar.gz`, Linux `.tar.gz`)
   - PowerShell script bundling for each platform

3. **Add `.github/workflows/docs.yml`** (optional):
   - Auto-deploy docs to GitHub Pages on release

4. **Update `package.json` scripts** to be cross-platform:
```json
{
  "scripts": {
    "test": "node --test tests/unit/js/",
    "test:py": "python -m pytest tests/unit/py/ -v",
    "test:cross": "node --test tests/cross-language/",
    "test:all": "node --test tests/unit/js/ && python -m pytest tests/unit/py/ -v",
    "lint": "npm run lint --prefix shared-mcp",
    "validate:layout": "node scripts/validate-layout.js"
  }
}
```

5. **Ensure `scripts/validate-layout.sh`** covers all the same checks as `scripts/validate-layout.ps1` so macOS/Linux CI can run layout validation.

**Acceptance criteria:**
- All three workflows (tests, portable-core, lint) run on Windows, macOS, and Ubuntu
- `release.yml` produces platform-specific installer packages

---

### Phase 5: Documentation and Polish

**Goal:** Ensure all documentation reflects the new structure and is accurate for new contributors.

**Steps:**

1. **Update `docs/ARCHITECTURE.md`:**
   - Reflect `src/core/`, `src/platform/`, `src/adapters/` structure
   - Update the "Technology Layers" table to reflect the new JS-first PowerShell-second approach
   - Add a "Cross-Platform Strategy" section

2. **Update `docs/INSTALL.md`:**
   - Add `pyproject.toml` + `pip install -e ".[all]"` for Python setup
   - Verify all platform-specific install commands are accurate

3. **Update `docs/OPERATIONS.md` and `docs/FAQ.md`:**
   - Update any path references to the new structure
   - Add a "Cross-Platform Troubleshooting" section for common Unix path issues

4. **Update `CONTRIBUTING.md`:**
   - Reference new `src/` layout
   - Update the "Local Development Loop" section with `src/` paths
   - Add `.editorconfig` and `pyproject.toml` to the development prerequisites

5. **Add `docs/PLATFORM_ABSTRACTION.md`:**
   - Document the `src/platform/index.js` API contract
   - Document how to add a new platform adapter
   - Document the path resolution priority chain

6. **Final secret/path audit:**
```bash
git grep -n -I -e "C:\\Users\\" -e "E:\\" -e "/Users/" -e "/home/" -- \
  "*.js" "*.mjs" "*.cjs" "*.ps1" "*.json" "*.yaml" \
  | grep -v node_modules | grep -v ".git/"
```
   Fix any remaining occurrences.

**Acceptance criteria:**
- `docs/ARCHITECTURE.md` accurately describes the post-migration structure
- All `*.md` files pass the hardcoded-path check
- `CONTRIBUTING.md` contains accurate, tested commands for all three platforms

---

## Summary of Deliverables

| Phase | Key Deliverables | Impact |
|---|---|---|
| **Phase 1** | `src/core/`, `src/platform/`, `src/adapters/` skeleton, `.editorconfig`, `.gitignore` update | Structural foundation |
| **Phase 2** | All `E:\` / `C:\` hardcodes removed; portable store + vault root resolution; `state.json` excluded from git | Open-source safety |
| **Phase 3** | `pyproject.toml`, updated `requirements-test.txt`, audited docs | Release-ready packaging |
| **Phase 4** | Multi-platform CI matrix, release workflow, cross-platform npm scripts | Community CI trust |
| **Phase 5** | Updated `ARCHITECTURE.md`, `CONTRIBUTING.md`, `PLATFORM_ABSTRACTION.md` | New contributor onboarding |

---

## Open Questions

1. **PowerShell as a first-class citizen:** The project currently uses PowerShell as the primary orchestration layer on Windows. Should `src/core/` contain Node.js re-implementations of the bus/watchdog logic, or should PowerShell remain the canonical Windows orchestration with only the platform-abstraction helpers (paths, env detection) in `src/platform/`?

2. **`store-root.cjs` fate:** Should it be deleted (and all CJS consumers updated to use the `.js` version), or kept as a thin re-export?

3. **Python version pinning:** Should `pyproject.toml` pin exact Python version ranges (e.g., `>=3.10,<4.0`) or allow any Python 3.10+?

4. **Shared MCP reorganisation:** The `src/adapters/mcp/` location would be a large refactor. Is this in scope for the initial open-source release, or deferred to a follow-up cleanup?
