"use strict";
// Integration tests for ops/build-memory-layers.js
// Verifies the refactored main module imports from submodules correctly.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Stub vault-root so build-memory-layers.js can be loaded without side effects
// ---------------------------------------------------------------------------

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
const vaultRootStub = `
module.exports = {
  resolveVaultRoot() {
    return "E:/desktop/Obsidian Vault";
  },
  getDefaultVaultCandidates() {
    return ["E:/desktop/Obsidian Vault"];
  },
};
`;

if (!fs.existsSync(stubVaultRootPath)) {
  fs.mkdirSync(path.dirname(stubVaultRootPath), { recursive: true });
  fs.writeFileSync(stubVaultRootPath, vaultRootStub, "utf8");
}

// ---------------------------------------------------------------------------
// Stub store-root so build-memory-layers.js can be loaded
// ---------------------------------------------------------------------------

const stubStoreRootPath = path.join(__dirname, "..", "..", "..", "bus", "store-root.js");
const storeRootStub = `
module.exports = {
  resolveStoreRoot() {
    // Always read env at call time so test beforeEach can override the store root
    return process.env.AI_MEMORY_STORE ||
      process.env.AI_MEMORY_STORE_ROOT ||
      "E:/desktop/.ai-memory";
  },
};
`;

// Always write the stub so it gets updated (the file may have been created by a
// previous run with stale content that ignored AI_MEMORY_STORE)
fs.writeFileSync(stubStoreRootPath, storeRootStub, "utf8");

// ---------------------------------------------------------------------------
// Prevent main() from running and inject exports
// ---------------------------------------------------------------------------
const Module = require("module");
const originalCompile = Module.prototype._compile;
const BML_FILE = "build-memory-layers";
const BML_PATH = require.resolve("../../../ops/build/build-memory-layers.js");

const _origCompile = Module.prototype._compile;
Module.prototype._compile = function _patchedCompile(code, filename) {
  if (filename === BML_PATH) {
    // Stub both async main().catch(...) and synchronous main() calls
    code = code
      .replace(/\bmain\(\)\.catch\([\s\S]*?\);?/g, "// main() async stubbed by test")
      .replace(/\bmain\(\);/g, "// main() sync stubbed by test");
    // Append exports AFTER the patched code so they override any real module.exports
    code = code + "\nmodule.exports = {\n" +
      "normalizeSpaces,getFreshness,buildPromotionKey,withFileLock," +
      "deduplicateSharedInbox," +
      "loadStoreRootHelper,resolveStoreRoot," +
      "MEMORY_RECORD_SCHEMA_VERSION," +
      "};\n";
  }
  return _origCompile.call(this, code, filename);
};

// ---------------------------------------------------------------------------
// Force fresh load: clear require cache so the _compile hook applies
// ---------------------------------------------------------------------------
delete require.cache[BML_PATH];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("build-memory-layers.js loads without errors", () => {
  // If the module loads, all requires (including submodules) succeeded
  const mod = require("../../../ops/build/build-memory-layers.js");
  assert.ok(mod !== null && typeof mod === "object");
});

test("loadStoreRootHelper is a function", () => {
  const { loadStoreRootHelper } = require("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof loadStoreRootHelper, "function");
});

test("normalizeSpaces imported from parse module", () => {
  const { normalizeSpaces } = require("../../../ops/build/build-memory-layers.js");
  assert.equal(normalizeSpaces("  hello   world  "), "hello world");
});

test("getFreshness imported from parse module", () => {
  const { getFreshness } = require("../../../ops/build/build-memory-layers.js");
  // 2024 date is "cold" in 2026 (well beyond 7-day warm threshold)
  assert.equal(getFreshness("2024-01-01T00:00:00.000Z"), "cold");
  // null/undefined timestamp → "unknown"
  assert.equal(getFreshness(null), "unknown");
  assert.equal(getFreshness(""), "unknown");
  assert.equal(getFreshness(new Date(Date.now() - 5 * 60 * 1000).toISOString()), "hot");
});

test("buildPromotionKey imported from parse module", () => {
  const { buildPromotionKey } = require("../../../ops/build/build-memory-layers.js");
  const k1 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  const k2 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  assert.equal(k1, k2);
});

test("withFileLock imported from parse module", () => {
  const { withFileLock } = require("../../../ops/build/build-memory-layers.js");
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

test("deduplicateSharedInbox imported from dedup module", () => {
  const { deduplicateSharedInbox } = require("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof deduplicateSharedInbox, "function");
  const nowMs = Date.now();
  const result = deduplicateSharedInbox([], [], new Map(), nowMs);
  assert.ok(Array.isArray(result));
});

test("MEMORY_RECORD_SCHEMA_VERSION is imported from memory-contract", () => {
  const { MEMORY_RECORD_SCHEMA_VERSION } = require("../../../ops/build/build-memory-layers.js");
  assert.equal(typeof MEMORY_RECORD_SCHEMA_VERSION, "number");
  assert.ok(MEMORY_RECORD_SCHEMA_VERSION > 0);
});
