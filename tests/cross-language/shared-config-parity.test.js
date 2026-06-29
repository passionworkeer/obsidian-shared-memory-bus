/**
 * Cross-language parity for JS↔Python shared configuration.
 *
 * #8  structured-file list — canonical source shared/structured-files.json,
 *     consumed by ops/memory/memory-archival.js (JS) and
 *     retrieval/search_ranking.py STRUCTURED_FILES (Python).
 * #15 embedding-adapter aliases — bus/runtime-config.js (JS) and
 *     retrieval/runtime_support.py (Python) must canonicalize the same
 *     alias set identically.
 *
 * A future edit to one side without the other is caught here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SHARED_JSON = path.join(PROJECT_ROOT, "shared", "structured-files.json");
const PY_MOD = path.join(PROJECT_ROOT, "retrieval").replace(/\\/g, "/");

function resolvePython() {
  const candidates = [
    process.env.AI_MEMORY_PYTHON,
    process.env.PYTHON_EXE,
    process.env.PYTHON,
    "python",
    "python3",
    ...(process.platform === "win32" ? ["py"] : []),
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  return "python";
}

function runPython(code) {
  const py = resolvePython();
  const r = spawnSync(py, ["-c", code], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`Python failed (exit ${r.status}): ${r.stderr || r.error?.message}`);
  }
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// #8 — structured-file list parity
// ---------------------------------------------------------------------------

test("#8 Python STRUCTURED_FILES equals shared/structured-files.json", () => {
  const json = JSON.parse(fs.readFileSync(SHARED_JSON, "utf8"));
  const out = runPython(
    `import sys,json; sys.path.insert(0,'${PY_MOD}'); from search_ranking import STRUCTURED_FILES; print(json.dumps(list(STRUCTURED_FILES)))`
  );
  const pyList = JSON.parse(out);
  assert.deepEqual(
    pyList,
    json.files,
    "Python STRUCTURED_FILES must equal the shared JSON single source"
  );
  assert.equal(pyList.length, 10);
});

// ---------------------------------------------------------------------------
// #15 — embedding-adapter alias parity
// ---------------------------------------------------------------------------

const { normalizeEmbeddingAdapter } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "bus/runtime-config.js"))
);

const ADAPTER_INPUTS = [
  "hash",
  "hashing",
  "transformer",
  "sentence-transformer",
  "sentence-transformers",
  "openai",
  "openai-compatible",
  "gemini",
  "huggingface",
  "HASH",
  "OpenAI",
  "Gemini",
];

test("#15 JS and Python canonicalize adapter aliases identically", () => {
  const out = runPython(
    `import sys,json; sys.path.insert(0,'${PY_MOD}'); from runtime_support import normalize_embedding_adapter; print(json.dumps([normalize_embedding_adapter(x) for x in ${JSON.stringify(ADAPTER_INPUTS)}]))`
  );
  const pyOut = JSON.parse(out);
  for (let i = 0; i < ADAPTER_INPUTS.length; i++) {
    const jsOut = normalizeEmbeddingAdapter(ADAPTER_INPUTS[i]);
    assert.equal(
      jsOut,
      pyOut[i],
      `adapter mismatch for '${ADAPTER_INPUTS[i]}': js='${jsOut}' py='${pyOut[i]}'`
    );
  }
});
