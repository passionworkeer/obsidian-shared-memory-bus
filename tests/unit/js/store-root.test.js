import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveStoreRoot, getDefaultStoreCandidates } from "../../../bus/store-root.js";

describe("store root resolution", () => {
  // ---------------------------------------------------------------------------
  // resolveStoreRoot tests
  // ---------------------------------------------------------------------------

  test("resolveStoreRoot returns a string or null", () => {
    const result = resolveStoreRoot({ useCache: false });

    // Should return a string (path) or null
    assert.ok(result === null || typeof result === "string");
  });

  test("resolveStoreRoot with useCache returns cached value", () => {
    // First call
    const result1 = resolveStoreRoot({ useCache: false });

    // Should set cache (if not already set)
    // Second call should return cached value
    const result2 = resolveStoreRoot({ useCache: true });

    // If cache was set, result2 should equal result1
    if (result1 !== null) {
      assert.strictEqual(result1, result2);
    }
  });

  test("resolveStoreRoot without options uses defaults", () => {
    const result = resolveStoreRoot();

    // Should return a string or null (depends on environment)
    assert.ok(result === null || typeof result === "string");
  });

  // ---------------------------------------------------------------------------
  // getDefaultStoreCandidates tests
  // ---------------------------------------------------------------------------

  test("getDefaultStoreCandidates returns array of paths", () => {
    const candidates = getDefaultStoreCandidates();

    assert.ok(Array.isArray(candidates));
    // Should have at least one candidate
    assert.ok(candidates.length > 0);

    // All candidates should be strings
    candidates.forEach((candidate) => {
      assert.strictEqual(typeof candidate, "string");
      assert.ok(candidate.length > 0);
    });
  });

  test("getDefaultStoreCandidates removes duplicates", () => {
    const candidates = getDefaultStoreCandidates();
    const unique = [...new Set(candidates)];

    assert.strictEqual(candidates.length, unique.length, "Should not have duplicates");
  });

  test("getDefaultStoreCandidates contains ai-memory related paths", () => {
    const candidates = getDefaultStoreCandidates();

    // Should contain ai-memory related paths
    const hasStorePath = candidates.some(
      (candidate) =>
        candidate.includes("ai-memory") || candidate.includes(".ai-memory")
    );
    assert.ok(hasStorePath, "Should have at least one ai-memory related path");
  });

  // ---------------------------------------------------------------------------
  // Integration tests
  // ---------------------------------------------------------------------------

  test("resolution chain finds valid store or returns null", () => {
    // Try to resolve store root
    const result = resolveStoreRoot({ useCache: false });

    // In a proper test environment with store configured,
    // this should find a valid store path, otherwise null
    if (result !== null) {
      assert.strictEqual(typeof result, "string");
      assert.ok(result.length > 0);
    }
  });

  test("default candidates include store-related paths", () => {
    const candidates = getDefaultStoreCandidates();

    // Should contain store-related paths (cross-platform check)
    const hasStorePath = candidates.some(
      (candidate) =>
        candidate.includes("ai-memory") ||
        candidate.includes(".ai-memory") ||
        candidate.includes("AppData") ||
        candidate.includes("Application Support") ||
        candidate.includes(".config")
    );
    assert.ok(hasStorePath);
  });
});