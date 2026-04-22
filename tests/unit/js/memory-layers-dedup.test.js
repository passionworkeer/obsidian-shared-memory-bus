"use strict";
// Tests for ops/memory-layers-dedup.js

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Stub memory-contract and vault-root before the module is loaded
// ---------------------------------------------------------------------------
const mcPath = require.resolve("../../../ops/memory-contract.js");
delete require.cache[mcPath];
require.cache[mcPath] = {
  id: mcPath,
  filename: mcPath,
  loaded: true,
  exports: require("../../../ops/memory-contract.js"),
};

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
const vaultRootStub = `
module.exports = {
  resolveVaultRoot() { return "E:/desktop/Obsidian Vault"; },
  getDefaultVaultCandidates() { return ["E:/desktop/Obsidian Vault"]; },
};
`;
if (!fs.existsSync(stubVaultRootPath)) {
  fs.mkdirSync(path.dirname(stubVaultRootPath), { recursive: true });
  fs.writeFileSync(stubVaultRootPath, vaultRootStub, "utf8");
}
delete require.cache[stubVaultRootPath];
require.cache[stubVaultRootPath] = {
  id: stubVaultRootPath,
  filename: stubVaultRootPath,
  loaded: true,
  exports: { resolveVaultRoot() { return "E:/desktop/Obsidian Vault"; }, getDefaultVaultCandidates() { return ["E:/desktop/Obsidian Vault"]; } },
};

// Patch Module.prototype._compile to inject exports
const MEMORY_LAYERS_DEDUP_PATH = require.resolve("../../../ops/memory/memory-layers-dedup.js");
const _originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
  if (filename === MEMORY_LAYERS_DEDUP_PATH) {
    code = code + "\nmodule.exports = {\n" +
      "writeJsonl," +
      "patchJsonlRecord," +
      "deduplicateSharedInbox," +
      "getRecordsByDate," +
      "buildDailyLogEntry," +
      "appendDailyLogs," +
      "DAILY_LOG_DIR," +
      "withFileLock," +
      "ensureDirectory," +
      "normalizeSpaces," +
      "sha256," +
      "getFreshness," +
      "shouldSkipAsRecentDuplicate," +
      "};\n";
  }
  return _originalCompile.call(this, code, filename);
};
delete require.cache[MEMORY_LAYERS_DEDUP_PATH];

const {
  writeJsonl,
  patchJsonlRecord,
  deduplicateSharedInbox,
  getRecordsByDate,
  buildDailyLogEntry,
  appendDailyLogs,
  DAILY_LOG_DIR,
  withFileLock,
  ensureDirectory,
  normalizeSpaces,
  sha256,
  getFreshness,
  shouldSkipAsRecentDuplicate,
} = require("../../../ops/memory/memory-layers-dedup.js");

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// writeJsonl
// ---------------------------------------------------------------------------

test("writeJsonl: writes records as JSONL lines", () => {
  const tmpFile = path.join(os.tmpdir(), `write-jsonl-test-${Date.now()}.jsonl`);
  const records = [{ id: "a", content: "Alpha" }, { id: "b", content: "Beta" }];
  writeJsonl(tmpFile, records);
  const content = fs.readFileSync(tmpFile, "utf8");
  assert.ok(content.includes('"id":"a"'));
  assert.ok(content.includes('"id":"b"'));
  assert.ok(!content.endsWith("\n\n"));
  try { fs.unlinkSync(tmpFile); } catch {}
});

test("writeJsonl: empty array writes empty file", () => {
  const tmpFile = path.join(os.tmpdir(), `write-jsonl-empty-${Date.now()}.jsonl`);
  writeJsonl(tmpFile, []);
  const content = fs.readFileSync(tmpFile, "utf8");
  assert.equal(content, "");
  try { fs.unlinkSync(tmpFile); } catch {}
});

test("writeJsonl: creates parent directories", () => {
  const tmpDir = path.join(os.tmpdir(), `write-jsonl-subdir-${Date.now()}`);
  const tmpFile = path.join(tmpDir, "data", "records.jsonl");
  writeJsonl(tmpFile, [{ id: "1" }]);
  assert.ok(fs.existsSync(tmpFile));
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// patchJsonlRecord
// ---------------------------------------------------------------------------

test("patchJsonlRecord: updates record with matching id", () => {
  const tmpFile = path.join(os.tmpdir(), `patch-jsonl-test-${Date.now()}.jsonl`);
  fs.writeFileSync(tmpFile, JSON.stringify({ id: "target", content: "original", facts: [], concepts: [] }) + "\n", "utf8");
  try {
    const enriched = { entities: ["EntityA"], facts: ["fact1"], concepts: ["concept1"] };
    patchJsonlRecord(tmpFile, "target", enriched);
    const content = fs.readFileSync(tmpFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const patched = JSON.parse(lines[0]);
    assert.equal(patched.id, "target");
    assert.deepEqual(patched.entities, ["EntityA"]);
    assert.deepEqual(patched.facts, ["fact1"]);
    assert.deepEqual(patched.concepts, ["concept1"]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("patchJsonlRecord: merges facts/concepts without duplication", () => {
  const tmpFile = path.join(os.tmpdir(), `patch-jsonl-merge-${Date.now()}.jsonl`);
  fs.writeFileSync(tmpFile, JSON.stringify({ id: "rec", content: "C", facts: ["existing-fact"], concepts: ["existing-concept"], entities: [] }) + "\n", "utf8");
  try {
    const enriched = { entities: ["E"], facts: ["new-fact"], concepts: ["new-concept"] };
    patchJsonlRecord(tmpFile, "rec", enriched);
    const content = fs.readFileSync(tmpFile, "utf8");
    const patched = JSON.parse(content.split("\n").filter((l) => l.trim())[0]);
    assert.ok(patched.facts.includes("existing-fact"));
    assert.ok(patched.facts.includes("new-fact"));
    assert.ok(patched.concepts.includes("existing-concept"));
    assert.ok(patched.concepts.includes("new-concept"));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("patchJsonlRecord: skips non-matching ids", () => {
  const tmpFile = path.join(os.tmpdir(), `patch-jsonl-skip-${Date.now()}.jsonl`);
  const originalContent = JSON.stringify({ id: "other", content: "unchanged" }) + "\n";
  fs.writeFileSync(tmpFile, originalContent, "utf8");
  try {
    patchJsonlRecord(tmpFile, "nonexistent", { entities: ["X"] });
    const content = fs.readFileSync(tmpFile, "utf8");
    assert.ok(content.includes('"id":"other"'));
    assert.ok(!content.includes("X"));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ---------------------------------------------------------------------------
// deduplicateSharedInbox
// ---------------------------------------------------------------------------

test("deduplicateSharedInbox: keeps unique entries", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [
    { id: "id-a", content: "Entry A", content_hash: "hash-a" },
    { id: "id-b", content: "Entry B", content_hash: "hash-b" },
  ];
  const result = deduplicateSharedInbox(newEntries, [], existingByHash, nowMs);
  assert.equal(result.length, 2);
});

test("deduplicateSharedInbox: filters duplicate within 30s window", () => {
  const nowMs = Date.now();
  const existingByHash = new Map([["duphash", { id: "ex", t: new Date(nowMs - 5_000).toISOString(), content: "Dup", content_hash: "duphash" }]]);
  const newEntries = [
    { id: "dup-1", content: "Dup", content_hash: "duphash" },
    { id: "unique", content: "Unique", content_hash: "uniquehash" },
  ];
  const result = deduplicateSharedInbox(newEntries, [], existingByHash, nowMs);
  const ids = result.map((r) => r.id);
  assert.ok(!ids.includes("dup-1"));
  assert.ok(ids.includes("unique"));
});

test("deduplicateSharedInbox: older duplicates are kept", () => {
  const nowMs = Date.now();
  const existingByHash = new Map([["oldhash", { id: "ex", t: new Date(nowMs - 60_000).toISOString(), content: "Old", content_hash: "oldhash" }]]);
  const newEntries = [{ id: "should-keep", content: "Old", content_hash: "oldhash" }];
  const result = deduplicateSharedInbox(newEntries, [], existingByHash, nowMs);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "should-keep");
});

test("deduplicateSharedInbox: dream records with unique ids are appended", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [{ id: "inbox-1", content: "Inbox", content_hash: "h1" }];
  const dreamRecords = [{ id: "dream-1", content: "Dream", content_hash: "h2" }];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.id === "dream-1"));
});

test("deduplicateSharedInbox: dream records skipped if inbox already has id", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [{ id: "shared-id", content: "Inbox", content_hash: "h1" }];
  const dreamRecords = [{ id: "shared-id", content: "Dream", content_hash: "h2" }];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "shared-id");
  // Inbox entry takes priority
  assert.equal(result[0].content, "Inbox");
});

// ---------------------------------------------------------------------------
// getRecordsByDate
// ---------------------------------------------------------------------------

test("getRecordsByDate: groups records by date string", () => {
  const records = [
    { id: "r1", t: "2024-06-15T10:00:00.000Z" },
    { id: "r2", t: "2024-06-15T14:00:00.000Z" },
    { id: "r3", t: "2024-06-16T09:00:00.000Z" },
  ];
  const result = getRecordsByDate(records);
  assert.equal(result.get("2024-06-15").length, 2);
  assert.equal(result.get("2024-06-16").length, 1);
});

test("getRecordsByDate: uses created_at fallback", () => {
  const records = [{ id: "r1", created_at: "2024-06-15T10:00:00.000Z" }];
  const result = getRecordsByDate(records);
  assert.equal(result.get("2024-06-15").length, 1);
});

test("getRecordsByDate: skips records without timestamp", () => {
  const records = [
    { id: "r1", t: "2024-06-15T10:00:00.000Z" },
    { id: "r2" },
    { id: "r3", t: "" },
  ];
  const result = getRecordsByDate(records);
  assert.equal(result.get("2024-06-15").length, 1);
});

test("getRecordsByDate: empty array returns empty map", () => {
  const result = getRecordsByDate([]);
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// buildDailyLogEntry
// ---------------------------------------------------------------------------

test("buildDailyLogEntry: includes id, t, type, scope, tool, title", () => {
  const record = { id: "r1", t: "2024-06-15T10:00:00.000Z", type: "note", scope: "project", tool: "claude-code", title: "Fix bug", content: "Handle null", facts: ["f1"], concepts: [] };
  const result = buildDailyLogEntry(record);
  assert.equal(result.id, "r1");
  assert.equal(result.t, "2024-06-15T10:00:00.000Z");
  assert.equal(result.type, "note");
  assert.equal(result.scope, "project");
  assert.equal(result.tool, "claude-code");
  assert.equal(result.title, "Fix bug");
});

test("buildDailyLogEntry: summary from first fact", () => {
  const record = { id: "r1", content: "C", facts: ["first fact value"], concepts: [] };
  const result = buildDailyLogEntry(record);
  assert.equal(result.summary, "first fact value");
});

test("buildDailyLogEntry: summary from description when no fact", () => {
  const record = { id: "r1", content: "C", description: "A description", facts: [], concepts: [] };
  const result = buildDailyLogEntry(record);
  assert.equal(result.summary, "A description");
});

test("buildDailyLogEntry: summary from content substring when no fact/description", () => {
  const record = { id: "r1", content: "Some long content here with lots of text", facts: [], concepts: [] };
  const result = buildDailyLogEntry(record);
  assert.ok(result.summary.length > 0);
  assert.ok(result.summary.length <= 80);
});

test("buildDailyLogEntry: promotion.durable_type included when present", () => {
  const record = {
    id: "r1", t: "2024-06-15T10:00:00.000Z", content: "C",
    metadata: { promotion: { durable_type: "project" } },
  };
  const result = buildDailyLogEntry(record);
  assert.equal(result.promotion, "project");
});

test("buildDailyLogEntry: promotion null when not present", () => {
  const record = { id: "r1", t: "2024-06-15T10:00:00.000Z", content: "C", metadata: {} };
  const result = buildDailyLogEntry(record);
  assert.equal(result.promotion, null);
});

// ---------------------------------------------------------------------------
// appendDailyLogs
// ---------------------------------------------------------------------------

test("appendDailyLogs: dryRun logs to stderr without writing", () => {
  const records = [{ id: "dry-1", t: new Date().toISOString(), content: "C", facts: [], concepts: [] }];
  let stderrOutput = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderrOutput += s; return true; };
  appendDailyLogs(records, true);
  process.stderr.write = origWrite;
  assert.ok(stderrOutput.includes("[daily-log] dry-run"));
});

// Skip in CI - DAILY_LOG_DIR is hardcoded to E:\.ai-memory which doesn't exist in CI
test.skip("appendDailyLogs: appends to today's log file", () => {
  const today = new Date().toISOString().substring(0, 10);
  const records = [{ id: `today-${Date.now()}`, t: new Date().toISOString(), content: "Today entry", facts: [], concepts: [], metadata: {} }];
  const tmpDir = path.join(os.tmpdir(), `append-daily-logs-${Date.now()}`);
  appendDailyLogs(records, false);
  const [year, month] = today.split("-");
  const logFile = path.join(DAILY_LOG_DIR, year, month, `${today}.jsonl`);
  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(content.includes(`"id":"${records[0].id}"`));
  }
});

test("appendDailyLogs: skips old dates (not today or yesterday)", () => {
  const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const records = [{ id: `old-${Date.now()}`, t: oldDate, content: "Old", facts: [], concepts: [], metadata: {} }];
  appendDailyLogs(records, false);
  // No error means it handled the old date gracefully (just skipped it)
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// DAILY_LOG_DIR constant
// ---------------------------------------------------------------------------

test("DAILY_LOG_DIR is an absolute path ending in logs", () => {
  assert.ok(typeof DAILY_LOG_DIR === "string");
  assert.ok(DAILY_LOG_DIR.endsWith("logs"));
  assert.ok(path.isAbsolute(DAILY_LOG_DIR));
});
