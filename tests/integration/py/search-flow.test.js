/**
 * tests/integration/py/search-flow.test.js
 * ========================================
 * Integration tests for the Python retrieval/search flow.
 *
 * Scenarios:
 *   1. semantic-search.py CLI mode with --json outputs valid JSON to stdout
 *   2. --server mode starts without throwing (brief startup test)
 *   3. retrieval/lsh_utils can be imported as a standalone module
 *   4. retrieval/schema_validation can be imported as a standalone module
 *   5. retrieval/embedding_providers can be imported (with minimal runtime_support stub)
 *
 * Python 3.11+ is required for the full semantic-search.py pipeline
 * (retrieval/platform.py uses starred-expressions-in-tuple syntax added in 3.11).
 * Tests that depend on full platform support are skipped when Python < 3.11.
 * Submodule import tests (lsh_utils, schema_validation) run regardless.
 *
 * Run with: node --test tests/integration/py/search-flow.test.js
 */

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRIEVAL_DIR = path.resolve(__dirname, "../../../retrieval");
const SEMANTIC_SEARCH_PY = path.join(RETRIEVAL_DIR, "semantic_search.py");
const PYTHON_MIN_VERSION = [3, 11];

function resolvePythonRuntime() {
  const candidates = [
    { command: process.env.AI_MEMORY_PYTHON, argsPrefix: [] },
    { command: process.env.PYTHON_EXE, argsPrefix: [] },
    { command: process.env.PYTHON, argsPrefix: [] },
    { command: "python", argsPrefix: [] },
    { command: "python3", argsPrefix: [] },
    ...(process.platform === "win32"
      ? [
          { command: "py", argsPrefix: ["-3"] },
          { command: "py", argsPrefix: [] },
        ]
      : []),
  ].filter((candidate) => candidate.command);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.argsPrefix, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return { command: "python", argsPrefix: [], missing: true };
}

const PYTHON = resolvePythonRuntime();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if Python version meets minimum requirement.
 * @returns {Promise<{ ok: boolean, version: string, reason?: string }>}
 */
async function checkPythonVersion() {
  return new Promise((resolve) => {
    if (PYTHON.missing) {
      resolve({ ok: false, version: "not found", reason: "python-not-found" });
      return;
    }

    const child = spawn(PYTHON.command, [...PYTHON.argsPrefix, "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", d => { stdout += d; });
    child.on("error", err => {
      resolve({ ok: false, version: "not found", reason: err.message });
    });
    child.on("close", () => {
      const versionStr = stdout.trim();
      const parts = versionStr.split(".").map(Number);
      const major = parts[0] || 0;
      const minor = parts[1] || 0;
      const meets = major > PYTHON_MIN_VERSION[0] ||
        (major === PYTHON_MIN_VERSION[0] && minor >= PYTHON_MIN_VERSION[1]);
      resolve({ ok: meets, version: versionStr });
    });
  });
}

/**
 * Run semantic-search.py and collect stdout/stderr.
 * @param {string[]} args
 * @param {object} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runSearchScript(args, env = {}) {
  return new Promise((resolve) => {
    if (PYTHON.missing) {
      resolve({ code: 127, stdout: "", stderr: "Python runtime not found" });
      return;
    }

    const child = spawn(PYTHON.command, [...PYTHON.argsPrefix, ...args], {
      cwd: path.dirname(SEMANTIC_SEARCH_PY),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => resolve({ code: 127, stdout, stderr: err.message }));
    child.on("close", code => resolve({ code: code || 0, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Tests: Submodule imports (always run)
// ---------------------------------------------------------------------------

describe("search flow — Python submodule imports", () => {

  test("retrieval/lsh_utils can be imported independently", async () => {
    const result = await runSearchScript([
      "-c",
      `
import sys
sys.path.insert(0, ${JSON.stringify(RETRIEVAL_DIR)})
from lsh_utils import HASH_DIM, VECTOR_SCHEMA_VERSION, build_hash_embedding, fnv1a32
print("HASH_DIM:", HASH_DIM)
print("VECTOR_SCHEMA_VERSION:", VECTOR_SCHEMA_VERSION)
print("fnv1a32 ok:", callable(fnv1a32))
print("build_hash_embedding ok:", callable(build_hash_embedding))
      `,
    ]);
    assert.strictEqual(
      result.code, 0,
      `lsh_utils import failed (exit ${result.code}):\n${result.stderr}`
    );
    assert.ok(result.stdout.includes("VECTOR_SCHEMA_VERSION: 1"), "VECTOR_SCHEMA_VERSION should be 1");
    assert.ok(result.stdout.includes("HASH_DIM:"), "HASH_DIM should be exported");
  });

  test("retrieval/schema_validation can be imported independently", async () => {
    const result = await runSearchScript([
      "-c",
      `
import sys
sys.path.insert(0, ${JSON.stringify(RETRIEVAL_DIR)})
from schema_validation import validate_record
print("validate_record ok:", callable(validate_record))
      `,
    ]);
    assert.strictEqual(
      result.code, 0,
      `schema_validation import failed (exit ${result.code}):\n${result.stderr}`
    );
    assert.ok(result.stdout.includes("validate_record ok: True"), "validate_record should be callable");
  });

  test("retrieval/embedding_providers can be imported with minimal runtime_support stub", async () => {
    const result = await runSearchScript([
      "-c",
      `
import sys
sys.path.insert(0, ${JSON.stringify(RETRIEVAL_DIR)})

# Stub runtime_support before embedding_providers imports it
class _FakeRS:
    @staticmethod
    def normalize_embedding_adapter(adapter, model_name=''):
        return adapter
sys.modules['runtime_support'] = _FakeRS()

from embedding_providers import HASH_MODEL, DEFAULT_MODEL, build_embedding_config_hash
print("HASH_MODEL:", HASH_MODEL)
print("DEFAULT_MODEL:", DEFAULT_MODEL)
print("build_embedding_config_hash ok:", callable(build_embedding_config_hash))
      `,
    ]);
    assert.strictEqual(
      result.code, 0,
      `embedding_providers import failed (exit ${result.code}):\n${result.stderr}`
    );
    assert.ok(result.stdout.includes("HASH_MODEL: hashing-v1"), "HASH_MODEL should be 'hashing-v1'");
    assert.ok(result.stdout.includes("DEFAULT_MODEL: all-MiniLM-L6-v2"), "DEFAULT_MODEL should be set");
  });
});

// ---------------------------------------------------------------------------
// Tests: Full semantic-search.py pipeline (requires Python 3.11+)
// ---------------------------------------------------------------------------

describe("search flow — semantic-search.py CLI pipeline", () => {

  test("CLI --json mode outputs valid JSON to stdout (skipped if Python < 3.11)", async () => {
    const versionCheck = await checkPythonVersion();
    if (!versionCheck.ok) {
      // Not a failure — skip gracefully
      console.log(
        `[SKIP] semantic-search.py requires Python ${PYTHON_MIN_VERSION.join(".")}+ ` +
        `(found ${versionCheck.version}). ` +
        `Full CLI test skipped — run on Python 3.11+ to exercise.`
      );
      return;
    }

    // Run with an empty query to get JSON output (schema/usage info)
    // --json forces JSON output even on empty query
    const result = await runSearchScript([
      SEMANTIC_SEARCH_PY,
      "--json",
      "test integration query",
    ]);

    // Exit code 0 is expected (script should handle missing data gracefully)
    // Exit code 1 is acceptable (no index found) — both are valid JSON outputs
    assert.ok(
      result.code === 0 || result.code === 1,
      `Expected exit 0 or 1, got ${result.code}.\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`
    );

    // stdout must be parseable as JSON (the --json flag guarantees this)
    try {
      JSON.parse(result.stdout.trim());
    } catch (e) {
      assert.fail(
        `--json output was not valid JSON:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`
      );
    }
  });

  test("--server mode starts without throwing (skipped if Python < 3.11)", async () => {
    const versionCheck = await checkPythonVersion();
    if (!versionCheck.ok) {
      console.log(
        `[SKIP] --server mode requires Python ${PYTHON_MIN_VERSION.join(".")}+ ` +
        `(found ${versionCheck.version}). Skipped.`
      );
      return;
    }

    // Start server and kill it after 1.5s — we're testing startup only
    const child = spawn(PYTHON.command, [...PYTHON.argsPrefix, SEMANTIC_SEARCH_PY, "--server"], {
      cwd: path.dirname(SEMANTIC_SEARCH_PY),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });

    // Give it 1.5s to start — then kill it
    const code = await new Promise(resolve => {
      setTimeout(() => {
        child.kill();
        setTimeout(() => resolve(-1), 500);  // give process time to clean up
      }, 1500);
    });

    // Server should have started without throwing a Python traceback
    const hasTraceback = stderr.includes("Traceback");
    assert.ok(
      !hasTraceback,
      `--server mode threw an exception during startup:\n${stderr}`
    );
  });
});
