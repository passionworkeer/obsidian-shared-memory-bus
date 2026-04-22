/**
 * Cross-language schema consistency tests.
 *
 * Tests that ops/memory-contract.js (Node.js) and retrieval/schema_validation.py (Python)
 * agree on record validation rules.
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");

// Load the JS implementation directly
const { validateStructuredRecord, validatePromotionMetadata } = require("../../ops/memory/memory-contract.js");

// Python retrieval module path (forward slashes for cross-platform compatibility)
const PYTHON_MODULE_PATH = "E:/desktop/obsidian-shared-memory-bus/retrieval";

/**
 * Run a Python validation function via subprocess and return the parsed result.
 * @param {string} pythonCode - Python code to execute
 * @returns {object} Parsed JSON result
 */
function runPython(pythonCode) {
  const fullCode = `
# -*- coding: utf-8 -*-
import sys, json
sys.path.insert(0, '${PYTHON_MODULE_PATH}')
${pythonCode}
`;
  // Python executable: use absolute path (not all environments have 'python' in PATH)
  const PYTHON_EXE = process.platform === "win32"
    ? "D:\\Users\\王健俊\\AppData\\Local\\Programs\\Python\\Python313\\python.exe"
    : "python";
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
 * Extract error codes from an error list (strip any dynamic values appended after ':').
 * @param {string[]} errors
 * @returns {string[]} Normalized error codes
 */
function normalizeErrorCodes(errors) {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((e) => {
    // Extract the error code (everything before the first ':' or the whole string)
    const colonIndex = e.indexOf(":");
    return colonIndex >= 0 ? e.substring(0, colonIndex) : e;
  });
}

/**
 * Check if two error lists are equivalent (same error codes, possibly different values).
 * @param {string[]} errors1
 * @param {string[]} errors2
 * @returns {boolean}
 */
function errorsAreEquivalent(errors1, errors2) {
  const codes1 = normalizeErrorCodes(errors1).sort();
  const codes2 = normalizeErrorCodes(errors2).sort();
  if (codes1.length !== codes2.length) {
    return false;
  }
  for (let i = 0; i < codes1.length; i++) {
    if (codes1[i] !== codes2[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Record validation tests
// ---------------------------------------------------------------------------

describe("validateStructuredRecord consistency", () => {
  test("Valid record: all required fields present, both ok=true", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, true);
    assert.strictEqual(pyResult[0], true);
    assert.deepStrictEqual(jsResult.errors, []);
    assert.deepStrictEqual(pyResult[1], []);
  });

  test("Invalid schema version (1): both ok=false, both have schema version error", () => {
    const record = {
      schemaVersion: 1,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 1,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("unexpected-schema-version")),
      `JS should have schema version error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("unexpected-schema-version")),
      `Python should have schema version error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid schema version (999): both ok=false", () => {
    const record = {
      schemaVersion: 999,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 999,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
  });

  test("Missing required field (id): both ok=false, both have missing-fields error", () => {
    const record = {
      schemaVersion: 2,
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("missing-fields")),
      `JS should have missing-fields error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("missing-fields")),
      `Python should have missing-fields error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid scope: both ok=false, both have unknown-scope error", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "invalid-scope",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "invalid-scope",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("unknown-scope")),
      `JS should have unknown-scope error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("unknown-scope")),
      `Python should have unknown-scope error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid visibility: both ok=false", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      visibility: "invalid-visibility",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "visibility": "invalid-visibility",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("unknown-visibility")),
      `JS should have unknown-visibility error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("unknown-visibility")),
      `Python should have unknown-visibility error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid source_kind: both ok=false", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      sourceKind: "invalid-source-kind",
      scope: "user",
      memory_level: "durable",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "sourceKind": "invalid-source-kind",
    "scope": "user",
    "memory_level": "durable"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("unknown-source-kind")),
      `JS should have unknown-source-kind error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("unknown-source-kind")),
      `Python should have unknown-source-kind error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid memory_level: both ok=false", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "invalid-level",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "invalid-level"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("unknown-memory-level")),
      `JS should have unknown-memory-level error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("unknown-memory-level")),
      `Python should have unknown-memory-level error: ${JSON.stringify(pyResult[1])}`
    );
  });

  test("Invalid content_hash (bad format): both ok=false", () => {
    const record = {
      schemaVersion: 2,
      id: "t1",
      tool: "test",
      type: "n",
      title: "Test",
      source: "test",
      scope: "user",
      memory_level: "durable",
      content_hash: "not-a-valid-hash",
    };

    const jsResult = validateStructuredRecord(record);
    const pyResult = runPython(`
from schema_validation import validate_record
record = {
    "schemaVersion": 2,
    "id": "t1",
    "tool": "test",
    "type": "n",
    "title": "Test",
    "source": "test",
    "scope": "user",
    "memory_level": "durable",
    "content_hash": "not-a-valid-hash"
}
print(json.dumps(validate_record(record)))
    `);

    assert.strictEqual(jsResult.ok, false);
    assert.strictEqual(pyResult[0], false);
    assert.ok(
      jsResult.errors.some((e) => e.includes("invalid-content-hash")),
      `JS should have invalid-content-hash error: ${JSON.stringify(jsResult.errors)}`
    );
    assert.ok(
      pyResult[1].some((e) => e.includes("invalid-content-hash")),
      `Python should have invalid-content-hash error: ${JSON.stringify(pyResult[1])}`
    );
  });
});

// ---------------------------------------------------------------------------
// Promotion metadata validation tests
// ---------------------------------------------------------------------------

describe("validatePromotionMetadata consistency", () => {
  test("Valid promotion metadata: both return no errors", () => {
    const promotion = {
      version: 1,
      key: "test-key",
      reason: "test reason",
      source_record_id: "source-123",
      durable_type: "user",
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 1,
    "key": "test-key",
    "reason": "test reason",
    "source_record_id": "source-123",
    "durable_type": "user"
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.deepStrictEqual(jsErrors, []);
    assert.deepStrictEqual(pyErrors, []);
  });

  test("Invalid promotion version: both return same error list", () => {
    const promotion = {
      version: 2,
      key: "test-key",
      reason: "test reason",
      source_record_id: "source-123",
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 2,
    "key": "test-key",
    "reason": "test reason",
    "source_record_id": "source-123"
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.ok(
      jsErrors.some((e) => e.includes("unknown-promotion-version")),
      `JS should have unknown-promotion-version error: ${JSON.stringify(jsErrors)}`
    );
    assert.ok(
      pyErrors.some((e) => e.includes("unknown-promotion-version")),
      `Python should have unknown-promotion-version error: ${JSON.stringify(pyErrors)}`
    );
  });

  test("Invalid promotion durable_type: both return same error", () => {
    const promotion = {
      version: 1,
      key: "test-key",
      reason: "test reason",
      source_record_id: "source-123",
      durable_type: "invalid-type",
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 1,
    "key": "test-key",
    "reason": "test reason",
    "source_record_id": "source-123",
    "durable_type": "invalid-type"
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.ok(
      jsErrors.some((e) => e.includes("unknown-promotion-durable-type")),
      `JS should have unknown-promotion-durable-type error: ${JSON.stringify(jsErrors)}`
    );
    assert.ok(
      pyErrors.some((e) => e.includes("unknown-promotion-durable-type")),
      `Python should have unknown-promotion-durable-type error: ${JSON.stringify(pyErrors)}`
    );
  });

  test("Missing promotion key: both return same error", () => {
    const promotion = {
      version: 1,
      reason: "test reason",
      source_record_id: "source-123",
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 1,
    "reason": "test reason",
    "source_record_id": "source-123"
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.ok(
      jsErrors.includes("missing-promotion-key"),
      `JS should have missing-promotion-key error: ${JSON.stringify(jsErrors)}`
    );
    assert.ok(
      pyErrors.includes("missing-promotion-key"),
      `Python should have missing-promotion-key error: ${JSON.stringify(pyErrors)}`
    );
  });

  test("Valid promotion with is_refresh=true: both return no errors", () => {
    const promotion = {
      version: 1,
      key: "test-key",
      reason: "test reason",
      source_record_id: "source-123",
      durable_type: "user",
      is_refresh: true,
      refresh_of_id: "original-id",
      refresh_of_t: "2024-01-01T00:00:00Z",
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 1,
    "key": "test-key",
    "reason": "test reason",
    "source_record_id": "source-123",
    "durable_type": "user",
    "is_refresh": True,
    "refresh_of_id": "original-id",
    "refresh_of_t": "2024-01-01T00:00:00Z"
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.deepStrictEqual(jsErrors, []);
    assert.deepStrictEqual(pyErrors, []);
  });

  test("Invalid promotion is_refresh without refresh fields: both return same errors", () => {
    const promotion = {
      version: 1,
      key: "test-key",
      reason: "test reason",
      source_record_id: "source-123",
      is_refresh: true,
      // Missing refresh_of_id and refresh_of_t
    };

    const jsErrors = validatePromotionMetadata(promotion);
    const pyErrors = runPython(`
from schema_validation import validate_promotion_metadata
promotion = {
    "version": 1,
    "key": "test-key",
    "reason": "test reason",
    "source_record_id": "source-123",
    "is_refresh": True
    # Missing refresh_of_id and refresh_of_t
}
print(json.dumps(validate_promotion_metadata(promotion)))
    `);

    assert.ok(
      jsErrors.includes("missing-promotion-refresh-of-id"),
      `JS should have missing-promotion-refresh-of-id error: ${JSON.stringify(jsErrors)}`
    );
    assert.ok(
      jsErrors.includes("missing-promotion-refresh-of-t"),
      `JS should have missing-promotion-refresh-of-t error: ${JSON.stringify(jsErrors)}`
    );
    assert.ok(
      pyErrors.includes("missing-promotion-refresh-of-id"),
      `Python should have missing-promotion-refresh-of-id error: ${JSON.stringify(pyErrors)}`
    );
    assert.ok(
      pyErrors.includes("missing-promotion-refresh-of-t"),
      `Python should have missing-promotion-refresh-of-t error: ${JSON.stringify(pyErrors)}`
    );
  });
});
