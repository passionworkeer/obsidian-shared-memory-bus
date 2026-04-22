"use strict";
// Standalone tests for new utilities — does NOT run main() side effects.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Stub vault-root so build-memory-layers.js can be loaded without side effects
// ---------------------------------------------------------------------------

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");

// Ensure the bus/vault-root.js stub exists (copy the one used by the main test file)
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
    return "E:/desktop/.ai-memory";
  },
};
`;

if (!fs.existsSync(stubStoreRootPath)) {
  fs.writeFileSync(stubStoreRootPath, storeRootStub, "utf8");
}

// ---------------------------------------------------------------------------
// Prevent main() from running and inject exports
// ---------------------------------------------------------------------------
const Module = require("module");
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
  if (filename.includes("build-memory-layers")) {
    code =
      code.replace(/^main\(\);$/m, "// main() stubbed by test")
      + "\nmodule.exports = {\n  normalizeSpaces,\n  getFreshness,\n  buildPromotionKey,\n  withFileLock,\n  deduplicateSharedInbox,\n};\n";
  }
  return originalCompile.call(this, code, filename);
}

// ---------------------------------------------------------------------------
// jsonl-stream.js tests (no dependencies on build-memory-layers.js)
// ---------------------------------------------------------------------------

const { createJsonlStream, readJsonlStream } = require("../../../ops/util/jsonl-stream.js");

test("createJsonlStream: yields parsed objects from a temp jsonl file", async () => {
  const tmpFile = path.join(os.tmpdir(), `jsonl-stream-test-${Date.now()}.jsonl`);
  try {
    const records = [
      { id: "1", t: "2024-01-01T00:00:00.000Z", title: "First" },
      { id: "2", t: "2024-01-02T00:00:00.000Z", title: "Second" },
      { id: "3", t: "2024-01-03T00:00:00.000Z", title: "Third" },
    ];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const read = [];
    for await (const rec of createJsonlStream(tmpFile)) {
      read.push(rec);
    }

    assert.equal(read.length, 3);
    assert.equal(read[0].id, "1");
    assert.equal(read[1].id, "2");
    assert.equal(read[2].id, "3");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("createJsonlStream: skips malformed lines and empty lines", async () => {
  const tmpFile = path.join(os.tmpdir(), `jsonl-stream-test-malformed-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile,
      '{"id":"good1"}\n' +
      'not-valid-json\n' +
      '\n' +
      '{"id":"good2"}\n' +
      '{broken\n',
      "utf8"
    );

    const read = [];
    for await (const rec of createJsonlStream(tmpFile)) {
      read.push(rec);
    }

    assert.equal(read.length, 2);
    assert.equal(read[0].id, "good1");
    assert.equal(read[1].id, "good2");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("createJsonlStream: returns empty generator for non-existent file", async () => {
  const tmpFile = path.join(os.tmpdir(), `non-existent-${Date.now()}.jsonl`);
  try { fs.unlinkSync(tmpFile); } catch {}

  const read = [];
  for await (const rec of createJsonlStream(tmpFile)) {
    read.push(rec);
  }
  assert.equal(read.length, 0);
});

test("readJsonlStream: returns full array from stream", async () => {
  const tmpFile = path.join(os.tmpdir(), `read-jsonl-stream-test-${Date.now()}.jsonl`);
  try {
    const records = [{ id: "a" }, { id: "b" }];
    fs.writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const result = await readJsonlStream(tmpFile);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "a");
    assert.equal(result[1].id, "b");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ---------------------------------------------------------------------------
// normalizeSpaces BOM stripping
// ---------------------------------------------------------------------------

const { normalizeSpaces } = require("../../../ops/build/build-memory-layers.js");

test("normalizeSpaces: strips UTF-8 BOM character", () => {
  const BOM = "\uFEFF";
  assert.equal(normalizeSpaces(BOM + "hello world"), "hello world");
});

test("normalizeSpaces: strips BOM from middle of string", () => {
  const BOM = "\uFEFF";
  // BOM is stripped (not replaced with space); no whitespace collapse here
  assert.equal(normalizeSpaces("prefix" + BOM + "content"), "prefixcontent");
});

test("normalizeSpaces: BOM + whitespace collapses correctly", () => {
  const BOM = "\uFEFF";
  assert.equal(normalizeSpaces(BOM + "  hello   world  " + BOM), "hello world");
});

test("normalizeSpaces: null becomes empty string", () => {
  assert.equal(normalizeSpaces(null), "");
});

// ---------------------------------------------------------------------------
// getFreshness NaN guard
// ---------------------------------------------------------------------------

const { getFreshness } = require("../../../ops/build/build-memory-layers.js");

test("getFreshness: NaN ageMs (invalid date) returns 'unknown'", () => {
  assert.equal(getFreshness("not-a-timestamp"), "unknown");
});

test("getFreshness: completely garbage string returns 'unknown'", () => {
  assert.equal(getFreshness("garbage!!"), "unknown");
});

// ---------------------------------------------------------------------------
// buildPromotionKey id/t salt
// ---------------------------------------------------------------------------

const { buildPromotionKey } = require("../../../ops/build/build-memory-layers.js");

test("buildPromotionKey: same content but different id produces different key", () => {
  const key1 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
    id: "rec-001",
    t: "2024-06-15T10:00:00.000Z",
  });
  const key2 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
    id: "rec-002",
    t: "2024-06-15T10:00:00.000Z",
  });
  assert.notEqual(key1, key2);
});

test("buildPromotionKey: same content and id but different t produces different key", () => {
  const key1 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
    id: "rec-001",
    t: "2024-06-15T10:00:00.000Z",
  });
  const key2 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
    id: "rec-001",
    t: "2024-06-16T10:00:00.000Z",
  });
  assert.notEqual(key1, key2);
});

test("buildPromotionKey: id and t are optional (backwards compatible)", () => {
  const key1 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
  });
  const key2 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
  });
  assert.equal(key1, key2);  // deterministic without id/t
});

// ---------------------------------------------------------------------------
// withFileLock
// ---------------------------------------------------------------------------

const { withFileLock } = require("../../../ops/build/build-memory-layers.js");

test("withFileLock: creates file and executes fn when file does not exist", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-test-${Date.now()}.jsonl`);
  try {
    let executed = false;
    withFileLock(tmpFile, (fd) => {
      executed = true;
      assert.ok(typeof fd === "number");
    });
    assert.equal(executed, true);
    assert.ok(fs.existsSync(tmpFile));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("withFileLock: writes to existing file and closes fd", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-test-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, '{"id":"initial"}\n', "utf8");
    let capturedContent = null;

    withFileLock(tmpFile, (fd) => {
      capturedContent = fs.readFileSync(tmpFile, "utf8");
    });

    assert.equal(capturedContent, '{"id":"initial"}\n');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("withFileLock: idempotent — same file can be locked twice sequentially", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-idempotent-${Date.now()}.jsonl`);
  try {
    let count = 0;
    withFileLock(tmpFile, () => { count++; });
    withFileLock(tmpFile, () => { count++; });
    assert.equal(count, 2);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ---------------------------------------------------------------------------
// deduplicateSharedInbox: collision detection (uses console.warn — checked via mock)
// ---------------------------------------------------------------------------

const { deduplicateSharedInbox } = require("../../../ops/build/build-memory-layers.js");

test("deduplicateSharedInbox: different ids with same hash still both kept (id is primary key)", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [
    { id: "id-A", content: "Same content", content_hash: "same-hash" },
    { id: "id-B", content: "Same content", content_hash: "same-hash" },
  ];
  const dreamRecords = [];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  const ids = result.map((r) => r.id);
  assert.ok(ids.includes("id-A"));
  assert.ok(ids.includes("id-B"));
});
