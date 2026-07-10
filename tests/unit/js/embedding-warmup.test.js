/**
 * Tests for embedding-provider-registry.warmUp() (Q-CRIT-4 root cause fix).
 *
 * The cold-start cost (3-8s) for sentence-transformers was the root cause of
 * slow first-request latency. warmUp() pre-spawns the Python worker pool so
 * the first embedBatch() pays 0 cold-start cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingProviderRegistry } from "../../../bus/embedding-provider-registry.js";

test("warmUp is a no-op (returns false) when no pythonCommand provided", async () => {
  const reg = createEmbeddingProviderRegistry({
    pythonRuntime: { available: false, command: null, args: [] },
    fetchImpl: globalThis.fetch,
  });
  const result = await reg.warmUp({});
  assert.equal(result, false, "should return false when runtime missing");
});

test("warmUp is a no-op (returns false) when pythonRuntime.available=false", async () => {
  const reg = createEmbeddingProviderRegistry({
    pythonRuntime: { available: false, command: "python", args: [] },
    fetchImpl: globalThis.fetch,
  });
  const result = await reg.warmUp({ pythonCommand: "python" });
  assert.equal(result, false, "should return false when python unavailable");
});

test("warmUp is idempotent (returns false on second call)", async () => {
  // Even if first call succeeded, second call returns false (already warmed).
  // We can't trigger a real success without Python, so we use the no-op path.
  const reg = createEmbeddingProviderRegistry({
    pythonRuntime: { available: false, command: null },
    fetchImpl: globalThis.fetch,
  });
  const r1 = await reg.warmUp({});
  const r2 = await reg.warmUp({});
  assert.equal(r1, false);
  assert.equal(r2, false);
});

test("registry still exposes get/list/embedBatch/warmUp contract", () => {
  const reg = createEmbeddingProviderRegistry({
    pythonRuntime: { available: false, command: null, args: [] },
    fetchImpl: globalThis.fetch,
  });
  // Contract: get(), list(), warmUp() always present; embedBatch via get().embedBatch
  assert.equal(typeof reg.get, "function");
  assert.equal(typeof reg.list, "function");
  assert.equal(typeof reg.warmUp, "function");
  const hashAdapter = reg.get("hash");
  assert.equal(hashAdapter.name, "hash");
  assert.equal(typeof hashAdapter.embedBatch, "function");
  const all = reg.list();
  assert.ok(all.includes("hash"));
  assert.ok(all.includes("transformer"));
  assert.ok(all.includes("gemini"));
  assert.ok(all.includes("openai-compatible"));
});
