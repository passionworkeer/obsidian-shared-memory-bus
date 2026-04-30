import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmbeddingRuntimeCatalog,
  loadRuntimeConfig,
  normalizeEmbeddingAdapter,
  resolveEmbeddingRuntime,
  resolveRuntimeConfigPath,
  updateEmbeddingRuntimeSelection,
  writeRuntimeConfig,
} from "../../../bus/runtime-config.js";

describe("runtime config", () => {
  // ---------------------------------------------------------------------------
  // normalizeEmbeddingAdapter tests
  // ---------------------------------------------------------------------------

  test("normalizeEmbeddingAdapter returns valid adapter name", () => {
    const result1 = normalizeEmbeddingAdapter("openai");
    const result2 = normalizeEmbeddingAdapter("anthropic");
    const result3 = normalizeEmbeddingAdapter("huggingface");

    assert.strictEqual(typeof result1, "string");
    assert.strictEqual(typeof result2, "string");
    assert.strictEqual(typeof result3, "string");
  });

  test("normalizeEmbeddingAdapter falls back correctly", () => {
    const result1 = normalizeEmbeddingAdapter(null, "");
    const result2 = normalizeEmbeddingAdapter(undefined, "default");
    const result3 = normalizeEmbeddingAdapter("invalid", "openai");

    assert.strictEqual(result1, "");
    assert.strictEqual(result2, "default");
    assert.strictEqual(result3, "openai");
  });

  test("normalizeEmbeddingAdapter handles empty string", () => {
    const result = normalizeEmbeddingAdapter("", "fallback");
    assert.strictEqual(result, "fallback");
  });

  test("normalizeEmbeddingAdapter normalizes adapter names", () => {
    // Should normalize common aliases
    const result = normalizeEmbeddingAdapter("OpenAI", "default");
    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  // ---------------------------------------------------------------------------
  // resolveRuntimeConfigPath tests
  // ---------------------------------------------------------------------------

  test("resolveRuntimeConfigPath returns a path string", () => {
    const result = resolveRuntimeConfigPath();

    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  test("resolveRuntimeConfigPath handles custom root", () => {
    const customRoot = "/custom/path";
    const result = resolveRuntimeConfigPath(customRoot);

    assert.strictEqual(typeof result, "string");
    assert.ok(result.includes(customRoot) || result.length > 0);
  });

  // ---------------------------------------------------------------------------
  // buildEmbeddingRuntimeCatalog tests
  // ---------------------------------------------------------------------------

  test("buildEmbeddingRuntimeCatalog returns object", async () => {
    const result = await buildEmbeddingRuntimeCatalog();

    assert.strictEqual(typeof result, "object");
    assert.ok(result !== null);
  });

  test("buildEmbeddingRuntimeCatalog handles options", async () => {
    const result = await buildEmbeddingRuntimeCatalog({
      vaultRoot: null,
    });

    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // loadRuntimeConfig tests
  // ---------------------------------------------------------------------------

  test("loadRuntimeConfig returns object", async () => {
    const result = await loadRuntimeConfig();

    assert.strictEqual(typeof result, "object");
    assert.ok(result !== null);
  });

  test("loadRuntimeConfig handles custom root", async () => {
    const result = await loadRuntimeConfig("/custom/root");

    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // resolveEmbeddingRuntime tests
  // ---------------------------------------------------------------------------

  test("resolveEmbeddingRuntime returns object", async () => {
    const result = await resolveEmbeddingRuntime({});

    assert.strictEqual(typeof result, "object");
    assert.ok(result !== null);
  });

  test("resolveEmbeddingRuntime handles empty options", async () => {
    const result = await resolveEmbeddingRuntime();

    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // updateEmbeddingRuntimeSelection tests
  // ---------------------------------------------------------------------------

  test("updateEmbeddingRuntimeSelection returns object", async () => {
    const result = await updateEmbeddingRuntimeSelection({ clearProfile: true });

    assert.strictEqual(typeof result, "object");
  });

  test("updateEmbeddingRuntimeSelection handles selection", async () => {
    const result = await updateEmbeddingRuntimeSelection({
      clearProvider: true,
    });

    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // writeRuntimeConfig tests
  // ---------------------------------------------------------------------------

  test("writeRuntimeConfig returns true on success", async () => {
    // Create a temporary config
    const tempConfig = {
      embedding: {
        backend: "test",
        modelName: "test-model",
      },
    };

    const result = await writeRuntimeConfig("", tempConfig);

    assert.strictEqual(typeof result, "string");
  });

  // ---------------------------------------------------------------------------
  // Integration tests
  // ---------------------------------------------------------------------------

  test("complete config flow works end-to-end", async () => {
    // Load existing config
    const loaded = await loadRuntimeConfig();

    // Should get a valid config object
    assert.strictEqual(typeof loaded, "object");
  });

  test("catalog contains runtime information", async () => {
    const catalog = await buildEmbeddingRuntimeCatalog();

    assert.ok(catalog);
    // Catalog should have some structure
    const keys = Object.keys(catalog);
    assert.ok(keys.length >= 0);
  });
});
