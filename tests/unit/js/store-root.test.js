import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { resolveStoreRoot } from "../../../bus/store-root.js";

async function getDefaultStoreCandidatesFromModule() {
  const mod = await import("../../../bus/store-root.js");
  return mod.getDefaultStoreCandidates();
}

describe("store root resolution", () => {
  test("resolveStoreRoot returns a non-empty string", () => {
    const result = resolveStoreRoot();
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  test("resolveStoreRoot uses AI_MEMORY_STORE when set", () => {
    const orig = process.env.AI_MEMORY_STORE;
    process.env.AI_MEMORY_STORE = "C:/test/store";
    try {
      const result = resolveStoreRoot();
      assert.equal(result, "C:/test/store");
    } finally {
      if (orig != null) process.env.AI_MEMORY_STORE = orig;
      else delete process.env.AI_MEMORY_STORE;
    }
  });

  test("getDefaultStoreCandidates returns array of paths", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length > 0);
    candidates.forEach((c) => {
      assert.strictEqual(typeof c, "string");
      assert.ok(c.length > 0);
    });
  });

  test("getDefaultStoreCandidates contains ai-memory paths", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    const hasAiMem = candidates.some((c) => c.includes("ai-memory"));
    assert.ok(hasAiMem, "should contain ai-memory path");
  });

  test("getDefaultStoreCandidates removes duplicates", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    const unique = [...new Set(candidates)];
    assert.strictEqual(candidates.length, unique.length);
  });
});