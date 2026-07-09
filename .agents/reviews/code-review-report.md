# Code Review — `obsidian-shared-memory-bus`

A tough, hands-on review of the core code paths (bus/, shared-mcp/, retrieval/, cli/, web/, tests/). All file paths are absolute. Line numbers refer to the version in HEAD on `feature/project-analysis-reconcile-2026-07-08`.

---

## Executive Summary

The project is unusually well-structured for a JS/Python hybrid — it has a real module boundary (bus vs. shared-mcp vs. retrieval), a structured logger, a circuit breaker, a worker pool, streaming indexes, and an embedding-provider registry. The team has clearly been here before. But there is a lot of accidental complexity, several genuine hot-path bugs, and a handful of architectural seams that will eventually bite. The biggest themes are:

1. **Sync I/O on what should be async paths** (file reads on each MCP call, two-pass JSON.parse for embeddings index).
2. **Hot-path O(n×m) work** (N+1 entries scan, repeated per-iteration hashMap lookups in `score_entry`).
3. **Over-eager regex / JSON.parse** in tokenization and `search_shared_memory`.
4. **Module-size and God-function creep** — `bus/generate-embeddings.js` is 805 lines and `main()` does 5 things; `shared-mcp/memory-retrieval.js` is 714 lines.
5. **Mutable global state shared across modules** (`WINDOWS_ENV_CACHE`, `_BM25_CACHE`, METRICS, `_ANN_INDEX_CACHE`) — fine when they work, dangerous when they don't.
6. **Tests that don't actually exercise the paths they claim to** — the Python `search_ranking.py` has two near-identical 60-line functions (`dense_scores` + `_dense_scores_fallback`) whose logic is "kept in sync manually". That sentence is a bug factory.

---

## Critical Findings

### CRIT-1 — `dense_scores` and `_dense_scores_fallback` are duplicate logic maintained by hand

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 418–545 (streaming path) vs. 548–642 (fallback path). ~120 lines of near-identical code; the only difference is "iterate streaming index" vs. "iterate preloaded dict".

**Why it's an issue:** The comment on line 557 literally says *"Logic mirrors the streaming path above — kept in sync manually."* That is a maintainability bomb. The function is also called from a third site, `ann_dense_scores` in `retrieval\search_index.py` (lines 472–566), where the same config-hash and schema-version validation is repeated a third time. The next time someone changes the config-hash rules, one of the three will go out of date and dense scoring will silently return zero hits in production.

**Suggested fix:** Extract the "validate first record, resolve query runtime, embed query" prelude into a helper, e.g.

```python
def _resolve_query_runtime(EMBEDDING_RUNTIME, first_record) -> tuple[dict, str | None, dict]:
    """Returns (query_runtime, error, meta). Single source of truth for schema/config checks."""
```

Then both `dense_scores` and `_dense_scores_fallback` and `ann_dense_scores` call it and only differ in their iteration strategy.

---

### CRIT-2 — `readEmbeddingsSummary` re-reads the entire embeddings file from disk and re-parses every line on every metrics refresh

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\source.js`
- **Function:** `readEmbeddingsSummary` (lines 98–170)
- **Callers:** `readMemoryIntegritySummary`, `readEmbeddingRuntimeSummary`, `handleMemoryStatus`, the 60s `setInterval` in `startMetricsRefreshInterval`, and `refreshMetricsFromFiles` (line 333). Each call re-reads the entire `index.jsonl` (potentially 50–100 MB) and re-parses every line with `JSON.parse`.

**Why it's an issue:** Every `/health` hit from a Prometheus scraper will O(n) scan the whole index. The 60s timer will too. With ~10k records this is tens of MB of I/O and millions of `JSON.parse` calls per minute for no reason — nothing about the breakdown (tools / backends / models / dimensions) is being mutated in the file; only the count and timestamp change.

**Suggested fix:** Cache the line-level aggregates by mtime+size. On call, do `fs.statSync` first; if mtime+size match the cache, return the cached summary and just refresh `bytes` and `ageSeconds`. The full re-parse should only run when mtime+size actually changes. Same pattern for `readWatchdogState` (line 64) and `readMemoryHygieneReport` (line 211) — these are smaller files but the principle holds.

---

### CRIT-3 — `handleRefineMemorySelection` builds an LLM prompt that can balloon to >50 KB and shells out to a 30 s fetch with no retry, no error context

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js`
- **Lines:** 278–458
- **Specific issues:**
  - The `recordsSection` template on lines 305–326 truncates content at 2000 chars, but `max_results` defaults to 5 with `maxItems: 50` in the schema, so the prompt can still be 50 × ~2.5 KB ≈ 125 KB before truncation actually saves you.
  - The LLM call on line 384 has no `maxRetries`, no timeout cleanup on `AbortSignal.timeout` failure, and no structured error reporting.
  - The function silently falls back to "first N by original order" four times (no API key, fetch fails, JSON parse fails, response missing `selected`). From the caller's perspective, this is indistinguishable from a real answer.
  - The handler name and the `max_results` field name conflict with the MCP `memory_refine` shape in `memory-tools.js`; there is no validation that `ids` is actually a subset of records already fetched.

**Why it's an issue:** This is one of the user-facing quality-degradation paths. If the LLM provider is rate-limited (very common with 50+ `ids`), every call silently degrades to "return first 5 by original order", which is the same answer as a broken system. A user who has a real retrieval question has no signal that the system is degraded.

**Suggested fix:** At minimum, return a `degraded: true` field and a `reason` enum (`missing-api-key`, `llm-call-failed`, `llm-response-unparseable`, `llm-response-empty`) on every fallback path so callers can warn the user. Move the prompt construction into a private helper (`buildRefinementPrompt(records, query, maxResults)`) and unit-test it. Add a single retry on 429/503.

---

### CRIT-4 — `embedding-provider-registry.js` spawns a Python subprocess per call as the "fallback" path even when a Node-side hash embedder is available

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\embedding-provider-registry.js`
- **Lines:** 110–171 (`embedWithTransformer` per-call spawn)
- **Hot path:** Called from `embedBatch` in `bus/generate-embeddings.js` (line 598–611) which loops over the entire `pending` list (could be thousands of fields per record × N records).

**Why it's an issue:** If the warm worker pool fails to initialize (e.g. the env has no sentence-transformers installed), the registry's "per-call spawn fallback" is used. Each call does: `spawn python -c "import json, sys; from sentence_transformers import SentenceTransformer; model = SentenceTransformer('all-MiniLM-L6-v2'); ..."`. The model import alone is ~3–8 s. With 100 fields, that's 5+ minutes of pure startup overhead. The comment on line 109 calls it "legacy fallback" but there is no guarantee it will not be hit on a clean machine.

**Suggested fix:** Detect unavailability once (probe the import) and immediately fall back to the `hash` adapter (which is already wired at line 408) rather than respawning Python per call. The hash adapter is the right answer when sentence-transformers is missing — it has no dependencies and is already cached.

---

## High-Severity Findings

### HIGH-1 — Module-size violations of project rule (>800 lines)

The project CLAUDE.md says "文件 < 800行" (file < 800 lines). Three files violate this:

| File | Lines | Why it's too big |
|---|---|---|
| `D:\Data\Desktop\obsidian-shared-memory-bus\bus\generate-embeddings.js` | 805 | `main()` (lines 613–786) does 5 things: load existing, compute reuse, group by batch, embed each batch, sort+write index. |
| `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\embedding-worker-pool.cjs` | 658 | Bootstrap script `buildWorkerScript()` is 145 lines (lines 446–591) of embedded Python with template-literal quoting hazards. |
| `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py` | 1367 | Includes a 200-line duplicated dense-score path (see CRIT-1), a 200-line `format_results`, and 60+ lines of regex patterns. |

**Suggested fix for `generate-embeddings.js`:** Split `main()` into:
1. `planRebuild()` — returns `{pending, reusable, orderedRecordIds}` (pure function, no I/O).
2. `runBatches(pending, runtime)` — handles batch loop and the per-batch `writeIndexSnapshot`.
3. `summarize(orderedRecords)` — the final `byTool` map and console output.

Each fits the 50-line rule. The `main()` then becomes 10 lines that orchestrate the three.

**Suggested fix for `embedding-worker-pool.cjs`:** Move the Python bootstrap script to `shared-mcp/embedding-worker-script.py` as a real file, and `fs.readFileSync` it at startup. The 145-line template literal is a quoting hazard waiting to happen (every embedded backslash triple-escapes — see lines 458–460).

---

### HIGH-2 — `main()` in `generate-embeddings.js` is 173 lines and writes the index 1 + N times

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\generate-embeddings.js`
- **Lines:** 613–786 (the `main()` function)

**Specific problems:**
1. `writeIndexSnapshot(orderedRecords)` is called once per batch (line 769) AND once after the loop (line 774) — so a 100-batch run does 101 full file rewrites. For a 10k-record index that's ~50–100 MB rewritten per batch, when 99 of those writes are immediately discarded.
2. `pending.slice(offset, offset + batchSize)` is fine, but the per-batch `Array.from(finalRecords.values()).sort((l, r) => l.id.localeCompare(r.id))` (line 768) is O(N log N) per batch — total O(N²) for the rebuild. With 10k records and batch 24, that's 416 batches × 10k log 10k ≈ 4.6M comparisons.
3. The "no records" early return at lines 699–714 duplicates the `writeIndexSnapshot` body for an empty file. Should call a shared `writeEmptyIndex()` helper.

**Suggested fix:** Sort once after all batches, write the file once at the end. If you need crash-safety mid-run, write to `${INDEX_FILE}.partial` and rename atomically at the end (you already have the pattern at line 561).

---

### HIGH-3 — `runBlackboardPython` and `runSemanticSearchOnce` re-spawn Python on every call instead of going through the long-lived search worker

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js` (lines 96–159), `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-bridge.js` (lines 200–236)
- **Pattern:** Both files contain a `spawnProcess(PYTHON.command, withPythonArgs(PYTHON, [SCRIPT, args]))` call that is used as the "fallback when the search worker is down" path.

**Why it's an issue:** The `omni-memory-server` already maintains a warm search worker subprocess (see `shared-mcp\metrics\compute.js` lines 395–472, `ensureSearchWorker`). When the worker is down (circuit open, init failure), these handlers go to a one-shot spawn — but the worker *starts* in the same call, so the one-shot path will be a slow cold start *and* race with the worker's startup. There's no clear ordering or single source of truth for "is the worker up?".

**Suggested fix:** Add a single `params.requestPython(script, args, timeoutMs)` that internally prefers the warm worker, falls back to a one-shot spawn, and exposes a `latencyMs` and `path: "worker" | "spawn"` so callers can see the cost. Delete the two duplicate `spawnProcess` helpers (one per file).

---

### HIGH-4 — `readWatchdogState` calls `isProcessAlive` and `isWatchdogSupervisorAlive` on every metrics scrape

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\source.js`
- **Function:** `readWatchdogState` (lines 58–95)
- **Hidden cost:** `isWatchdogSupervisorAlive` (in `omni-platform-helpers.js` line 251) runs two PowerShell probes that hit `Get-CimInstance Win32_Process` on every call (throttled only to a 3 s cache window).

**Why it's an issue:** The watchdog cache is module-level, but the per-call 3 s window means a 1 Hz Prometheus scrape still hits PowerShell on roughly 1-in-3 calls. With multiple concurrent scrapers or status checks, the throttle helps but the CIM queries are not free.

**Suggested fix:** Increase the cache TTL to ≥15 s (the watchdog polls every 15 s by default — see line 76) and make the read of the watchdog state itself async (`fs.promises.readFile`).

---

### HIGH-5 — `embedWithOpenAICompatible` retry loop has no `for…of`, and `AbortController` timeout can leak if `fetchImpl` returns synchronously

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\embedding-provider-registry.js`
- **Lines:** 302–400
- **Specific problems:**
  - On the `for` loop, `clearTimeout(timeout)` is called 5 times across the success/error paths. Three of those clears are duplicates; one is missing in the `try {` path that constructs the controller but throws before `clearTimeout(timeout)` (line 348–359, if the fetch itself throws *synchronously*, the controller's timeout fires after the throw and `clearTimeout` is never called).
  - The "retryable" check at line 391 (`error.message && (error.message.includes("429") || error.message.includes("5"))`) is string-matching on an error message that came from a generic `Error` or `DomainError` — a code change to the error message will silently disable retry.
  - The `lastError` variable is initialized to `undefined` and the function returns `throw lastError;` (line 399) — if all retries fail and `lastError` was never set (race with successful but malformed response), this throws `undefined`.

**Suggested fix:** Use `error.code` or a typed `DomainError` with `code === "HTTP_429"` / `code === "HTTP_5XX"` instead of message string matching. Move the `clearTimeout(timeout)` into a single `finally` block. Initialize `lastError = null` and re-raise explicitly with `if (!lastError) throw new Error("retries-exhausted-without-error")`.

---

### HIGH-6 — `bm25.js` `search()` is O(N × Q) per query with no early termination

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\bm25.js`
- **Lines:** 57–100
- **Specific issue:** Lines 88–93 — for every query term, the function iterates over *every* doc in `docs`, even if that doc has zero occurrences of the term. With N=10k docs and Q=20 unique tokens, that's 200k `dl[doc.id]` lookups and 200k `docTf[doc.id]` lookups per query. The `Object.entries(scores)` + `.sort()` at lines 96–99 is fine.

**Why it's an issue:** This is the local fallback BM25. It's called from `memory-retrieval.js` indirectly when dense fails. On a 10k-doc index this turns into 200k hashtable lookups per query. The Python BM25 path (rank_bm25) uses an inverted index and is much faster.

**Suggested fix:** Build an inverted index once at module load (when `docs` is first passed) keyed by `term → Set<docId>`. Reuse it across queries. The `search()` function then iterates `docs_in_query_index` only. If the docs change, the caller can opt to rebuild (e.g. via a separate `index = buildBm25Index(docs)` function).

---

### HIGH-7 — `embedWithGemini` / `embedWithTransformer` in the pool path read the same process env 4× per embed call

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\embedding-provider-registry.js`
- **Lines:** 67–96 and 187–216
- **Pattern:**
  ```js
  env: {
    ...process.env,
    TF_CPP_MIN_LOG_LEVEL: "3",
    TF_ENABLE_ONEDNN_OPTS: "0",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.http_proxy ? { http_proxy: process.env.http_proxy } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
  }
  ```
  This same `env` object literal appears 4 times in the file (lines 70–80, 87–95, 129–139, 192–200, 206–212). It's also passed twice on the pool path — once to `initPool` and once to `embedWithPool` (lines 70 and 87).

**Why it's an issue:** Spreading `process.env` builds a new object on every call. The proxy envs are read 4× per embed batch. With batch 24 and 100 batches, that's 400× `process.env` spreads for what is, functionally, 4 keys.

**Suggested fix:** Hoist the constant env fragment into a module-level `const PYTHON_WORKER_ENV = Object.freeze({...})` and spread it once. Build the final per-call env with a single spread. Also: pass it once into the pool, not twice — `initPool` and `embedWithPool` should share the same env ref.

---

### HIGH-8 — Tokenize is O(n²) due to `re.findall` on every call and `re.fullmatch` per candidate

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\bm25.js`
- **Lines:** 30–48
- **Specific issues:**
  - Line 35: `text.toLowerCase().replace(/[一-鿿…]/gu, " ")` — the regex includes the `\u{20000}-\u{2a6df}` range. That range covers CJK Extension B–F. Compiling the regex with the `u` flag works, but the `replace` over a 100k-character text is O(n) — fine — but then line 41 does `text.match(/[一-鿿㐀-䶿]/g)` which is a *second* full scan. Two full scans for what could be one.
  - The `for (let i = 0; i < cjk.length; i++)` bigram loop (lines 42–45) is O(n) but with `tokens.push(cjk[i] + cjk[i + 1])` per char, generating a string per char. For 50k characters of CJK, that's 100k string concatenations per `tokenize()` call.
  - `tokenize` is called once per doc per `search()` call (line 69). For 10k docs, 10k `tokenize` calls per query.

**Why it's an issue:** Same fallback path as HIGH-6. This is a 5–10× win on a single regex pass and avoiding the redundant `match`.

**Suggested fix:** Combine the CJK extraction into one regex with two named groups: `cjk: [cjk chars]`, `latin: [a-z0-9]+`. Match once, build both arrays from the single scan. Cache the tokenized form of each doc — when `search()` is called many times on the same docset, this is the largest CPU win available.

---

### HIGH-9 — `readEmbeddingRuntimeSummary` is called inside `handleMemoryStatus` even when not needed

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-status.js`
- **Lines:** 282–366, esp. line 301 `readEmbeddingRuntimeSummary()`
- **Specific issue:** `handleMemoryStatus` always reads the embedding runtime summary (which calls `resolveEmbeddingRuntime` → `loadRuntimeConfig` → `JSON.parse` of `runtime.json` if it exists). The runtime config is small and the parse is cheap, but the function calls `loadRuntimeConfig` *every time* without caching — so `/health` scraping triggers a `JSON.parse` of the file on every call.

**Suggested fix:** Add a `runtimeConfigCache` keyed by mtime+size. Same pattern as CRIT-2 — cheap to apply.

---

### HIGH-10 — `extractFieldTexts` mutates the field order in v2 entries which changes the embedding cache key

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\generate-embeddings.js`
- **Lines:** 226–259, 416–440
- **Specific issue:** `for (let i = 0; i < facts.length; i++) { ... fieldTexts[`fact_${i}`] = ... }` (line 423) and `for (let i = 0; i < concepts.length; i++) { ... }` (line 433). The field names use positional indices, so if a fact is inserted at the front of the array (or removed in the middle), *every* fact_N field key shifts by 1. That means even a benign edit invalidates the entire embedding cache for that record.

**Why it's an issue:** The whole "incremental reuse" path (line 649–660) is based on field-level hash equality. A re-ordering of facts invalidates the cache even when the *content* is unchanged, because the keys are positional, not content-addressed.

**Suggested fix:** Use content-hash-based keys, e.g. `fieldTexts[`fact:${hashFieldText(factText)}`] = ...`. Then the cache key is stable across re-orderings. Alternatively, just use the `record_id + fact_text_hash` as the cache key and stop relying on the index for stability.

---

## Medium-Severity Findings

### MED-1 — `handleSearchSharedMemory` duplicates parameter coercion between worker request and `runSemanticSearchOnce` fallback

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js`
- **Lines:** 183–267 (primary path) and 222–243 (fallback path)
- The exact same 14-line argument object (`tool`, `project`, `scope`, `sourceKind`, `workspace`, `taskState`, `preferSummaries`, `includeVerbatim`, `snippetWindow`, `maxVerbatimPerResult`) is built twice. If a new filter is added, both lists must be updated.

**Suggested fix:** Build the search params object once, then pass it to whichever path. Add a TypeScript or JSDoc `@typedef` for the search params so the field list is documented in one place.

---

### MED-2 — `loadTaskRecords` in `memory-status.js` returns either an array or a `{records, skippedCount, skippedLines}` object from the same function

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-status.js`
- **Lines:** 258–280
- Both callers (line 127, line 379) do `Array.isArray(result) ? result : (result.records || [])` to deal with the dual return type. The dual return is a `hasOwnProperty('records')` boolean hidden behind an array.

**Why it's an issue:** This is the "sometimes return array, sometimes return object" anti-pattern. If `taskFile` is missing, return `[]`. If it exists, return the array. The "skipped" information can be a separate optional `result.skippedLines` field that the caller chooses to read.

**Suggested fix:** Always return `{records, skippedLines: []}`. Update the two call sites to read `result.records`.

---

### MED-3 — `resolveStoreRootParam` in `memory-retrieval.js` has 7 parameter aliases for the same concept

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js`
- **Lines:** 41–65
- It checks `params.STORE_ROOT`, `params.MEMORY_STORE_ROOT`, `params.storeRoot`, `params.memoryStoreRoot`, `params.AI_MEMORY_STORE`, `params.AI_MEMORY_STORE_ROOT`, then falls through to canonical resolution, then falls back to `params.AI_MEMORY_ROOT`, `params.VAULT_ROOT`, `params.vaultRoot`, then `process.env.USERPROFILE`. That's 11 sources of truth, none documented.

**Suggested fix:** Pick one canonical parameter name and a single fallback chain. The "everything in the env" code should live in `bus/store-root.js`, not be inlined in every consumer.

---

### MED-4 — `embeddingProviderRegistry.get` silently falls back to `hash` for unknown adapters

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\embedding-provider-registry.js`
- **Lines:** 453–456
- `get(name) { ... return adapters[normalized] || adapters.hash; }` — if you typo `"tranformer"` in your config, you silently get the hash adapter and embeddings that don't match anything else. There's no warning, no log line, no error. (Compare to `normalizeEmbeddingAdapter` in `runtime-config.js` which *does* return the fallback but at least it's a string.)

**Suggested fix:** Add `console.warn` (or use the structured logger) on miss: `log.warn("embedding-adapter-miss", {requested: name, fallback: "hash"})`.

---

### MED-5 — `_ANN_INDEX_CACHE` in `search_index.py` is never invalidated by file mtime change

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_index.py`
- **Lines:** 392–454 (`build_ann_index`)
- The cache key is `_ANN_INDEX_CACHE["signature"]`, which is the embeddings signature. The signature *does* change with mtime+size (via `build_embeddings_signature`), so this is actually OK — but the cache is also rebuilt from scratch each time, which for a 10k×384-dim index is a 30 MB numpy allocation. If two `dense_scores` calls run in the same second and the signature hasn't changed, the cache should hit. It does. Good.
- **But:** lines 446–449 — `ann.add(matrix, list(range(len(entry_ids))))` uses positional integer labels, but `entry_ids` is built by filtering the records dict. If the embeddings file is being concurrently appended to (e.g. by a `rebuild_memory_embeddings` running in parallel), the iteration order of `records.items()` is dict-iteration-order, which *is* stable per process but breaks down across a reload. The positional labels will not match the next call's labels. The cache signature would catch the mtime change, so this is OK, but it's the kind of code that breaks if you change one piece.

**Suggested fix:** Add a brief comment near line 446 explaining the invariant: "labels are positional in `entry_ids`; cache invalidation by signature prevents cross-process drift." This is mostly a documentation fix.

---

### MED-6 — `resolvePowerShellCommand` in `omni-platform-helpers.js` runs `spawnSync` once per candidate to find `pwsh`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\omni-platform-helpers.js`
- **Lines:** 168–199
- The candidates are `["pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh"]`. For each, it spawns a `pwsh -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"` to check it works. On a Linux/macOS box with no `pwsh` installed, this is 3 spawns that all fail with "command not found" — but Node's `spawnSync` will block for the OS PATH search timeout on each. On macOS with a slow filesystem, this can be 1–3 seconds of startup latency.

**Suggested fix:** Use `fs.existsSync` first; if the file doesn't exist, skip. Only spawn if the file exists. Or, use `which` / `where` semantics to validate PATH lookups without a process spawn.

---

### MED-7 — `isWatchdogSupervisorAlive` re-runs both PowerShell probes on every check (cache throttles to 3 s)

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\omni-platform-helpers.js`
- **Lines:** 251–282
- The 3 s cache is module-level (`watchdogSupervisorCache` line 246), but `readWatchdogState` calls it on every metrics scrape. If 5 different MCP requests happen within a 3 s window, only the first triggers the PowerShell probe — good. But if requests spread across 4 s, you get 2 probes. With `/health` scrapes at 1 Hz, that's 2 of every 3 calls triggering a 2-probe PowerShell burst = 4 spawns every 3 s. That's expensive.

**Suggested fix:** Bump the cache TTL to match the watchdog poll interval (15 s, see source.js line 76). At 15 s TTL, the scrape only triggers a probe every 15 s, not every 3 s.

---

### MED-8 — `NoOp-fallback` for KnowledgeGraph in `loadKnowledgeGraph`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js`
- **Lines:** 487–508
- When the knowledge graph module fails to load, a no-op stub is constructed that *looks like* the real interface but returns empty data. The handler then does `if (kg.available === false) { return errorResult(...); }` — but the stub has `available` not set, so the property is `undefined`, not `false`. The check works because `!kg.available` is truthy for `undefined`, but the stub's `available` is missing on purpose, so the no-op stub path silently returns "no data" for a *real* failure.

**Suggested fix:** Set `kg.available = false` in the stub. Or simpler: in the catch, return `null` and have the handlers check `if (!kg) { return errorResult(...); }` instead of the duck-typed "is this a stub?" check.

---

### MED-9 — `embed_query` cache key ignores whitespace differences

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 389–396
- The cache key includes `normalize_spaces(query)` — good. But the actual key is `sha1(json.dumps(...))` over a dict that includes the query. Two queries `"foo"` and `" foo "` will normalize to the same key. Good. But `"foo bar"` and `"foo  bar"` (double space) also normalize to the same key. Good. Edge case: `"foo\tbar"` and `"foo\nbar"` — `normalize_spaces` collapses to `"foo bar"` for both. Good. **But** the cache key uses `ensure_ascii=False` and `sort_keys=True`. If two queries have different Unicode normalization (NFC vs NFD), they hash differently. Not necessarily wrong, but worth noting.

**Suggested fix:** Add a docstring note that queries are normalized via `normalize_spaces` and NFC before caching, so a NFD query will not hit the NFC cache.

---

### MED-10 — `parse_args` positional argument parsing is fragile

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\semantic_search.py`
- **Lines:** 588–649
- The function accepts `python semantic-search.py "query" [topK] [strategy]` as a legacy positional API, then tries to disambiguate based on whether the last arg is a digit and the second-to-last is too, or whether the last is a known mode name. This is "guess the user's intent" parsing layered on top of `argparse`. The result is that `python semantic-search.py 8 auto "what's the weather"` will parse as `mode="auto"`, `top_k=8`, `query="what's the weather"`, but `python semantic-search.py "8 auto what's the weather"` will parse the same way. The intent is fine, but the dual API (positional + argparse flags) is a maintenance liability.

**Suggested fix:** Drop the positional form. If you need a "10 30 hybrid" compact form, that's a separate command. Use argparse flags consistently.

---

## Low-Severity Findings

### LOW-1 — `loadStoreRootHelper` / `loadPythonRuntimeHelper` / etc. are essentially the same function repeated 5×

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\omni-handlers.js`
- **Lines:** 31–63
- Each loader is a 4-line `resolveRuntimePath + import(pathToFileURL(...).href)`. The 5 functions exist because they each resolve a different path, but the *body* is identical. They should be one parameterized function or a single map `{helperName: [filename, subpath]}` that the caller iterates.

---

### LOW-2 — `buildHandlerRegistry` iterates `Object.entries(source)` for 6 different sources, but `mcpMemoryHandlers` is from a different module

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\omni-handlers.js`
- **Lines:** 68–89
- The order of iteration is `[status, retrieval, generation, bridge, embeddings, mcpMemoryHandlers]`. If any of these sources have a handler with the same name (e.g. `memory_status` defined in both `status` and `mcpMemoryHandlers`), the *last one wins* with no warning. The `mcpMemoryHandlers` (loaded from `ops/mcp/mcp-memory-tools-handler.js`) is the silent override.

**Suggested fix:** Detect collisions and log a warning. Or fail-fast at startup with a clear error: "tool `X` defined in both `A` and `B`".

---

### LOW-3 — `pickTools` and `pickHandlers` are nearly identical (filter by name set)

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\tool-registry.js`
- **Lines:** 75–101
- The two functions do exactly the same filter operation, just on different collections. They could share an `indexByName` helper.

---

### LOW-4 — `RETRIEVAL_TOOLS` / `BRIDGE_TOOLS` / `DREAM_TOOLS` / `MGMT_TOOLS` are 4 parallel arrays that must be kept in sync with `TOOLS`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\tool-registry.js`
- **Lines:** 18–60
- The test `tests/unit/js/tool-registry.test.js` guards against the union being out of sync with `TOOLS`, but the *names* in each subset are still hand-written. A typo in `RETRIEVAL_TOOLS` would cause the test to pass (because the union is still equal) while silently excluding a tool.

**Suggested fix:** Define the subsets by filter predicates (`/read-only/i`, `/rebuild/i`, `/dream/i`) or by tag-on-tool (`tool.tag = "retrieval"`) and derive the subsets at startup. Currently the test is "does union == TOOLS" but a stronger test would be "does each subset contain the tools the docstring says it should".

---

### LOW-5 — `Cosine_similarity` has a `math.isfinite` guard that returns 0.0, but the same function in JS doesn't

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py` (lines 309–313) vs. `D:\Data\Desktop\obsidian-shared-memory-bus\bus\lsh-hash.js` (line 35 area, `buildHashEmbedding`)

**Why it's an issue:** The Python side guards against `NaN` / `Inf` polluting top-k with the comment *"Non-finite results must not leak downstream where `score <= 0` would treat NaN as a high score"*. The JS side does not have an equivalent guard. If a custom embedding provider returns `NaN` for one of its dimensions (e.g. overflow during `float` conversion), the JS `bm25.js` will compare `NaN > 0` (false) and silently drop the doc — but the dense path's `best_by_record` reduction will propagate the NaN.

**Suggested fix:** Mirror the Python guard in `lsh-hash.js` — `if (!Number.isFinite(value)) return 0.0` — or normalize the entire vector before storage.

---

### LOW-6 — `loadTaskRecords` is called twice in `buildWakeUpPack` and `handleGetMemoryOverview`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-status.js`
- **Lines:** 126 and 378
- Each call re-reads the same JSONL file. If both `memory_wake_up` and `get_memory_overview` are called in the same request batch, that's 2× the I/O.

**Suggested fix:** Pass the loaded records in as a parameter, or memoize by `mtime+size` of the task file.

---

### LOW-7 — `METRICS.search_latency_seconds` is shifted in place

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-retrieval.js`
- **Lines:** 254–258
- `if (params.METRICS.search_latency_seconds.length > 100) { params.METRICS.search_latency_seconds.shift(); }` — this is a manual ring buffer, but `Array.prototype.shift` is O(n). For 100 elements this is irrelevant; for a metrics endpoint hit 10×/s, it's still under 1 ms. Not a real bottleneck, but a true ring buffer (`new Float64Array(100)` with a write index) is faster and avoids garbage.

**Suggested fix:** Use a fixed-size circular buffer. Same for `search_worker.dream_lock_held_seconds` (length 20) and `search_latency_seconds` (length 100).

---

### LOW-8 — `format_results` calls `check_memory_drift` for every result, which calls `re.findall(FILE_REF_PATTERN, ...)` for every result

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\semantic_search.py`
- **Lines:** 478–490 (`check_memory_drift` calling `FILE_REF_PATTERN.findall(combined)`)
- `FILE_REF_PATTERN` (line 219) is a complex alternation regex: `r"([a-zA-Z][^\s:;#*`\"'<>|\\{}()\[\]]+\.(js|ts|py|ps1|sh|md|json|yaml|yml|toml|go|rs|java|cpp|c|h|css|html))"`. The character class `[^\s:;#*`"…]` is a negation of 13 characters — well-formed, but it can be slow on long inputs. With 10 results, this runs 10 times per query. Caching the compiled regex (Python caches it anyway, so this is mostly fine) and the result by `entry.id` would be the win.

**Suggested fix:** Add an LRU cache for `check_memory_drift` keyed by `entry.id` (which is already a stable hash).

---

### LOW-9 — `search_ranking.py` `keyword_overlap_scores` counts token matches with `sum(1 for token in entry.tokens if token in query_set)` — no early termination

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 279–286
- Iterates *all* of `entry.tokens` even after finding enough matches. For long documents (6000 chars ≈ 1000 tokens), this is 1000 hash lookups per entry per query.

**Suggested fix:** If `overlap > 5` and we only care about presence (`> 0`), break early.

---

### LOW-10 — `startMetricsServer` and `startMetricsRefreshInterval` are not awaited

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\server.js`
- **Lines:** 100 and 104
- The server `listen()` is called synchronously; errors are emitted asynchronously via the `error` event. `startMetricsServer` returns void. The caller in `omni-memory-server.js` (line 247) does `startMetricsServer({...})` and proceeds immediately. If port 9090 is in use, the bind error is logged but the caller doesn't know. The comment on line 91 says "Surface synchronously so callers awaiting a ready signal can react" but no ready signal is actually surfaced.

**Suggested fix:** Return a `Promise<void>` that resolves on the first `listening` event and rejects on `error`. The server bootstrap can then `await startMetricsServer(...)` and fail-fast on bind errors.

---

### LOW-11 — `mcp_requests_total` is keyed by tool name, but the metric is a single int — it doesn't distinguish success vs. error

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\compute.js`
- **Line:** 44–47
- Compare to `searches_total` (lines 39–43) which has `{ok, error}`. The MCP request counter is just `{tool: count}`. You can't tell from the metric which tools are erroring.

**Suggested fix:** Change to `mcp_requests_total[tool][status]` where status is `"ok"` or `"error"`. Bump the error counter in the catch block of `registerMcpRequestHandlers`.

---

### LOW-12 — `fileBasedCached` watch path uses `path.join` with hardcoded "00-System/ai-memory" legacy dir

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-status.js`
- **Lines:** 99
- `"00-System", "ai-memory"` is a magic path string. It's checked in `resolveStoreDir` as a fallback when the canonical dir doesn't exist. This couples the code to the historical Obsidian vault layout. If the user's vault moves, this lookup silently fails.

**Suggested fix:** Add a comment explaining the magic. Or move the legacy dir to a constant in `bus/time-constants.js`-style module (or a new `bus/vault-constants.js`).

---

### LOW-13 — `build_embedding_config_hash` in Python and JS use different normalization

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\embedding_providers.py` (line 47–59) and `D:\Data\Desktop\obsidian-shared-memory-bus\bus\shared-crypto.js` (line 28)
- The Python version uses `json.dumps(..., ensure_ascii=False, separators=(",", ":"))` and the JS version uses `JSON.stringify(...)` with no separator arg. Different output for the same input.

**Why it's an issue:** The `configHash` is supposed to be a stable identifier of the embedding configuration. If Python and JS produce different hashes for the same `{backend, model, baseUrl}`, the JS side will mark the embeddings index as "stale" even when it's actually current. The fix in `buildEmbeddingIndexState` is to compare via `preferredConfigHash` (JS) and `record_config_hash` (Python) on the two sides — but if they don't match, the JS side will rebuild an index that the Python side considers fresh, wasting hours of CPU.

**Suggested fix:** Make the hash function identical across both. Pin the JSON serialization to a specific form (separators, encoding). The Python `json.dumps(..., ensure_ascii=False, separators=(",", ":"))` is the more explicit choice — match it in JS with `JSON.stringify(payload, Object.keys(payload).sort()).replace(/":/g, '":').replace(/,"/g, ',"')` or by using a sorted-keys preprocessor.

---

### LOW-14 — `OMNI_HANDLERS.toolFilter` parameter is destructured but never used in this file

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\omni-handlers.js`
- **Lines:** 115–154 (`registerMcpRequestHandlers`)
- The function signature accepts `toolFilter` (line 115) and passes it to `pickTools` and `pickHandlers` (lines 116–117). Good. But the function declaration JSDoc on lines 105–114 says "新增 toolFilter 参数 (债项 #1 server-split)" — so this is for a future "split into 4 servers" feature, not currently active. The monolithic server still uses `toolFilter: undefined` (per line 210 of `omni-memory-server.js` where `registerMcpRequestHandlers(server, { ALL_HANDLERS, METRICS, log })` does not pass `toolFilter`).

**Suggested fix:** Either implement the split (which would be a big change) or remove the unused `toolFilter` parameter. Right now the code reads as "in-progress refactor" which makes the file harder to follow.

---

### LOW-15 — `streamingIndex` is loaded conditionally but the fallback isn't tested

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 39–66
- `try: from streaming_index import StreamingIndex; _STREAMING_INDEX_AVAILABLE = True; except ImportError: _STREAMING_INDEX_AVAILABLE = False`
- If `streaming_index.py` is missing, the code falls through to `_dense_scores_fallback`, which loads the *entire* embeddings index into memory (line 454: `index_records = load_embeddings_index()`). For a 100k-record index, that's hundreds of MB of RAM per search call. The streaming path exists to prevent this. There is no test that exercises the fallback path with a large index.

**Suggested fix:** Add a unit test that monkeypatches `StreamingIndex = None` and asserts that the fallback path produces the same results as the streaming path on a 1k-record index. If they diverge, that's a CRIT-1 bug.

---

## Type-Safety Findings

The project is pure JS (no `tsconfig.json`). All "types" are JSDoc.

### TYP-1 — `Promise<any>` and `(...any)` in `withTrace` / `traced`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\structured-logger.js`
- **Lines:** 158–196

**Suggested fix:** Either genericize with `@template T` or document the implicit `any` return more carefully. The `traced` helper returns `{traceId, result}` where `result` is `any` — make it `@template T` and return `{traceId: string, result: T}`.

---

### TYP-2 — `pendingRequests` Map in `embedding-worker-pool.cjs` uses `any` for the resolve value

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\embedding-worker-pool.cjs`
- **Line:** 50
- `Map<string, { resolve: (v: any) => void, ... }>`

**Suggested fix:** `resolve: (v: number[][]) => void` (since the pool only returns embeddings).

---

### TYP-3 — `METRICS` in `source.js` is implicitly typed as `any`

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\source.js`
- **Lines:** 38–52
- The object is defined as a literal; consumers access `METRICS.search_latency_seconds` etc. without IDE help. A typo (`search_latenct_seconds`) would be a silent `undefined`.

**Suggested fix:** Add a JSDoc `@typedef` for `Metrics` and use it as a `/** @type {Metrics} */` annotation on the const.

---

## Testing Gaps

### TEST-1 — `dense_scores` and `_dense_scores_fallback` have no parity test

- See CRIT-1. The two paths should produce identical scores on the same input. The test that would catch this is missing. A 100-line test (`dense_scores_equivalence.test.js` or `test_dense_scores_parity.py`) would catch future drift.

---

### TEST-2 — No test asserts that `refreshMetricsFromFiles` re-runs after the embeddings index mtime changes

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\source.js`
- **Lines:** 328–351
- The 60 s interval is set up, but no test exercises "write a new file, wait 60 s, see updated metrics". This is timing-dependent and would need a fake-timer test.

---

### TEST-3 — `circuit_breaker.py` tests don't exercise the slow-call ratio trip

- The "decay slow_call_count on success" path (lines 147–149) is correct but the test for `_check_slow_ratio` should verify that a series of slow successes (not failures) trips the circuit. If a slow-call ratio trip never gets exercised, the path can silently regress.

---

### TEST-4 — `search_ranking.py`'s `prune_timed_cache` has no max-entries behavior test

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 218–229
- The function does TTL pruning (lines 220–222) and then max-entries eviction by oldest (lines 224–229). Only the TTL path is tested. A test that fills 200 entries with `max_entries=50` and asserts the oldest 150 are evicted would catch off-by-one in the slice (`[: max(0, len(cache) - max_entries)]`).

---

### TEST-5 — `extract_verbatim_snippets` is a 80-line function with no edge case test

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\semantic_search.py`
- **Lines:** 370–451
- No test for: empty `query`, query that doesn't match any text, query with all matches at the end of the text, query with overlapping terms, `max_snippets=0`. The function is small enough that a focused test file would be <100 lines and would catch most future regressions.

---

## Memory / Resource Management

### MEM-1 — `searchWorker` in `compute.js` can be replaced by a new child without killing the old one

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\metrics\compute.js`
- **Lines:** 156–161 and 211–212 (`searchWorker = child;` on line 431)
- If `restartSearchWorker` is called twice in quick succession, the second call's `searchWorker = child` overwrites the first reference. The first child is still alive, still has open stdio handles, and will eventually exit. There's no double-kill guard.

**Suggested fix:** In `restartSearchWorker`, capture the old `searchWorker` reference and explicitly `await stopSearchWorker(oldChild)` before spawning the new one.

---

### MEM-2 — `embeddingWorkerPool._pool` is loaded with `require()` in an ESM context

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\embedding-provider-registry.js`
- **Lines:** 38–53
- `await getPool()` does `require("../shared-mcp/embedding-worker-pool.cjs")` inside an async function. If the file is loaded as ESM, this throws and the `try/catch` falls back to per-call spawn. The fallback to `require` in an ESM module is fragile; it works today only because the consumer (`bus/generate-embeddings.js`) is ESM but Node still allows `require` for CommonJS modules. If the project ever moves to `"type": "module"` in package.json, this breaks silently.

**Suggested fix:** Convert the pool to ESM (`embedding-worker-pool.mjs`) and use `import()`. Or wrap the require in a `createRequire(import.meta.url)` to make the resolution explicit.

---

### MEM-3 — `_SIGNATURE_MEMO` in `search_index.py` is unbounded in the 1 s TTL window

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_index.py`
- **Lines:** 117–128
- The TTL is 1 s, so the memo never grows large in practice. But the function never explicitly prunes the expired entries — they sit in the dict until next call. Under a high-rate ingest (1000 calls/s), the dict could hold up to 1000 × number-of-files entries. Not a leak, but worth a comment.

---

## Logging / Observability

### LOG-1 — `console.error` mixed with structured `log.warn` in the same file

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\generate-embeddings.js`
- **Lines:** 350, 394, 400, 404, 463, 533, 608, 693
- All these are `console.error` calls. The structured logger is in `shared-mcp/metrics/structured-logger.js` but is not used here. Since this file is a CLI tool (not the MCP server), `console.error` is actually correct — but the `[DEBUG]` prefix on lines 350, 394, 400, 404 is debug noise that should be gated by a `--verbose` flag, not always-on.

**Suggested fix:** Wrap the `[DEBUG]` lines in `if (process.env.AI_MEMORY_DEBUG) { ... }`. Or use a level-gated helper.

---

### LOG-2 — No request ID flows from MCP entry to handler to Python worker

- **Trace IDs are generated** in `omni-handlers.js` line 125 (`generateTraceId()`) and propagated via `withTrace`. But once the request is sent to the Python search worker via `requestSearchWorker(payload, timeoutMs)`, the trace ID is **not** included in the IPC payload. The Python side has no way to log with the same trace ID.

**Suggested fix:** Add a `traceId` field to the IPC payload at line 502 of `compute.js` (`{ id: requestId, traceId, ...payload }`). Have `search_server.py` extract it and prefix all its logs.

---

### LOG-3 — `python-worker-stderr` and `python-embedding-worker` and `[gemini] url:` all go to `process.stderr` directly

- **Files:** `bus/embedding-provider-registry.js` (lines 148, 281), `shared-mcp/embedding-worker-pool.cjs` (line 164)
- These bypass the structured logger entirely. The Python `stderr` from the worker includes URLs, model IDs, and partial payloads that may contain PII or secrets. The redaction in `embedding_providers.py` (line 27, `_redact_secrets`) is on the Python side, but the Node side at line 281 has no redaction — it just forwards raw stderr.

**Suggested fix:** Run stderr lines through a `_redactSecrets(text)` helper on the Node side too, before logging. The Python-side regex pattern (`[?&](api[_-]?key|key|access_token|sig)=...`) is a good starting point.

---

## Documentation Drift

### DOC-1 — `memory-tools.js` `TOOLS` is a 569-line list of MCP tool definitions; the descriptions are clear but the parameter docs are inconsistent

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\shared-mcp\memory-tools.js`
- Some tools use `min`/`max` constraints (`refine_memory_selection` has `maxItems: 50` on line 146), some don't (`memory_search` has no max). Some use both `tool_filter` and `project` (string), some use the same name with different semantics across tools. This is a documentation consistency issue, not a code issue — but the *consumers* (the `handle*` functions in `memory-retrieval.js`) don't all read the same parameter name. E.g. `handleSearchByEntity` reads `args.entity_query` (line 535) but `handleQueryKg` reads `args.query` (line 609). The schema says `entity_query` is required for `search_by_entity` and `query` for `query_kg`, so this is correct — but a reader looking at both handlers side by side will be confused.

**Suggested fix:** Add a per-tool example invocation at the top of each TOOL entry. Or extract the `args.*` reads into a `coerceSearchArgs(args)` helper that documents the mapping in one place.

---

### DOC-2 — `runtime-config.js` `resolveEmbeddingRuntime` JSDoc does not document the env-var precedence

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\bus\runtime-config.js`
- **Lines:** 243–367
- The function reads 10+ env vars in a specific order (env override → process env → config file → defaults). The order is implicit in the code, not documented. The comment on lines 301–306 explains one specific case but not the general algorithm.

**Suggested fix:** Add a JSDoc block with the precedence list as a comment. Better: extract the precedence chain to a small `const PRECEDENCE = [...]` array and a loop that iterates it.

---

### DOC-3 — `search_ranking.py` `_STRUCTURED_FILES_FALLBACK` has a comment that contradicts the code

- **File:** `D:\Data\Desktop\obsidian-shared-memory-bus\retrieval\search_ranking.py`
- **Lines:** 109–123
- The comment says *"Canonical structured-file list lives in `shared/structured-files.json` (single source shared with `ops/memory/memory-archival.js`). Loaded at import with a literal fallback so `retrieval/` still works standalone if the JSON is absent."* But the file referenced (`shared/structured-files.json`) is loaded via relative path `os.path.join(_here, "..", "shared", "structured-files.json")` (line 129). If the project is run from a different cwd or if the `shared/` directory is symlinked, the relative path resolution will fail and the fallback will kick in. The fallback includes `openclaw-*.jsonl` (lines 119–122) which may not exist in newer projects.

**Suggested fix:** Add a startup warning when the fallback is used. Or better: fail-fast on missing canonical list with a clear error, since silently using a stale fallback list is dangerous.

---

## Summary Table

| ID | Severity | File | One-line |
|---|---|---|---|
| CRIT-1 | Critical | `retrieval/search_ranking.py` 418–642 | Two near-identical dense-score functions maintained by hand |
| CRIT-2 | Critical | `shared-mcp/metrics/source.js` 98–170 | `readEmbeddingsSummary` re-reads+re-parses entire index on every metrics scrape |
| CRIT-3 | Critical | `shared-mcp/memory-retrieval.js` 278–458 | `handleRefineMemorySelection` silently degrades to "first N by original order" on any error |
| CRIT-4 | Critical | `bus/embedding-provider-registry.js` 110–171 | Per-call Python spawn fallback costs ~5s × N when transformer unavailable |
| HIGH-1 | High | (3 files) | Module-size violations: 805, 658, 1367 lines |
| HIGH-2 | High | `bus/generate-embeddings.js` 613–786 | `main()` is 173 lines, rewrites index 1+N times, O(N²) sort |
| HIGH-3 | High | `shared-mcp/memory-retrieval.js` + `memory-bridge.js` | Two duplicate `spawnProcess` helpers; no shared "use worker or spawn" path |
| HIGH-4 | High | `shared-mcp/metrics/source.js` 58–95 | `readWatchdogState` triggers PowerShell probes via `isWatchdogSupervisorAlive` |
| HIGH-5 | High | `bus/embedding-provider-registry.js` 302–400 | OpenAI retry loop: leak-prone timeout cleanup, string-match retry detection, `throw undefined` on edge case |
| HIGH-6 | High | `bus/bm25.js` 57–100 | BM25 search is O(N×Q) with no inverted index |
| HIGH-7 | High | `bus/embedding-provider-registry.js` 67–212 | Same env-object literal repeated 4×; spreads `process.env` 4× per call |
| HIGH-8 | High | `bus/bm25.js` 30–48 | Tokenize does two full scans + 100k string concats per call |
| HIGH-9 | High | `shared-mcp/memory-status.js` 301 | `readEmbeddingRuntimeSummary` re-parses `runtime.json` on every status call |
| HIGH-10 | High | `bus/generate-embeddings.js` 423, 433 | Positional field keys (`fact_0`, `fact_1`) invalidate embedding cache on re-order |
| MED-1 | Medium | `shared-mcp/memory-retrieval.js` 183–243 | Search args coerced twice in primary + fallback path |
| MED-2 | Medium | `shared-mcp/memory-status.js` 258–280 | `loadTaskRecords` returns array or object; callers must disambiguate |
| MED-3 | Medium | `shared-mcp/memory-retrieval.js` 41–65 | `resolveStoreRootParam` checks 11 source aliases in undocumented priority |
| MED-4 | Medium | `bus/embedding-provider-registry.js` 453–456 | `get(name)` silently falls back to `hash` for unknown adapter names |
| MED-5 | Medium | `retrieval/search_index.py` 446–449 | Positional ANN labels depend on dict-iteration-order stability |
| MED-6 | Medium | `shared-mcp/omni-platform-helpers.js` 168–199 | `resolvePowerShellCommand` spawns 3 probes without `fs.existsSync` short-circuit |
| MED-7 | Medium | `shared-mcp/omni-platform-helpers.js` 251–282 | Watchdog supervisor cache TTL is 3 s, scrapers trigger PowerShell too often |
| MED-8 | Medium | `shared-mcp/memory-retrieval.js` 487–508 | KnowledgeGraph no-op stub has `available: undefined`, not `false` |
| MED-9 | Medium | `retrieval/search_ranking.py` 389–396 | Query-embedding cache key doesn't normalize Unicode (NFC/NFD) |
| MED-10 | Medium | `retrieval/semantic_search.py` 588–649 | `parse_args` mixes positional + argparse in ambiguous ways |
| LOW-1 | Low | `shared-mcp/omni-handlers.js` 31–63 | 5 nearly identical `load*Helper` functions |
| LOW-2 | Low | `shared-mcp/omni-handlers.js` 68–89 | Handler name collisions silently overwritten, no warning |
| LOW-3 | Low | `shared-mcp/tool-registry.js` 75–101 | `pickTools` and `pickHandlers` are duplicates |
| LOW-4 | Low | `shared-mcp/tool-registry.js` 18–60 | 4 tool-subset arrays maintained by hand |
| LOW-5 | Low | `bus/lsh-hash.js` vs. `retrieval/search_ranking.py` 309–313 | Cosine NaN-guard in Python, not in JS |
| LOW-6 | Low | `shared-mcp/memory-status.js` 126, 378 | `loadTaskRecords` called twice per status call |
| LOW-7 | Low | `shared-mcp/memory-retrieval.js` 254–258 | Manual ring buffer via `Array.shift` is O(n) |
| LOW-8 | Low | `retrieval/semantic_search.py` 478–490 | `FILE_REF_PATTERN` re-compiles per result; not memoized |
| LOW-9 | Low | `retrieval/search_ranking.py` 279–286 | `keyword_overlap_scores` doesn't short-circuit |
| LOW-10 | Low | `shared-mcp/metrics/server.js` 100 | `startMetricsServer` doesn't surface bind errors to caller |
| LOW-11 | Low | `shared-mcp/metrics/compute.js` 44–47 | `mcp_requests_total` doesn't distinguish success from error |
| LOW-12 | Low | `shared-mcp/memory-status.js` 99 | Hardcoded "00-System/ai-memory" legacy dir path |
| LOW-13 | Low | Python vs. JS `build_embedding_config_hash` | Different JSON serialization → mismatched cross-language hashes |
| LOW-14 | Low | `shared-mcp/omni-handlers.js` 115 | `toolFilter` parameter is for a future refactor that isn't done |
| LOW-15 | Low | `retrieval/search_ranking.py` 39–66 | `streamingIndex` fallback path is untested at scale |
| TYP-1 | Low | `shared-mcp/metrics/structured-logger.js` 158–196 | `Promise<any>` in `traced`/`withTrace` should be generic |
| TYP-2 | Low | `shared-mcp/embedding-worker-pool.cjs` 50 | `resolve: (v: any) => void` should be `number[][]` |
| TYP-3 | Low | `shared-mcp/metrics/source.js` 38–52 | `METRICS` object has no `@typedef` |
| TEST-1 | High | (missing) | No parity test for `dense_scores` vs. `_dense_scores_fallback` |
| TEST-2 | Medium | (missing) | No test for `refreshMetricsFromFiles` re-run on mtime change |
| TEST-3 | Medium | (missing) | `circuit_breaker.py` slow-call ratio trip is not tested |
| TEST-4 | Medium | (missing) | `prune_timed_cache` max-entries path is not tested |
| TEST-5 | Medium | (missing) | `extract_verbatim_snippets` edge cases (empty, no match) are not tested |
| MEM-1 | Medium | `shared-mcp/metrics/compute.js` 156, 211 | `searchWorker` reassignment can orphan previous child |
| MEM-2 | Medium | `bus/embedding-provider-registry.js` 38–53 | `require()` of CJS pool in ESM context is fragile |
| MEM-3 | Low | `retrieval/search_index.py` 117–128 | `_SIGNATURE_MEMO` never explicitly prunes expired entries |
| LOG-1 | Medium | `bus/generate-embeddings.js` 350, 394, 400, 404, 463, 533, 608, 693 | `console.error` mixed with structured logger; `[DEBUG]` always-on |
| LOG-2 | High | `shared-mcp/metrics/compute.js` 502 | Trace ID not propagated to Python worker IPC payload |
| LOG-3 | High | `bus/embedding-provider-registry.js` 148, 281 | Python stderr forwarded without secret redaction |
| DOC-1 | Low | `shared-mcp/memory-tools.js` | Tool parameter docs inconsistent; consumers read different names per tool |
| DOC-2 | Low | `bus/runtime-config.js` 243–367 | `resolveEmbeddingRuntime` env-var precedence not documented |
| DOC-3 | Medium | `retrieval/search_ranking.py` 109–123 | `_STRUCTURED_FILES_FALLBACK` comment says "single source" but relative path is fragile |

---

## Recommended Triage Order

1. **CRIT-1** — extract a shared `_resolve_query_runtime` helper, kill the duplicate code path. Half-day work, prevents future production bugs.
2. **CRIT-3** — add `degraded: true` and `reason` to the `refine_memory_selection` fallbacks. One-hour change, makes the silent failure visible.
3. **CRIT-4** — change "per-call spawn" fallback to "fall back to hash adapter". One-hour change, removes 5s+ tail latency.
4. **HIGH-2** — write index once at end, not N+1 times. One-hour change, 10–100× faster rebuilds.
5. **HIGH-6 + HIGH-8** — add an inverted index and single-pass tokenization to `bus/bm25.js`. Two-hour change, 5–10× faster fallback search.
6. **CRIT-2 + HIGH-9** — add mtime-keyed cache for `readEmbeddingsSummary` and `readEmbeddingRuntimeSummary`. One-hour change, eliminates per-scrape full-file reads.
7. **TEST-1** — write the `dense_scores` vs `_dense_scores_fallback` parity test. Half-day; the test is the actual fix because the two paths are too easy to drift.
8. **LOG-2 + LOG-3** — propagate trace ID to Python; redact secrets from Node-side stderr forwarding. Half-day.
9. **HIGH-1** — split `bus/generate-embeddings.js` and `retrieval/search_ranking.py` into smaller modules. One day each.
10. Everything else: 2–3 days of cleanup that takes the codebase from "good" to "maintainable long-term".
