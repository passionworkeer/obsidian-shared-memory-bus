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
// Prevent main() from running and inject exports
// ---------------------------------------------------------------------------
const Module = require("module");
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
  if (filename.includes("build-memory-layers")) {
    // Replace async main() call (main().catch(...)) with a no-op to prevent
    // side-effects during module load. Also handles legacy synchronous main();.
    code =
      code.replace(/^main\(\)(\.catch\(.*\))?;$/m, "// main() stubbed by test")
      + "\nmodule.exports = {\n" +
      "normalizeSpaces,getFreshness,buildPromotionKey,withFileLock," +
      "deduplicateSharedInbox," +
      "loadStoreRootHelper,resolveStoreRoot," +
      "MEMORY_RECORD_SCHEMA_VERSION," +
      "};\n";
  }
  return originalCompile.call(this, code, filename);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("build-memory-layers.js loads without errors", () => {
  // If the module loads, all requires (including submodules) succeeded
  const mod = require("../../../ops/build-memory-layers.js");
  assert.ok(mod !== null && typeof mod === "object");
});

test("loadStoreRootHelper is a function", () => {
  const { loadStoreRootHelper } = require("../../../ops/build-memory-layers.js");
  assert.equal(typeof loadStoreRootHelper, "function");
});

test("normalizeSpaces imported from parse module", () => {
  const { normalizeSpaces } = require("../../../ops/build-memory-layers.js");
  assert.equal(normalizeSpaces("  hello   world  "), "hello world");
});

test("getFreshness imported from parse module", () => {
  const { getFreshness } = require("../../../ops/build-memory-layers.js");
  // 2024 date is "cold" in 2026 (well beyond 7-day warm threshold)
  assert.equal(getFreshness("2024-01-01T00:00:00.000Z"), "cold");
  // null/undefined timestamp → "unknown"
  assert.equal(getFreshness(null), "unknown");
  assert.equal(getFreshness(""), "unknown");
  assert.equal(getFreshness(new Date(Date.now() - 5 * 60 * 1000).toISOString()), "hot");
});

test("buildPromotionKey imported from parse module", () => {
  const { buildPromotionKey } = require("../../../ops/build-memory-layers.js");
  const k1 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  const k2 = buildPromotionKey({ durableType: "project", project: "app", title: "T", content: "C" });
  assert.equal(k1, k2);
});

test("withFileLock imported from parse module", () => {
  const { withFileLock } = require("../../../ops/build-memory-layers.js");
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
  const { deduplicateSharedInbox } = require("../../../ops/build-memory-layers.js");
  assert.equal(typeof deduplicateSharedInbox, "function");
  const nowMs = Date.now();
  const result = deduplicateSharedInbox([], [], new Map(), nowMs);
  assert.ok(Array.isArray(result));
});

test("MEMORY_RECORD_SCHEMA_VERSION is imported from memory-contract", () => {
  const { MEMORY_RECORD_SCHEMA_VERSION } = require("../../../ops/build-memory-layers.js");
  assert.equal(typeof MEMORY_RECORD_SCHEMA_VERSION, "number");
  assert.ok(MEMORY_RECORD_SCHEMA_VERSION > 0);
});
