import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Stub vault-root so build-memory-layers.js can be loaded without side effects
// ---------------------------------------------------------------------------

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
const vaultRootStub = `
export function resolveVaultRoot() {
  return "E:/desktop/Obsidian Vault";
}
export function getDefaultVaultCandidates() {
  return ["E:/desktop/Obsidian Vault"];
}
export default { resolveVaultRoot, getDefaultVaultCandidates };
`;

fs.mkdirSync(path.dirname(stubVaultRootPath), { recursive: true });
fs.writeFileSync(stubVaultRootPath, vaultRootStub, "utf8");

// ---------------------------------------------------------------------------
// Stub store-root so build-memory-layers.js can be loaded
// ---------------------------------------------------------------------------

const stubStoreRootPath = path.join(__dirname, "..", "..", "..", "bus", "store-root.js");
const storeRootStub = `
import path from "node:path";
import os from "node:os";
export function resolveStoreRoot() {
  return (
    process.env.AI_MEMORY_STORE ||
    process.env.AI_MEMORY_STORE_ROOT ||
    process.env.AI_MEMORY_ROOT ||
    path.join(os.homedir(), ".ai-memory")
  );
}
export function getProjectsRoot(storeRoot) {
  return path.join(storeRoot, "projects");
}
export function getContextPath(storeRoot) {
  return path.join(storeRoot, "CONTEXT.md");
}
export function getDefaultStoreCandidates() {
  return [path.join(os.homedir(), '.ai-memory')];
}
export default { resolveStoreRoot, getProjectsRoot, getContextPath, getDefaultStoreCandidates };
`;

// Always write the stub so it gets updated (the file may have been created by a
// previous run with stale content that ignored AI_MEMORY_STORE)
fs.writeFileSync(stubStoreRootPath, storeRootStub, "utf8");

// ---------------------------------------------------------------------------
// Prevent main() from running and inject exports
// ---------------------------------------------------------------------------
// ESM Note: require.cache not available in ESM, dynamic imports used instead
const BML_FILE = "build-memory-layers";
const BML_PATH = import.meta.resolve("../../../ops/build/build-memory-layers.js");

// ESM Note: Module.prototype._compile patching is not available in ESM

// ESM note: require.cache not available in ESM, dynamic imports used instead

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("build-memory-layers.js loads without errors", async () => {
  // If the module loads, all requires (including submodules) succeeded
  const mod = await import("../../../ops/build/build-memory-layers.js");
  assert.ok(mod !== null && typeof mod === "object");
});

test("loadStoreRootHelper is a function", async () => {
  const { loadStoreRootHelper } = await import("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof loadStoreRootHelper, "function");
});

test("normalizeSpaces imported from parse module", async () => {
  const { normalizeSpaces } = await import("../../../ops/build/build-memory-layers.js");
  assert.equal(normalizeSpaces("  hello   world  "), "hello world");
});

test("getFreshness imported from parse module", async () => {
  const { getFreshness } = await import("../../../ops/build/build-memory-layers.js");
  // 2024 date is "cold" in 2026 (well beyond 7-day warm threshold)
  assert.equal(getFreshness("2024-01-01T00:00:00.000Z"), "cold");
  // null/undefined timestamp → "unknown"
  assert.equal(getFreshness(null), "unknown");
  assert.equal(getFreshness(""), "unknown");
  assert.equal(getFreshness(new Date(Date.now() - 5 * 60 * 1000).toISOString()), "hot");
});

test("buildPromotionKey imported from parse module", async () => {
  const { buildPromotionKey } = await import("../../../ops/build/build-memory-layers.js");
  const k1 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  const k2 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  assert.equal(k1, k2);
});

test("withFileLock imported from parse module", async () => {
  const { withFileLock } = await import("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof withFileLock, "function");
  const tmpFile = path.join(os.tmpdir(), `bml-test-lock-${Date.now()}.jsonl`);
  try {
    let ran = false;
    withFileLock(tmpFile, () => { ran = true; });
    assert.equal(ran, true);
    assert.ok(fs.existsSync(tmpFile));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("deduplicateSharedInbox imported from dedup module", async () => {
  const { deduplicateSharedInbox } = await import("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof deduplicateSharedInbox, "function");
  const nowMs = Date.now();
  const result = deduplicateSharedInbox([], [], new Map(), nowMs);
  assert.ok(Array.isArray(result));
});

test("MEMORY_RECORD_SCHEMA_VERSION is imported from memory-contract", async () => {
  const { MEMORY_RECORD_SCHEMA_VERSION } = await import("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof MEMORY_RECORD_SCHEMA_VERSION, "number");
  assert.ok(MEMORY_RECORD_SCHEMA_VERSION > 0);
});
