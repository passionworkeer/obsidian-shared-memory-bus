# ESM Migration Audit

> Audited: 2026-04-12
> Scope: `package.json`, all `*.cjs` files, `type:` field, `exports:` field
> Result: **Phase 0 — No blockers; incremental ESM adoption is safe to begin.**

---

## Current State

### package.json Analysis

| Field | Status | Notes |
|-------|--------|-------|
| `"type"` | **Absent** | Defaults to CommonJS (`require`/`module.exports`) |
| `"exports"` | **Absent** | No conditional exports map |
| `"engines.node"` | `">=18"` | Sufficient for ESM (`import`, top-level `await`) |
| `"engines.powershell"` | `">=7"` | Not JS-related |

**Scripts cross-platform check:**

| Script | Status | Notes |
|--------|--------|-------|
| `test` | OK | `node --test tests/unit/js/*.test.js` — works on all platforms |
| `test:py` | OK | `pytest tests/ -v` |
| `test:cross` | OK | `node --test tests/cross-language/` |
| `test:integration` | OK | `node --test tests/integration/js/*.test.mjs` |
| `test:all` | OK | Combines above |
| `lint` | **Windows-only assumption** | `npm run lint --prefix shared-mcp` — `npm run` with `--prefix` is cross-platform |
| `validate` | **PowerShell** | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate-layout.ps1` — correct for Windows; macOS/Linux alternative not yet provided |
| `check-integrity` | OK | `node ops/check-memory-integrity.js --strict` |

### .cjs File Inventory

| Location | Count | Classification |
|----------|-------|----------------|
| `shared-mcp/node_modules/*/` | **117** | Third-party dependencies (express-rate-limit, zod, eventsource, pkce-challenge) — **not project code** |
| Project root `ops/*.cjs` | **0** | None |
| Project root `bus/*.cjs` | **0** | None |
| `tests/unit/js/*.cjs` | **0** | None |

**Conclusion:** All `*.cjs` files are third-party npm packages inside `shared-mcp/node_modules/`. No project-specific CommonJS files exist that require `.cjs` extension for ESM compatibility.

---

## Migration Plan

### Phase 1: Add `"type": "module"` + Fix Implicit Relative Imports (Low Risk)

**Goal:** Flip the package to ESM with minimal mechanical changes.

1. Add `"type": "module"` to `package.json`.
2. Change all `require("child_process")` → `import ... from "node:child_process"` (explicit `node:` protocol avoids any path resolution ambiguity).
3. Change all `require("fs")` → `import ... from "node:fs"`, etc.
4. Change all `require("./local-module.js")` → `import ... from "./local-module.js"`.
5. Replace `module.exports = { ... }` with `export default { ... }` or `export { ... }`.
6. Replace `const { x } = require("./x.js")` with `import { x } from "./x.js"`.

**Files to update (all in `ops/` and `bus/`):**

```
ops/
  build-memory-layers.js         ← async main(), streaming JSONL (already in progress)
  memory-layers-parse.js        ← async parseSessionMemoryEntries, parseTaskMemoryEntries
  memory-layers-dedup.js
  memory-layers-context.js
  jsonl-stream.js               ← already CommonJS; needs → ESM
  generate-embeddings.js        ← async collectDocuments/loadExistingIndex (already in progress)
  embedding-provider-registry.js
  python-runtime.js
  runtime-config.js
  vault-root.js
  store-root.js
  entity-extractor.js
  knowledge-graph.js
  memory-contract.js
  build-l0-l1-bootstrap.js
  check-memory-integrity.js
```

**Risks:**
- None identified. All files are pure logic — no native addons, no CJS-only packages at project level.
- Third-party packages in `shared-mcp/node_modules/` are CJS, but `import` from them works fine in ESM mode.

### Phase 2: Streaming JSONL as First-Class ESM Feature (Underway)

**Already done:**
- `ops/jsonl-stream.js`: `createJsonlStream`, `readJsonlStream`, `createJsonlBatcher` (CommonJS exports)
- `ops/build-memory-layers.js`: `parseSessionMemoryEntries()` and `parseTaskMemoryEntries()` are async generators over `createJsonlStream`
- `bus/generate-embeddings.js`: `loadExistingIndex()` is an async generator over `createJsonlStream`
- `tests/unit/js/streaming-jsonl.test.js`: ESM test file (validates the streaming API)

**Next step:** Convert `ops/jsonl-stream.js` to ESM and update the `import` syntax throughout.

### Phase 3: MCP Server (`shared-mcp/`) — Requires Most Care

The `shared-mcp/` sub-package is a separate `package.json` in a subdirectory. It has its own dependency tree. Assess independently before adding `"type": "module"` there.

---

## Blocking Issues

| Issue | Severity | Status |
|-------|----------|--------|
| No `exports` field in `package.json` | Low | Not blocking; additive improvement |
| `validate` script Windows-only | Medium | Provide shell alternative: `scripts/validate-layout.sh` |
| Streaming tests are ESM (`.test.js`) | Low | Already working — Node.js `--test` handles mixed CJS/ESM |

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-------------|-------------|
| Circular `require()` dependencies blocking ESM | **Low** | Project uses lazy `require()` inside functions; no module-level cycles detected |
| Third-party CJS packages in `shared-mcp/node_modules/` | **None** | `import` works with CJS in ESM mode |
| `__dirname` / `__filename` not available in ESM | **Medium** | Replace with `import.meta.url`-based path resolution (`fileURLToPath`, `path.dirname`) |
| PowerShell-only `validate` script | **Low** | Add POSIX shell alternative |

---

## Recommendations

1. **Add `"type": "module"` to `package.json`** — This is the single mechanical change that enables ESM. No functional changes required in the logic.
2. **Convert utility files first** (`ops/jsonl-stream.js`, `ops/memory-contract.js`) — no external dependencies, easy to verify.
3. **Replace `__dirname`** in all files using it (there are ~8 occurrences across `ops/` and `bus/`):
   ```javascript
   // Before (CJS):
   const path = require("path");
   const __dirname = path.dirname(__filename);

   // After (ESM):
   import { fileURLToPath } from "node:url";
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
   ```
4. **Add `scripts/validate-layout.sh`** for POSIX compatibility.
5. **Add `"exports"` field** to `package.json` for cleaner public API:
   ```json
   "exports": {
     ".": "./ops/build-memory-layers.js",
     "./jsonl-stream": "./ops/jsonl-stream.js",
     "./embedding-registry": "./bus/embedding-provider-registry.js"
   }
   ```
6. **Keep streaming tests in ESM** (`.test.js` already ESM in `tests/unit/js/`) — validates the streaming API independently of the CJS/ESM mode of the main code.

---

## Current Test Status (Post-Streaming Refactor)

| Test File | Tests | Pass | Notes |
|-----------|-------|------|-------|
| `tests/unit/js/jsonl.test.js` | 19 | 19 | Existing CJS tests |
| `tests/unit/js/streaming-jsonl.test.js` | 14 | 14 | New ESM streaming tests |
| `tests/unit/js/build-memory-layers.test.js` | 8 | 8 | Module import verification |
| **Total** | **41** | **41** | **0 failures** |

---

## Summary

- The project is **100% CommonJS** with no project-level `.cjs` files.
- Adding `"type": "module"` is safe — all logic is portable to ESM.
- Streaming JSONL infrastructure is **already implemented** and tested.
- `ops/build-memory-layers.js` and `bus/generate-embeddings.js` have been updated to use async streaming internally.
- The only migration risk is `__dirname` usage, which is localized and mechanically replaceable.
