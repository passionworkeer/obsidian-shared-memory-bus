/**
 * Cross-language LSH equivalence tests.
 *
 * Tests that bus/lsh-hash.js (Node.js) and retrieval/lsh_utils.py (Python)
 * produce identical outputs for the FNV-1a32 LSH feature extraction algorithm.
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

// Resolve retrieval module path relative to test file (portable)
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PYTHON_MODULE_PATH = path.join(PROJECT_ROOT, "retrieval").replace(/\\/g, "/");

// Load the JS implementation directly
const {
  normalizeSpaces,
  fnv1a32,
  buildHashFeatures,
  buildHashEmbedding,
} = require("../../bus/lsh-hash.js");

/**
 * Run a Python function via subprocess and return the parsed JSON result.
 * @param {string} pythonCode - Python code to execute
 * @returns {object} Parsed JSON result
 */
function runPython(pythonCode) {
  const fullCode = `
import sys, json
sys.path.insert(0, '${PYTHON_MODULE_PATH}')
${pythonCode}
`;
  // Python executable: try known paths first, then PATH-resolved
  const PYTHON_EXE = (() => {
    if (process.platform === "win32") {
      // Try common installations first
      const candidates = [
        "D:/python/python.exe",
        "C:/python/python.exe",
        "py",
        "python",
      ];
      for (const cand of candidates) {
        const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
        if (r && r.status === 0) return cand;
      }
      return "python3";
    }
    const r3 = spawnSync("python3", ["--version"], { encoding: "utf8" });
    return r3.status === 0 ? "python3" : "python";
  })();
  const result = spawnSync(PYTHON_EXE, ["-c", fullCode], {
    encoding: "utf8",
    timeout: 10000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr || "";
    const errorMsg = stderr ? `\nPython stderr: ${stderr}` : "";
    throw new Error(
      `Python subprocess failed with exit code ${result.status}.${errorMsg}`
    );
  }

  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    throw new Error(
      `Failed to parse Python output as JSON: ${result.stdout}\nError: ${e.message}`
    );
  }
}

/**
 * Normalize an array for comparison (handles floating-point epsilon).
 * @param {any} value
 * @returns {any}
 */
function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === "number" && !Number.isInteger(v)) {
        return Number(v.toFixed(8));
      }
      return normalizeForCompare(v);
    });
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value)) {
      normalized[key] = normalizeForCompare(value[key]);
    }
    return normalized;
  }
  return value;
}

// ---------------------------------------------------------------------------
// normalizeSpaces tests
// ---------------------------------------------------------------------------

describe("normalizeSpaces", () => {
  test("JS vs Python: 'hello world' produces identical output", () => {
    const input = "hello world";
    const jsResult = normalizeSpaces(input);

    const pyResult = runPython(`
from lsh_utils import normalize_spaces
print(json.dumps(normalize_spaces("${input}")))
    `);

    assert.strictEqual(jsResult, pyResult);
  });

  test("JS vs Python: '  spaced  ' produces identical output", () => {
    const input = "  spaced  ";
    const jsResult = normalizeSpaces(input);

    const pyResult = runPython(`
from lsh_utils import normalize_spaces
print(json.dumps(normalize_spaces("${input}")))
    `);

    assert.strictEqual(jsResult, pyResult);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 tests
// ---------------------------------------------------------------------------

describe("fnv1a32", () => {
  test("JS vs Python: 'hello' produces identical unsigned 32-bit integer", () => {
    const input = "hello";
    const jsResult = fnv1a32(input);

    const pyResult = runPython(`
from lsh_utils import fnv1a32
print(json.dumps(fnv1a32("${input}")))
    `);

    // Both must be unsigned 32-bit integers with the same value
    assert.strictEqual(typeof jsResult, "number");
    assert.strictEqual(jsResult >>> 0, jsResult); // unsigned
    assert.strictEqual(pyResult >>> 0, pyResult); // unsigned
    assert.strictEqual(jsResult, pyResult);
  });
});

// ---------------------------------------------------------------------------
// buildHashFeatures tests
// ---------------------------------------------------------------------------

describe("buildHashFeatures", () => {
  test("JS vs Python: 'hello world' produces identical feature arrays", () => {
    const input = "hello world";
    const jsResult = buildHashFeatures(input).sort();

    const pyResult = runPython(`
from lsh_utils import build_hash_features
print(json.dumps(build_hash_features("${input}")))
    `);

    const sortedPyResult = Array.isArray(pyResult) ? pyResult.sort() : [];
    assert.deepStrictEqual(jsResult, sortedPyResult);
  });

  test("JS vs Python: '中文测试' (CJK) produces identical feature arrays", () => {
    const input = "中文测试";
    const jsResult = buildHashFeatures(input).sort();

    const pyResult = runPython(`
# -*- coding: utf-8 -*-
import sys, json
sys.path.insert(0, '${PYTHON_MODULE_PATH}')
from lsh_utils import build_hash_features
print(json.dumps(build_hash_features("中文测试")))
    `);

    const sortedPyResult = Array.isArray(pyResult) ? pyResult.sort() : [];
    assert.deepStrictEqual(jsResult, sortedPyResult);
  });

  test("JS vs Python: URL 'https://example.com/path' produces identical feature arrays", () => {
    const input = "https://example.com/path";
    const jsResult = buildHashFeatures(input).sort();

    const pyResult = runPython(`
from lsh_utils import build_hash_features
print(json.dumps(build_hash_features("https://example.com/path")))
    `);

    const sortedPyResult = Array.isArray(pyResult) ? pyResult.sort() : [];
    assert.deepStrictEqual(jsResult, sortedPyResult);
  });
});

// ---------------------------------------------------------------------------
// buildHashEmbedding tests
// ---------------------------------------------------------------------------

describe("buildHashEmbedding", () => {
  test("JS vs Python: dimension 384 produces vectors within epsilon 1e-6", () => {
    const input = "hello world test embedding";
    const dimension = 384;

    const jsResult = buildHashEmbedding(input, dimension);
    const normalizedJs = normalizeForCompare(jsResult);

    const pyResult = runPython(`
from lsh_utils import build_hash_embedding
print(json.dumps(build_hash_embedding("hello world test embedding", 384)))
    `);
    const normalizedPy = normalizeForCompare(pyResult);

    assert.strictEqual(normalizedJs.length, normalizedPy.length);
    for (let i = 0; i < normalizedJs.length; i++) {
      assert.ok(
        Math.abs(normalizedJs[i] - normalizedPy[i]) <= 1e-6,
        `Vector mismatch at index ${i}: JS=${normalizedJs[i]}, Python=${normalizedPy[i]}`
      );
    }
  });

  test("JS vs Python: dimension 256 produces vectors within epsilon 1e-6", () => {
    const input = "another test string for embedding";
    const dimension = 256;

    const jsResult = buildHashEmbedding(input, dimension);
    const normalizedJs = normalizeForCompare(jsResult);

    const pyResult = runPython(`
from lsh_utils import build_hash_embedding
print(json.dumps(build_hash_embedding("another test string for embedding", 256)))
    `);
    const normalizedPy = normalizeForCompare(pyResult);

    assert.strictEqual(normalizedJs.length, normalizedPy.length);
    for (let i = 0; i < normalizedJs.length; i++) {
      assert.ok(
        Math.abs(normalizedJs[i] - normalizedPy[i]) <= 1e-6,
        `Vector mismatch at index ${i}: JS=${normalizedJs[i]}, Python=${normalizedPy[i]}`
      );
    }
  });

  test("JS vs Python: 'test' produces identical deterministic vectors", () => {
    const input = "test";
    const dimension = 384;

    const jsResult = buildHashEmbedding(input, dimension);
    const normalizedJs = normalizeForCompare(jsResult);

    const pyResult = runPython(`
from lsh_utils import build_hash_embedding
print(json.dumps(build_hash_embedding("test", 384)))
    `);
    const normalizedPy = normalizeForCompare(pyResult);

    // Vectors must be exactly equal (deterministic)
    assert.deepStrictEqual(normalizedJs, normalizedPy);
  });

  test("JS vs Python: empty text produces identical zero vectors", () => {
    const input = "";
    const dimension = 384;

    const jsResult = buildHashEmbedding(input, dimension);

    const pyResult = runPython(`
from lsh_utils import build_hash_embedding
print(json.dumps(build_hash_embedding("", 384)))
    `);

    // Both should produce zero vectors
    const jsIsZero = jsResult.every((v) => v === 0);
    const pyIsZero = Array.isArray(pyResult) && pyResult.every((v) => v === 0);

    assert.ok(
      jsIsZero && pyIsZero,
      `Empty text should produce zero vectors. JS zero: ${jsIsZero}, Python zero: ${pyIsZero}`
    );
    assert.strictEqual(jsResult.length, pyResult.length);
  });
});
