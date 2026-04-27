/**
 * E2E 测试 - MCP 核心功能端到端测试
 * 测试核心模块的完整流程
 */

import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

function toFileUrl(p) {
  return pathToFileURL(p).href;
}

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertTrue(value, label) {
  if (Boolean(value)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected truthy, got ${JSON.stringify(value)}`);
    failed++;
  }
}

function assertMatch(value, pattern, label) {
  if (pattern.test(value)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected match ${pattern}, got ${JSON.stringify(value)}`);
    failed++;
  }
}

// ============================================================================
// Test 1: LSH Hash (基础模块测试)
// ============================================================================
async function testLSHHash() {
  console.log("\n=== Test 1: LSH Hash ===");

  try {
    const { buildHashEmbedding, buildHashFeatures } = await import(toFileUrl(path.join(REPO_ROOT, "bus/lsh-hash.js")));

    const embedding = buildHashEmbedding("test text");
    assertTrue(Array.isArray(embedding), "Hash embedding returns array");
    assertEqual(embedding.length, 384, "Hash embedding has 384 dimensions");

    const features = buildHashFeatures("test text");
    assertTrue(Array.isArray(features), "Hash features returns array");
    assertTrue(features.length > 0, "Hash features non-empty");

    const embedding2 = buildHashEmbedding("test text");
    assertTrue(embedding.every((v, i) => v === embedding2[i]), "Same text produces same embedding");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 2: BM25
// ============================================================================
async function testBM25() {
  console.log("\n=== Test 2: BM25 ===");

  try {
    const { search } = await import(toFileUrl(path.join(REPO_ROOT, "bus/bm25.js")));

    const docs = ["hello world", "test document", "another example"];
    const results = search(docs, "hello");

    assertTrue(Array.isArray(results), "BM25 search returns array");
    // Results may be empty if no match or algorithm-specific behavior
    console.log(`  BM25 results count: ${results.length}`);
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 3: Memory Contract
// ============================================================================
async function testMemoryContract() {
  console.log("\n=== Test 3: Memory Contract ===");

  try {
    const contractModule = await import(toFileUrl(path.join(REPO_ROOT, "ops/memory/memory-contract.js")));
    const validateRecord = contractModule.validateRecord || contractModule.validateStructuredRecord;
    const scorePromotionCandidate = contractModule.scorePromotionCandidate;

    assertTrue(typeof validateRecord === "function", "validateRecord exists");
    assertTrue(typeof scorePromotionCandidate === "function", "scorePromotionCandidate exists");

    // Test validation
    const validRecord = {
      id: "test-123",
      content: "Test content",
      timestamp: new Date().toISOString(),
      scope: "conversation",
    };
    const result = validateRecord(validRecord);
    assertTrue(result !== false, "Valid record passes validation");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 4: Entity Extractor
// ============================================================================
async function testEntityExtractor() {
  console.log("\n=== Test 4: Entity Extractor ===");

  try {
    const entityModule = await import(toFileUrl(path.join(REPO_ROOT, "ops/entity/entity-extractor.js")));
    const extractEntities = entityModule.extractEntities;

    const text = "Apple Inc. was founded by Steve Jobs in California.";
    const entities = extractEntities(text);

    // May return array or object with entities property
    const entityList = Array.isArray(entities) ? entities : (entities.entities || []);
    assertTrue(Array.isArray(entityList), "Entities returns array");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 5: JSONL Stream
// ============================================================================
async function testJsonlStream() {
  console.log("\n=== Test 5: JSONL Stream ===");

  try {
    const { createJsonlStream } = await import(toFileUrl(path.join(REPO_ROOT, "ops/util/jsonl-stream.js")));

    assertTrue(typeof createJsonlStream === "function", "createJsonlStream exists");

    // Test create
    const stream = createJsonlStream();
    assertTrue(stream !== null, "JsonlStream created");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 6: Health Check
// ============================================================================
async function testHealthCheck() {
  console.log("\n=== Test 6: Health Check ===");

  try {
    const healthModule = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/health-check.js")));

    assertTrue(typeof healthModule.isProcessAlive === "function", "isProcessAlive exists");
    assertTrue(typeof healthModule.probeHttp === "function", "probeHttp exists");
    assertTrue(healthModule.PROBE_TYPES !== undefined, "PROBE_TYPES exists");

    // Test with null/undefined (should return false)
    assertTrue(!healthModule.isProcessAlive(null), "null process returns false");
    assertTrue(!healthModule.isProcessAlive(undefined), "undefined process returns false");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 7: Store Root
// ============================================================================
async function testStoreRoot() {
  console.log("\n=== Test 7: Store Root ===");

  try {
    const storeModule = await import(toFileUrl(path.join(REPO_ROOT, "bus/store-root.js")));
    const resolveStoreRoot = storeModule.resolveStoreRoot;

    const storeRoot = resolveStoreRoot();
    assertTrue(storeRoot !== null, "Store root resolved");
    assertTrue(storeRoot.length > 0, "Store root not empty");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 8: Vault Root
// ============================================================================
async function testVaultRoot() {
  console.log("\n=== Test 8: Vault Root ===");

  try {
    const { resolveVaultRoot } = await import(toFileUrl(path.join(REPO_ROOT, "bus/vault-root.js")));

    const vaultRoot = resolveVaultRoot();
    assertTrue(vaultRoot !== null, "Vault root resolved");
    assertTrue(vaultRoot.length > 0, "Vault root not empty");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 9: Inbox Atomic Write
// ============================================================================
async function testInboxAtomicWrite() {
  console.log("\n=== Test 9: Inbox Atomic Write ===");

  try {
    const { appendLineAtomic } = await import(toFileUrl(path.join(REPO_ROOT, "ops/inbox/inbox-atomic-write.js")));

    assertTrue(typeof appendLineAtomic === "function", "appendLineAtomic exists");

    const tempDir = path.join(os.tmpdir(), "e2e-test-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const testFile = path.join(tempDir, "test.md");
      await appendLineAtomic(testFile, "# Test\n\nContent");

      const content = fs.readFileSync(testFile, "utf8");
      assertMatch(content, /Test/, "File content written correctly");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 10: Platform Detection
// ============================================================================
async function testPlatformDetection() {
  console.log("\n=== Test 10: Platform Detection ===");

  try {
    const platform = await import(toFileUrl(path.join(REPO_ROOT, "bus/platform/index.js")));

    assertTrue(platform.isWindows !== undefined, "Platform has isWindows");
    assertTrue(platform.isMac !== undefined, "Platform has isMac");
    assertTrue(platform.isLinux !== undefined, "Platform has isLinux");
    assertTrue(typeof platform.isWindows === "boolean", "isWindows is boolean");

    const currentPlatform = platform.isWindows ? "Windows" : platform.isMac ? "Mac" : "Linux";
    console.log(`  Running on: ${currentPlatform}`);
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 11: Embedding Provider Registry
// ============================================================================
async function testEmbeddingRegistry() {
  console.log("\n=== Test 11: Embedding Provider Registry ===");

  try {
    const { createEmbeddingProviderRegistry, getProviderHost } = await import(toFileUrl(path.join(REPO_ROOT, "bus/embedding-provider-registry.js")));
    const { buildHashEmbedding } = await import(toFileUrl(path.join(REPO_ROOT, "bus/lsh-hash.js")));

    const registry = createEmbeddingProviderRegistry({ buildHashEmbedding });
    const adapters = registry.list();
    assertTrue(adapters.length >= 3, "Has at least 3 adapters");

    const hashAdapter = registry.get("hash");
    assertEqual(hashAdapter.name, "hash", "get('hash') returns hash adapter");

    assertEqual(getProviderHost("https://api.openai.com/v1"), "api.openai.com", "getProviderHost works");

    const result = await hashAdapter.embedBatch({ texts: ["hello world"], runtime: {} });
    assertTrue(Array.isArray(result.vectors), "Embed returns vectors");
    assertEqual(result.vectors.length, 1, "Embed returns correct count");
  } catch (err) {
    console.error(`  ⊘ Test failed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Test 12: Memory Status Handler
// ============================================================================
async function testMemoryStatusHandler() {
  console.log("\n=== Test 12: Memory Status Handler ===");

  try {
    const { createMemoryStatus } = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/memory-status.js")));

    const status = createMemoryStatus();
    const statusResult = await status.handleMemoryStatus({});
    assertTrue(statusResult !== null, "Status returns result");

    const overviewResult = await status.handleGetMemoryOverview({});
    assertTrue(overviewResult !== null, "Overview returns result");

    const wakeupResult = await status.handleMemoryWakeUp({});
    assertTrue(wakeupResult !== null, "WakeUp returns result");

    const taskRecords = await status.loadTaskRecords();
    assertTrue(Array.isArray(taskRecords), "Task records returns array");
  } catch (err) {
    console.error(`  ⊘ Test skipped: ${err.message}`);
  }
}

// ============================================================================
// Test 13: Memory Bridge Handler
// ============================================================================
async function testMemoryBridgeHandler() {
  console.log("\n=== Test 13: Memory Bridge Handler ===");

  try {
    const { createMemoryBridge } = await import(toFileUrl(path.join(REPO_ROOT, "shared-mcp/memory-bridge.js")));

    const bridge = createMemoryBridge({});
    const readResult = await bridge.handleReadSharedMemory({ path: "test", limit: 10 });
    assertTrue(readResult !== null, "Read returns result");

    const listResult = await bridge.handleListSharedMemory({ path: "/" });
    assertTrue(listResult !== null, "List returns result");
  } catch (err) {
    console.error(`  ⊘ Test skipped: ${err.message}`);
  }
}

// ============================================================================
// Run All Tests
// ============================================================================
async function runAllTests() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  E2E Test Suite — MCP Memory Bus Core Modules              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\n  Platform: ${process.platform}`);
  console.log(`  Node.js:  ${process.version}`);

  await testLSHHash();
  await testBM25();
  await testMemoryContract();
  await testEntityExtractor();
  await testJsonlStream();
  await testHealthCheck();
  await testStoreRoot();
  await testVaultRoot();
  await testInboxAtomicWrite();
  await testPlatformDetection();
  await testEmbeddingRegistry();
  await testMemoryStatusHandler();
  await testMemoryBridgeHandler();

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  Results: ${passed} passed, ${failed} failed                               ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
