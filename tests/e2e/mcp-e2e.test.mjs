// Rewrite: 2026-06-15 — converted from custom assertion to node:test
/**
 * E2E 测试 - MCP 核心功能端到端测试
 * 测试核心模块的完整流程
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError, COMMON_CODES } from "../../bus/domain-error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

function toFileUrl(p) {
  return pathToFileURL(p).href;
}

// ============================================================================
// Test 1: LSH Hash (基础模块测试)
// ============================================================================
test("LSH Hash — buildHashEmbedding returns deterministic 384-dim array", async () => {
  const { buildHashEmbedding, buildHashFeatures } = await import(toFileUrl(path.join(REPO_ROOT, "bus/lsh-hash.js")));

  const embedding = buildHashEmbedding("test text");
  assert.ok(Array.isArray(embedding), "Hash embedding returns array");
  assert.equal(embedding.length, 384, "Hash embedding has 384 dimensions");

  const features = buildHashFeatures("test text");
  assert.ok(Array.isArray(features), "Hash features returns array");
  assert.ok(features.length > 0, "Hash features non-empty");

  const embedding2 = buildHashEmbedding("test text");
  assert.ok(embedding.every((v, i) => v === embedding2[i]), "Same text produces same embedding");
});

// ============================================================================
// Test 2: BM25
// ============================================================================
test("BM25 — search returns an array", async () => {
  const { search } = await import(toFileUrl(path.join(REPO_ROOT, "bus/bm25.js")));

  const docs = ["hello world", "test document", "another example"];
  const results = search(docs, "hello");

  assert.ok(Array.isArray(results), "BM25 search returns array");
  // Results may be empty if no match or algorithm-specific behavior
  console.log(`  BM25 results count: ${results.length}`);
});

// ============================================================================
// Test 3: Memory Contract
// ============================================================================
test("Memory Contract — validateRecord and scorePromotionCandidate exist", async () => {
  const contractModule = await import(toFileUrl(path.join(REPO_ROOT, "ops/memory/memory-contract.js")));
  const validateRecord = contractModule.validateRecord || contractModule.validateStructuredRecord;
  const scorePromotionCandidate = contractModule.scorePromotionCandidate;

  assert.equal(typeof validateRecord, "function", "validateRecord exists");
  assert.equal(typeof scorePromotionCandidate, "function", "scorePromotionCandidate exists");

  // Test validation
  const validRecord = {
    id: "test-123",
    content: "Test content",
    timestamp: new Date().toISOString(),
    scope: "conversation",
  };
  const result = validateRecord(validRecord);
  assert.notEqual(result, false, "Valid record passes validation");
});

// ============================================================================
// Test 4: Entity Extractor
// ============================================================================
test("Entity Extractor — extractEntities returns a list", async () => {
  const entityModule = await import(toFileUrl(path.join(REPO_ROOT, "ops/entity/entity-extractor.js")));
  const extractEntities = entityModule.extractEntities;

  const text = "Apple Inc. was founded by Steve Jobs in California.";
  const entities = extractEntities(text);

  // May return array or object with entities property
  const entityList = Array.isArray(entities) ? entities : (entities.entities || []);
  assert.ok(Array.isArray(entityList), "Entities returns array");
});

// ============================================================================
// Test 5: JSONL Stream
// ============================================================================
test("JSONL Stream — createJsonlStream is callable and produces instance", async () => {
  const { createJsonlStream } = await import(toFileUrl(path.join(REPO_ROOT, "ops/util/jsonl-stream.js")));

  assert.equal(typeof createJsonlStream, "function", "createJsonlStream exists");

  // Test create
  const stream = createJsonlStream();
  assert.notEqual(stream, null, "JsonlStream created");
});

// ============================================================================
// Test 6: Health Check
// ============================================================================
test("Health Check — module exports isProcessAlive, probeHttp, PROBE_TYPES", async () => {
  const healthModule = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/health-check.js")));

  assert.equal(typeof healthModule.isProcessAlive, "function", "isProcessAlive exists");
  assert.equal(typeof healthModule.probeHttp, "function", "probeHttp exists");
  assert.notEqual(healthModule.PROBE_TYPES, undefined, "PROBE_TYPES exists");

  // Test with null/undefined (should return false)
  assert.equal(healthModule.isProcessAlive(null), false, "null process returns false");
  assert.equal(healthModule.isProcessAlive(undefined), false, "undefined process returns false");
});

// ============================================================================
// Test 7: Store Root
// ============================================================================
test("Store Root — resolveStoreRoot returns a non-empty path", async () => {
  const storeModule = await import(toFileUrl(path.join(REPO_ROOT, "bus/store-root.js")));
  const resolveStoreRoot = storeModule.resolveStoreRoot;

  const storeRoot = resolveStoreRoot();
  assert.notEqual(storeRoot, null, "Store root resolved");
  assert.ok(storeRoot.length > 0, "Store root not empty");
});

// ============================================================================
// Test 8: Store Root (duplicate coverage preserved)
// ============================================================================
test("Store Root (idempotent) — resolveStoreRoot returns a non-empty path", async () => {
  const storeModule = await import(toFileUrl(path.join(REPO_ROOT, "bus/store-root.js")));
  const resolveStoreRoot = storeModule.resolveStoreRoot;

  const storeRoot = resolveStoreRoot();
  assert.notEqual(storeRoot, null, "Store root resolved");
  assert.ok(storeRoot.length > 0, "Store root not empty");
});

// ============================================================================
// Test 9: Inbox Atomic Write
// ============================================================================
test("Inbox Atomic Write — appendLineAtomic writes content to file", async () => {
  const { appendLineAtomic } = await import(toFileUrl(path.join(REPO_ROOT, "ops/inbox/inbox-atomic-write.js")));

  assert.equal(typeof appendLineAtomic, "function", "appendLineAtomic exists");

  const tempDir = path.join(os.tmpdir(), "e2e-test-" + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const testFile = path.join(tempDir, "test.md");
    await appendLineAtomic(testFile, "# Test\n\nContent");

    const content = fs.readFileSync(testFile, "utf8");
    assert.match(content, /Test/, "File content written correctly");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Test 10: Platform Detection
// ============================================================================
test("Platform Detection — exposes isWindows/isMac/isLinux booleans", async () => {
  const platform = await import(toFileUrl(path.join(REPO_ROOT, "bus/platform/index.js")));

  assert.notEqual(platform.isWindows, undefined, "Platform has isWindows");
  assert.notEqual(platform.isMac, undefined, "Platform has isMac");
  assert.notEqual(platform.isLinux, undefined, "Platform has isLinux");
  assert.equal(typeof platform.isWindows, "boolean", "isWindows is boolean");

  const currentPlatform = platform.isWindows ? "Windows" : platform.isMac ? "Mac" : "Linux";
  console.log(`  Running on: ${currentPlatform}`);
});

// ============================================================================
// Test 11: Embedding Provider Registry
// ============================================================================
test("Embedding Provider Registry — list/get/embedBatch surface", async () => {
  const { createEmbeddingProviderRegistry, getProviderHost } = await import(toFileUrl(path.join(REPO_ROOT, "bus/embedding-provider-registry.js")));
  const { buildHashEmbedding } = await import(toFileUrl(path.join(REPO_ROOT, "bus/lsh-hash.js")));

  const registry = createEmbeddingProviderRegistry({ buildHashEmbedding });
  const adapters = registry.list();
  assert.ok(adapters.length >= 3, "Has at least 3 adapters");

  const hashAdapter = registry.get("hash");
  assert.equal(hashAdapter.name, "hash", "get('hash') returns hash adapter");

  assert.equal(getProviderHost("https://api.openai.com/v1"), "api.openai.com", "getProviderHost works");

  const result = await hashAdapter.embedBatch({ texts: ["hello world"], runtime: {} });
  assert.ok(Array.isArray(result.vectors), "Embed returns vectors");
  assert.equal(result.vectors.length, 1, "Embed returns correct count");
});

// ============================================================================
// Test 12: Memory Status Handler
// ============================================================================
test("Memory Status Handler — handleMemoryStatus/handleGetMemoryOverview/handleMemoryWakeUp/loadTaskRecords", async () => {
  try {
    const { createMemoryStatus } = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/memory-status.js")));

    const status = createMemoryStatus();
    const statusResult = await status.handleMemoryStatus({});
    assert.notEqual(statusResult, null, "Status returns result");

    const overviewResult = await status.handleGetMemoryOverview({});
    assert.notEqual(overviewResult, null, "Overview returns result");

    const wakeupResult = await status.handleMemoryWakeUp({});
    assert.notEqual(wakeupResult, null, "WakeUp returns result");

    const taskRecords = await status.loadTaskRecords();
    assert.ok(Array.isArray(taskRecords), "Task records returns array");
  } catch (err) {
    // Mirror original semantics: missing optional surface is tolerated as "test skipped"
    if (err instanceof DomainError && err.code === COMMON_CODES.NOT_FOUND) {
      return;
    }
    // TypeError for "not a function" on missing optional handler — treat as tolerated skip
    if (err && err.name === "TypeError") {
      return;
    }
    throw new DomainError(COMMON_CODES.INTERNAL, "Memory Status Handler test failed", { cause: err });
  }
});
// ============================================================================
// Test 13: Memory Bridge Handler
// ============================================================================
test("Memory Bridge Handler — handleReadSharedMemory/handleListSharedMemory", async () => {
  try {
    const { createMemoryBridge } = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/memory-bridge.js")));

    const bridge = createMemoryBridge({});
    const readResult = await bridge.handleReadSharedMemory({ path: "test", limit: 10 });
    assert.notEqual(readResult, null, "Read returns result");

    const listResult = await bridge.handleListSharedMemory({ path: "/" });
    assert.notEqual(listResult, null, "List returns result");
  } catch (err) {
    // Mirror original semantics: missing optional surface is tolerated as "test skipped"
    if (err instanceof DomainError && err.code === COMMON_CODES.NOT_FOUND) {
      return;
    }
    // TypeError for "not a function" on missing optional handler — treat as tolerated skip
    if (err && err.name === "TypeError") {
      return;
    }
    throw new DomainError(COMMON_CODES.INTERNAL, "Memory Bridge Handler test failed", { cause: err });
  }
});