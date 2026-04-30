import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveVaultRoot, getDefaultVaultCandidates } from "../../../bus/vault-root.js";

describe("vault root resolution", () => {
  // ---------------------------------------------------------------------------
  // resolveVaultRoot tests
  // ---------------------------------------------------------------------------

  test("resolveVaultRoot returns a string or null", () => {
    const result = resolveVaultRoot({ useCache: false });

    // Should return a string (path) or null
    assert.ok(result === null || typeof result === "string");
  });

  test("resolveVaultRoot with useCache returns cached value", () => {
    // First call
    const result1 = resolveVaultRoot({ useCache: false });

    // Should set cache (if not already set)
    // Second call should return cached value
    const result2 = resolveVaultRoot({ useCache: true });

    // If cache was set, result2 should equal result1
    if (result1 !== null) {
      assert.strictEqual(result1, result2);
    }
  });

  test("resolveVaultRoot without options uses defaults", () => {
    const result = resolveVaultRoot();

    // Should return a string or null (depends on environment)
    assert.ok(result === null || typeof result === "string");
  });

  // ---------------------------------------------------------------------------
  // getDefaultVaultCandidates tests
  // ---------------------------------------------------------------------------

  test("getDefaultVaultCandidates returns array of paths", () => {
    const candidates = getDefaultVaultCandidates();

    assert.ok(Array.isArray(candidates));
    // Should have at least one candidate
    assert.ok(candidates.length > 0);

    // All candidates should be strings
    candidates.forEach((candidate) => {
      assert.strictEqual(typeof candidate, "string");
      assert.ok(candidate.length > 0);
    });
  });

  test("getDefaultVaultCandidates removes duplicates", () => {
    const candidates = getDefaultVaultCandidates();
    const unique = [...new Set(candidates)];

    assert.strictEqual(candidates.length, unique.length, "Should not have duplicates");
  });

  test("getDefaultVaultCandidates contains Obsidian-related paths", () => {
    const candidates = getDefaultVaultCandidates();

    // Should contain Obsidian-related paths
    const hasObsidianPath = candidates.some(
      (candidate) =>
        candidate.includes("Obsidian") || candidate.includes("obsidian")
    );
    assert.ok(hasObsidianPath, "Should have at least one Obsidian-related path");
  });

  // ---------------------------------------------------------------------------
  // Integration tests
  // ---------------------------------------------------------------------------

  test("resolution chain finds valid vault or returns null", () => {
    // Try to resolve vault root
    const result = resolveVaultRoot({ useCache: false });

    // In a proper test environment with Obsidian installed,
    // this should find a valid vault path, otherwise null
    if (result !== null) {
      assert.strictEqual(typeof result, "string");
      assert.ok(result.length > 0);
    }
  });

  test("default candidates include vault-related paths", () => {
    const candidates = getDefaultVaultCandidates();

    // Should contain Obsidian-related paths (cross-platform check)
    const hasObsidianPath = candidates.some(
      (candidate) =>
        candidate.includes("Obsidian") ||
        candidate.includes("obsidian") ||
        candidate.includes("AppData") ||
        candidate.includes("Application Support") ||
        candidate.includes(".config")
    );
    assert.ok(hasObsidianPath);
  });
});
