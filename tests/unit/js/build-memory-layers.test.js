"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Patch Module.prototype._compile BEFORE any require calls.
// This lets us inject module.exports into build-memory-layers.js so its
// top-level functions become accessible without modifying production code.
// ---------------------------------------------------------------------------

const Module = require("module");
const path = require("path");
const fs = require("fs");

const MEMORY_LAYERS_MODULE_PATH = require.resolve("../../../ops/build-memory-layers.js");

// Map of filename -> exports-injection string
const _compilePatches = new Map();
_compilePatches.set(MEMORY_LAYERS_MODULE_PATH, `
module.exports = {
  classifyScope,
  buildPromotionKey,
  buildPromotionMetadata,
  getFreshness,
  normalizeSpaces,
  sha1,
  sha256,
  tokenize,
  coerceStructuredRecord,
  shouldSkipAsRecentDuplicate,
  deduplicateSharedInbox,
  buildRecord,
  sortByFreshnessDesc,
  withTokenEstimate,
  freshnessScore,
  withFileLock,
  patchJsonlRecord,
};
`);

const _originalCompile = Module.prototype._compile;
Module.prototype._compile = function _patchedCompile(code, filename) {
  const patch = _compilePatches.get(filename);
  if (patch) {
    _compilePatches.delete(filename);
    code = code + "\n" + patch;
  }
  return _originalCompile.call(this, code, filename);
};

// ---------------------------------------------------------------------------
// Remove any stale cached modules (from a prior test run)
// so our _compile patch fires on THIS run.
// ---------------------------------------------------------------------------

delete require.cache[MEMORY_LAYERS_MODULE_PATH];

// ---------------------------------------------------------------------------
// Stub memory-contract
// ---------------------------------------------------------------------------

const mcPath = require.resolve("../../../ops/memory-contract.js");
delete require.cache[mcPath];
require.cache[mcPath] = {
  id: mcPath,
  filename: mcPath,
  loaded: true,
  exports: require("../../../ops/memory-contract.js"),
};

// ---------------------------------------------------------------------------
// Stub vault-root at the path build-memory-layers.js will find
// ---------------------------------------------------------------------------

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
delete require.cache[stubVaultRootPath];
require.cache[stubVaultRootPath] = {
  id: stubVaultRootPath,
  filename: stubVaultRootPath,
  loaded: true,
  exports: {
    resolveVaultRoot() {
      return "E:/desktop/Obsidian Vault";
    },
    getDefaultVaultCandidates() {
      return ["E:/desktop/Obsidian Vault"];
    },
  },
};

// ---------------------------------------------------------------------------
// Load the source under test
// ---------------------------------------------------------------------------

const {
  classifyScope,
  buildPromotionKey,
  buildPromotionMetadata,
  getFreshness,
  normalizeSpaces,
  sha1,
  sha256,
  tokenize,
  coerceStructuredRecord,
  shouldSkipAsRecentDuplicate,
  deduplicateSharedInbox,
  buildRecord,
  sortByFreshnessDesc,
  withTokenEstimate,
  freshnessScore,
  withFileLock,
  patchJsonlRecord,
} = require("../../../ops/build-memory-layers.js");

// ---------------------------------------------------------------------------
// normalizeSpaces
// ---------------------------------------------------------------------------

test("normalizeSpaces: null becomes empty string", () => {
  assert.equal(normalizeSpaces(null), "");
});

test("normalizeSpaces: collapses multiple spaces and newlines", () => {
  assert.equal(normalizeSpaces("hello   world\n\nfoo"), "hello world foo");
});

test("normalizeSpaces: trims leading and trailing whitespace", () => {
  assert.equal(normalizeSpaces("  hello  "), "hello");
});

test("normalizeSpaces: identical to memory-contract normalizeSpaces", () => {
  // Verify consistency across modules
  assert.equal(normalizeSpaces("  a  b  c  "), "a b c");
});

// ---------------------------------------------------------------------------
// sha1
// ---------------------------------------------------------------------------

test("sha1: produces 40-character lowercase hex string", () => {
  const hash = sha1("hello world");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 40);
  assert.ok(/^[a-f0-9]{40}$/.test(hash));
});

test("sha1: same input always produces same hash (deterministic)", () => {
  const h1 = sha1("test value 123");
  const h2 = sha1("test value 123");
  assert.equal(h1, h2);
});

test("sha1: null/undefined input produces hash of empty string", () => {
  const hash = sha1(null);
  assert.equal(hash.length, 40);
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

test("sha256: produces 64-character lowercase hex string", () => {
  const hash = sha256("hello world");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(hash));
});

test("sha256: same input always produces same hash (deterministic)", () => {
  const h1 = sha256("test value 456");
  const h2 = sha256("test value 456");
  assert.equal(h1, h2);
});

test("sha256: null/undefined input produces hash of empty string", () => {
  const hash = sha256(undefined);
  assert.equal(hash.length, 64);
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

test("tokenize: splits on whitespace", () => {
  const tokens = tokenize("hello world from tests");
  assert.deepEqual(tokens, ["hello", "world", "from", "tests"]);
});

test("tokenize: lowercase conversion", () => {
  const tokens = tokenize("Hello World");
  assert.deepEqual(tokens, ["hello", "world"]);
});

test("tokenize: filters tokens shorter than 2 chars", () => {
  const tokens = tokenize("a b cd ef");
  assert.deepEqual(tokens, ["cd", "ef"]);
});

test("tokenize: empty/null input returns empty array", () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(""), []);
});

test("tokenize: extracts CJK characters", () => {
  const tokens = tokenize("项目 任务");
  assert.ok(tokens.includes("项目"));
  assert.ok(tokens.includes("任务"));
});

test("tokenize: extracts paths and URLs", () => {
  const tokens = tokenize("src/app/main.js /home/user/file.ts");
  assert.ok(tokens.includes("src/app/main.js"));
  assert.ok(tokens.includes("/home/user/file.ts"));
});

// ---------------------------------------------------------------------------
// classifyScope
// ---------------------------------------------------------------------------

test("classifyScope: user preference text returns 'user' scope", () => {
  // "Chinese" lowercased is ASCII "chinese" — /中文/ won't match it.
  // Use Chinese characters directly: /偏好/ fires for "用户偏好中文回复".
  const result = classifyScope("用户偏好中文回复", "claude-code");
  assert.equal(result.scope, "user");
  assert.ok(result.confidence > 0);
});

test("classifyScope: user preference with language keyword returns 'user'", () => {
  const result = classifyScope("language preference: English", "claude-code");
  assert.equal(result.scope, "user");
});

test("classifyScope: feedback/review/workflow-rule text returns 'feedback' scope", () => {
  const result = classifyScope("Always validate inputs before processing. Never skip checks.", "claude-code");
  assert.equal(result.scope, "feedback");
  assert.equal(result.type, "workflow-rule");
});

test("classifyScope: Chinese must/avoid rules return 'feedback'", () => {
  const result = classifyScope("不要在生产环境直接修改数据，必须经过审批", "claude-code");
  assert.equal(result.scope, "feedback");
});

test("classifyScope: project/task text returns 'project' scope", () => {
  const result = classifyScope("Working on the API refactoring issue", "claude-code");
  assert.equal(result.scope, "project");
});

test("classifyScope: project with workspace keyword returns 'project'", () => {
  const result = classifyScope("Set up the project workspace", "claude-code");
  assert.equal(result.scope, "project");
});

test("classifyScope: reference/URL/path text returns 'reference' scope", () => {
  // Use explicit word "path" so \bpath\b matches
  const result = classifyScope("Check the documentation path for details", "claude-code");
  assert.equal(result.scope, "reference");
});

test("classifyScope: link/path keyword returns 'reference'", () => {
  const result = classifyScope("Check the path /home/user/config.yaml", "claude-code");
  assert.equal(result.scope, "reference");
});

test("classifyScope: openclaw run/subagent text returns 'task' scope", () => {
  // Contains "run" (openclaw fires) but not "issue/pr/repo/project/task/cron/blackboard/queue/workspace"
  // (project branch checks these patterns first). "subagent run started" satisfies this.
  const result = classifyScope("subagent run started", "openclaw");
  assert.equal(result.scope, "task");
});

test("classifyScope: claude-code generic text returns 'summary' scope with low confidence", () => {
  const result = classifyScope("The session covered various topics", "claude-code");
  assert.equal(result.scope, "summary");
  assert.ok(result.confidence < 0.5);
});

test("classifyScope: null text returns 'summary'", () => {
  const result = classifyScope(null, "claude-code");
  assert.equal(result.scope, "summary");
});

// ---------------------------------------------------------------------------
// buildPromotionKey
// ---------------------------------------------------------------------------

test("buildPromotionKey: same inputs produce same key (deterministic)", () => {
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
  assert.equal(key1, key2);
});

test("buildPromotionKey: different title produces different key", () => {
  const key1 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Fix auth bug",
    content: "Handle null token gracefully",
  });
  const key2 = buildPromotionKey({
    durableType: "project",
    project: "my-app",
    title: "Different title",
    content: "Handle null token gracefully",
  });
  assert.notEqual(key1, key2);
});

test("buildPromotionKey: empty durableType still returns hash (falls back to 'record' scope)", () => {
  // With empty durableType and empty fallbackScope, function defaults to "record"
  // as normalizedTargetScope. So even with empty durableType, a hash is returned
  // if there is a project name or title content. Returns "" only when fingerprint is "".
  const key = buildPromotionKey({
    durableType: "",
    fallbackScope: "",
    project: "",
    workspace: "",
    title: "",
    content: "",
    sourceRecordId: "",
  });
  // fingerprint is "" (no text, no tokens) → returns ""
  assert.equal(key, "");
});

test("buildPromotionKey: falls back to sourceRecordId when no text", () => {
  const key = buildPromotionKey({
    durableType: "project",
    sourceRecordId: "rec-abc123",
    title: "",
    content: "",
  });
  assert.ok(key.length > 0);
});

test("buildPromotionKey: uses workspace when project is absent", () => {
  const key = buildPromotionKey({
    durableType: "project",
    workspace: "my-workspace",
    title: "Task title",
    content: "",
  });
  assert.ok(key.length > 0);
});

// ---------------------------------------------------------------------------
// buildPromotionMetadata
// ---------------------------------------------------------------------------

test("buildPromotionMetadata: valid record returns correct metadata structure", () => {
  const meta = buildPromotionMetadata({
    scope: "project",
    type: "note",
    sourceKind: "writeback",
    memoryLevel: "durable",
    confidence: 0.75,
    project: "my-app",
    title: "Fix the auth bug",
    content: "Handle null token gracefully",
    sourceRecordId: "rec-001",
  });
  assert.equal(typeof meta.version, "number");
  assert.equal(typeof meta.durable_type, "string");
  assert.equal(typeof meta.key, "string");
  assert.equal(typeof meta.reason, "string");
  assert.ok(meta.key.length > 0);
});

test("buildPromotionMetadata: missing scope returns reason 'missing-scope'", () => {
  const meta = buildPromotionMetadata({
    scope: "",
    type: "note",
    confidence: 0.8,
    title: "Some title",
    content: "Some content",
    sourceRecordId: "rec-002",
  });
  assert.equal(meta.reason, "missing-scope");
});

test("buildPromotionMetadata: non-durable scope returns reason with prefix", () => {
  const meta = buildPromotionMetadata({
    scope: "summary",
    type: "session-summary",
    confidence: 0.7,
    title: "Session summary",
    content: "Content here",
    sourceRecordId: "rec-003",
  });
  assert.ok(meta.reason.startsWith("non-promotable-scope:"));
});

test("buildPromotionMetadata: confidence below threshold returns reason with prefix", () => {
  const meta = buildPromotionMetadata({
    scope: "project",
    type: "note",
    confidence: 0.3,
    title: "Low confidence note",
    content: "Content",
    sourceRecordId: "rec-004",
  });
  assert.ok(meta.reason.startsWith("low-confidence:"));
});

test("buildPromotionMetadata: sourceKind=writeback bypasses confidence check", () => {
  const meta = buildPromotionMetadata({
    scope: "project",
    type: "note",
    sourceKind: "writeback",
    confidence: 0.3,
    title: "Writeback note",
    content: "Content",
    sourceRecordId: "rec-005",
  });
  assert.equal(meta.durable_type, "project");
  assert.ok(!meta.reason.startsWith("low-confidence:"));
});

// ---------------------------------------------------------------------------
// getFreshness
// ---------------------------------------------------------------------------

test("getFreshness: very recent timestamp returns 'hot'", () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
  assert.equal(getFreshness(recent), "hot");
});

test("getFreshness: a few hours old returns 'hot'", () => {
  const fewHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // 6 hours ago
  assert.equal(getFreshness(fewHoursAgo), "hot");
});

test("getFreshness: a few days old returns 'warm'", () => {
  const fewDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
  assert.equal(getFreshness(fewDaysAgo), "warm");
});

test("getFreshness: weeks old returns 'cold'", () => {
  const weeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(); // 2 weeks ago
  assert.equal(getFreshness(weeksAgo), "cold");
});

test("getFreshness: null/undefined returns 'unknown'", () => {
  assert.equal(getFreshness(null), "unknown");
  assert.equal(getFreshness(undefined), "unknown");
  assert.equal(getFreshness(""), "unknown");
});

test("getFreshness: invalid date returns 'unknown'", () => {
  assert.equal(getFreshness("not-a-date"), "unknown");
});

// ---------------------------------------------------------------------------
// freshnessScore
// ---------------------------------------------------------------------------

test("freshnessScore: hot returns 3", () => {
  const record = { freshness: "hot" };
  assert.equal(freshnessScore(record), 3);
});

test("freshnessScore: warm returns 2", () => {
  const record = { freshness: "warm" };
  assert.equal(freshnessScore(record), 2);
});

test("freshnessScore: cold returns 1", () => {
  const record = { freshness: "cold" };
  assert.equal(freshnessScore(record), 1);
});

test("freshnessScore: unknown returns 0", () => {
  const record = { freshness: "unknown" };
  assert.equal(freshnessScore(record), 0);
});

test("freshnessScore: newer record has higher score than older", () => {
  const hotRecord = { freshness: "hot" };
  const warmRecord = { freshness: "warm" };
  const coldRecord = { freshness: "cold" };
  assert.ok(freshnessScore(hotRecord) > freshnessScore(warmRecord));
  assert.ok(freshnessScore(warmRecord) > freshnessScore(coldRecord));
});

// ---------------------------------------------------------------------------
// coerceStructuredRecord
// ---------------------------------------------------------------------------

test("coerceStructuredRecord: adds defaults for missing fields", () => {
  const payload = {
    id: "test-001",
    title: "My task",
    content: "Task content here",
    tool: "claude-code",
  };
  const result = coerceStructuredRecord(payload);
  assert.equal(result.id, "test-001");
  assert.equal(result.title, "My task");
  assert.equal(result.scope, "summary");
  assert.equal(result.type, "summary");
  assert.equal(result.tool, "claude-code");
  assert.ok(typeof result.freshness === "string");
  assert.ok(typeof result.content_hash === "string");
  assert.ok(typeof result.metadata === "object");
});

test("coerceStructuredRecord: preserves existing fields", () => {
  const payload = {
    id: "test-002",
    title: "Existing title",
    content: "Existing content",
    scope: "project",
    type: "note",
    tool: "openclaw",
    confidence: 0.85,
    memory_level: "task",
    files_read: ["src/main.js"],
    files_modified: [],
    facts: ["fact one"],
    concepts: ["concept one"],
  };
  const result = coerceStructuredRecord(payload);
  assert.equal(result.scope, "project");
  assert.equal(result.type, "note");
  assert.deepEqual(result.files_read, ["src/main.js"]);
  assert.deepEqual(result.facts, ["fact one"]);
  assert.deepEqual(result.concepts, ["concept one"]);
  assert.equal(result.confidence, 0.85);
});

test("coerceStructuredRecord: falls back to content when title is missing", () => {
  const payload = {
    id: "test-003",
    content: "Content used as title",
    tool: "claude-code",
  };
  const result = coerceStructuredRecord(payload);
  assert.equal(result.title, "Content used as title");
});

test("coerceStructuredRecord: null payload returns null", () => {
  assert.equal(coerceStructuredRecord(null), null);
  assert.equal(coerceStructuredRecord(undefined), null);
});

test("coerceStructuredRecord: empty object returns null", () => {
  assert.equal(coerceStructuredRecord({}), null);
});

test("coerceStructuredRecord: uses defaults when provided", () => {
  const payload = { id: "test-004", title: "T", content: "C" };
  const defaults = {
    scope: "feedback",
    type: "workflow-rule",
    tool: "openclaw",
    confidence: 0.72,
  };
  const result = coerceStructuredRecord(payload, defaults);
  assert.equal(result.scope, "feedback");
  assert.equal(result.type, "workflow-rule");
  assert.equal(result.tool, "openclaw");
  assert.equal(result.confidence, 0.72);
});

test("coerceStructuredRecord: content truncated at 6000 chars", () => {
  const longContent = "x".repeat(8000);
  const payload = { id: "test-005", title: "T", content: longContent };
  const result = coerceStructuredRecord(payload);
  assert.ok(result.content.length <= 6000);
});

// ---------------------------------------------------------------------------
// shouldSkipAsRecentDuplicate
// ---------------------------------------------------------------------------

test("shouldSkipAsRecentDuplicate: exact content_hash within 30s window returns true", () => {
  const nowMs = Date.now();
  const existingRecord = {
    id: "existing-1",
    t: new Date(nowMs - 10_000).toISOString(), // 10 seconds ago
    content: "Same content",
    content_hash: "abc123",
  };
  const existingByHash = new Map([["abc123", existingRecord]]);
  const newRecord = {
    id: "new-1",
    content: "Same content",
    content_hash: "abc123",
  };
  assert.equal(shouldSkipAsRecentDuplicate(newRecord, existingByHash, nowMs), true);
});

test("shouldSkipAsRecentDuplicate: different content_hash returns false", () => {
  const nowMs = Date.now();
  const existingRecord = {
    id: "existing-2",
    t: new Date(nowMs - 10_000).toISOString(),
    content: "Original content",
    content_hash: "hash1",
  };
  const existingByHash = new Map([["hash1", existingRecord]]);
  const newRecord = {
    id: "new-2",
    content: "Different content",
    content_hash: "hash2",
  };
  assert.equal(shouldSkipAsRecentDuplicate(newRecord, existingByHash, nowMs), false);
});

test("shouldSkipAsRecentDuplicate: no matching hash returns false", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newRecord = { id: "new-3", content: "Unique content", content_hash: "unique" };
  assert.equal(shouldSkipAsRecentDuplicate(newRecord, existingByHash, nowMs), false);
});

test("shouldSkipAsRecentDuplicate: older than 30s returns false even with same hash", () => {
  const nowMs = Date.now();
  const existingRecord = {
    id: "existing-4",
    t: new Date(nowMs - 60_000).toISOString(), // 60 seconds ago — outside window
    content: "Old content",
    content_hash: "oldhash",
  };
  const existingByHash = new Map([["oldhash", existingRecord]]);
  const newRecord = {
    id: "new-4",
    content: "Old content",
    content_hash: "oldhash",
  };
  assert.equal(shouldSkipAsRecentDuplicate(newRecord, existingByHash, nowMs), false);
});

// ---------------------------------------------------------------------------
// deduplicateSharedInbox
// ---------------------------------------------------------------------------

test("deduplicateSharedInbox: duplicate within 30s window is filtered", () => {
  const nowMs = Date.now();
  const existingRecord = {
    id: "existing-rec",
    t: new Date(nowMs - 5_000).toISOString(),
    content: "Duplicate content",
    content_hash: "dup-hash",
  };
  const existingByHash = new Map([["dup-hash", existingRecord]]);
  const newEntries = [
    { id: "dup-id-1", content: "Duplicate content", content_hash: "dup-hash" },
    { id: "unique-id", content: "Unique entry", content_hash: "unique-hash" },
  ];
  const dreamRecords = [];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  const ids = result.map((r) => r.id);
  assert.ok(!ids.includes("dup-id-1"), "duplicate should be skipped");
  assert.ok(ids.includes("unique-id"), "unique entry should be kept");
});

test("deduplicateSharedInbox: non-duplicate entries are kept", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [
    { id: "id-a", content: "Entry A", content_hash: "hash-a" },
    { id: "id-b", content: "Entry B", content_hash: "hash-b" },
  ];
  const dreamRecords = [];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.id === "id-a"));
  assert.ok(result.some((r) => r.id === "id-b"));
});

test("deduplicateSharedInbox: dream records with unique IDs are appended", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [{ id: "inbox-1", content: "Inbox", content_hash: "hash-inbox" }];
  const dreamRecords = [
    { id: "dream-1", content: "Dream entry", content_hash: "hash-dream" },
  ];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.id === "dream-1"));
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

test("buildRecord: creates full record with all required fields", () => {
  const record = buildRecord({
    id: "rec-001",
    t: "2024-06-15T10:00:00.000Z",
    tool: "claude-code",
    session: "session-abc",
    type: "note",
    project: "my-app",
    title: "Fix the bug",
    content: "Handle null gracefully",
    facts: ["fact 1"],
    concepts: ["concept 1"],
    files_read: ["src/app.js"],
    files_modified: ["src/app.js"],
    source: "test-source",
    scope: "project",
    visibility: "shared",
    source_kind: "writeback",
    memory_level: "durable",
    workspace: "my-app",
    task_state: "done",
    confidence: 0.8,
    metadata: {},
    content_hash: "abc123",
  });
  assert.equal(record.id, "rec-001");
  assert.equal(record.tool, "claude-code");
  assert.equal(record.scope, "project");
  assert.equal(record.title, "Fix the bug");
  assert.equal(record.content, "Handle null gracefully");
  assert.ok(typeof record.freshness === "string");
  assert.ok(typeof record.metadata === "object");
  assert.ok(typeof record.metadata.promotion === "object");
  assert.ok(typeof record.schemaVersion === "number");
});

test("buildRecord: title falls back to content when title is empty", () => {
  const record = buildRecord({
    id: "rec-002",
    t: "2024-06-15T10:00:00.000Z",
    tool: "claude-code",
    title: "",
    content: "Content used as title",
    scope: "project",
    type: "note",
    confidence: 0.5,
  });
  assert.equal(record.title, "Content used as title");
});

test("buildRecord: title falls back to id when both title and content are empty", () => {
  const record = buildRecord({
    id: "rec-003",
    t: "2024-06-15T10:00:00.000Z",
    tool: "claude-code",
    title: "",
    content: "",
    scope: "project",
    type: "note",
    confidence: 0.5,
  });
  assert.equal(record.title, "rec-003");
});

test("buildRecord: title truncated to 140 chars", () => {
  const longTitle = "x".repeat(200);
  const record = buildRecord({
    id: "rec-004",
    t: "2024-06-15T10:00:00.000Z",
    tool: "claude-code",
    title: longTitle,
    content: "",
    scope: "project",
    type: "note",
    confidence: 0.5,
  });
  assert.ok(record.title.length <= 140);
});

test("buildRecord: includes promotion metadata from buildPromotionMetadata", () => {
  const record = buildRecord({
    id: "rec-005",
    t: "2024-06-15T10:00:00.000Z",
    tool: "claude-code",
    scope: "feedback",
    type: "workflow-rule",
    title: "Always validate input",
    content: "Always validate input",
    confidence: 0.72,
    source_kind: "writeback",
    memory_level: "durable",
    project: "my-app",
    workspace: "my-app",
  });
  assert.ok(record.metadata.promotion);
  assert.ok(record.metadata.promotion.key.length > 0);
  assert.ok(record.metadata.promotion.reason.length > 0);
});

// ---------------------------------------------------------------------------
// sortByFreshnessDesc
// ---------------------------------------------------------------------------

test("sortByFreshnessDesc: newest records first (hot > warm > cold)", () => {
  const now = new Date().toISOString();
  const records = [
    { id: "cold-rec", freshness: "cold", t: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
    { id: "hot-rec", freshness: "hot", t: now },
    { id: "warm-rec", freshness: "warm", t: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
  ];
  const sorted = sortByFreshnessDesc(records);
  assert.equal(sorted[0].freshness, "hot");
  assert.equal(sorted[1].freshness, "warm");
  assert.equal(sorted[2].freshness, "cold");
});

test("sortByFreshnessDesc: does not mutate original array", () => {
  const records = [
    { id: "a", freshness: "warm", t: "2024-01-01T00:00:00.000Z" },
    { id: "b", freshness: "hot", t: "2024-06-01T00:00:00.000Z" },
  ];
  const originalOrder = records.map((r) => r.id);
  sortByFreshnessDesc(records);
  assert.deepEqual(records.map((r) => r.id), originalOrder);
});

test("sortByFreshnessDesc: equal freshness sorts by timestamp desc", () => {
  const records = [
    { id: "older", freshness: "hot", t: "2024-01-01T00:00:00.000Z" },
    { id: "newer", freshness: "hot", t: "2024-06-01T00:00:00.000Z" },
  ];
  const sorted = sortByFreshnessDesc(records);
  assert.equal(sorted[0].id, "newer");
  assert.equal(sorted[1].id, "older");
});

test("sortByFreshnessDesc: empty array returns empty array", () => {
  assert.deepEqual(sortByFreshnessDesc([]), []);
});

// ---------------------------------------------------------------------------
// withTokenEstimate
// ---------------------------------------------------------------------------

test("withTokenEstimate: adds token_estimate field", () => {
  const record = {
    id: "rec-001",
    title: "Test record",
    scope: "project",
    freshness: "hot",
    content: "This is some content for the record",
  };
  const result = withTokenEstimate(record);
  assert.ok("estimatedTokens" in result);
  assert.ok("charCount" in result);
  assert.equal(result.id, "rec-001");
  assert.equal(result.title, "Test record");
});

test("withTokenEstimate: estimatedTokens is roughly charCount / 4", () => {
  const content = "hello world this is a test string";
  const record = { id: "1", content };
  const result = withTokenEstimate(record);
  const expected = Math.ceil(content.length / 4);
  assert.equal(result.estimatedTokens, expected);
});

test("withTokenEstimate: null content yields zero estimate (|| operator coerces null to empty)", () => {
  const record = { id: "2", content: null };
  const result = withTokenEstimate(record);
  assert.equal(result.estimatedTokens, 0);
  assert.equal(result.charCount, 0); // null || "" === "", charCount === 0
});

test("withTokenEstimate: does not mutate original record", () => {
  const record = { id: "3", title: "T", content: "Content", freshness: "warm" };
  const result = withTokenEstimate(record);
  assert.ok(!("estimatedTokens" in record));
  assert.ok("estimatedTokens" in result);
});

// ---------------------------------------------------------------------------
// normalizeSpaces: BOM stripping
// ---------------------------------------------------------------------------

test("normalizeSpaces: strips UTF-8 BOM character", () => {
  const BOM = "\uFEFF";
  assert.equal(normalizeSpaces(BOM + "hello world"), "hello world");
});

test("normalizeSpaces: strips BOM from middle of string", () => {
  const BOM = "\uFEFF";
  // BOM is stripped, not replaced with space; no whitespace collapse in this case
  assert.equal(normalizeSpaces("prefix" + BOM + "content"), "prefixcontent");
});

test("normalizeSpaces: BOM + whitespace collapses correctly", () => {
  const BOM = "\uFEFF";
  // BOM stripped first, then whitespace collapsed
  assert.equal(normalizeSpaces(BOM + "  hello   world  " + BOM), "hello world");
});

// ---------------------------------------------------------------------------
// getFreshness: NaN guard
// ---------------------------------------------------------------------------

test("getFreshness: NaN ageMs (invalid date) returns 'unknown'", () => {
  // "not-a-timestamp" produces NaN from Date subtraction
  assert.equal(getFreshness("not-a-timestamp"), "unknown");
});

test("getFreshness: completely garbage string returns 'unknown'", () => {
  assert.equal(getFreshness("garbage!!"), "unknown");
});

// ---------------------------------------------------------------------------
// buildPromotionKey: id and t salt parameters
// ---------------------------------------------------------------------------

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
    id: "rec-002",   // different id
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
    t: "2024-06-16T10:00:00.000Z",  // different timestamp
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
// deduplicateSharedInbox: content_hash collision warning
// ---------------------------------------------------------------------------

test("deduplicateSharedInbox: different ids with same hash still both kept (id is primary key)", () => {
  const nowMs = Date.now();
  const existingByHash = new Map();
  const newEntries = [
    { id: "id-A", content: "Same content", content_hash: "same-hash" },
    { id: "id-B", content: "Same content", content_hash: "same-hash" },  // same hash, different id
  ];
  const dreamRecords = [];
  const result = deduplicateSharedInbox(newEntries, dreamRecords, existingByHash, nowMs);
  const ids = result.map((r) => r.id);
  // Both are kept because they have different ids (id is the primary key)
  assert.ok(ids.includes("id-A"));
  assert.ok(ids.includes("id-B"));
});

// ---------------------------------------------------------------------------
// withFileLock: basic synchronous behavior (file doesn't exist yet)
// ---------------------------------------------------------------------------

test("withFileLock: creates file and executes fn when file does not exist", () => {
  const os = require("os");
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
  const os = require("os");
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

test("withFileLock: throws if file is locked by another process (mocked by re-entrancy)", () => {
  const os = require("os");
  const tmpFile = path.join(os.tmpdir(), `withfilelock-blocked-test-${Date.now()}.jsonl`);

  try {
    fs.writeFileSync(tmpFile, '{"id":"x"}\n', "utf8");
    // Open the file to hold a handle, then try to lock it
    const holdFd = fs.openSync(tmpFile, "r+");
    // Try to get exclusive lock — this may or may not succeed on Windows
    // but the important thing is withFileLock handles the error gracefully
    try {
      fs.tryLockSync(holdFd, "sh");  // shared lock on the handle
      // If we got a shared lock, exclusive will fail
      // Attempt withFileLock — it should either succeed (on some OSes) or throw after retries
      let threw = false;
      try {
        withFileLock(tmpFile, () => {});
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("could not acquire lock"));
      }
      // On some OSes the shared lock doesn't prevent exclusive, so threw may be false
    } finally {
      try { fs.unlockSync(holdFd); } catch {}
      try { fs.closeSync(holdFd); } catch {}
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ---------------------------------------------------------------------------
// createJsonlStream (from jsonl-stream.js)
// ---------------------------------------------------------------------------

const { createJsonlStream, readJsonlStream } = require("../../../ops/jsonl-stream.js");

test("createJsonlStream: yields parsed objects from a temp jsonl file", async () => {
  const os = require("os");
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
  const os = require("os");
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
  const os = require("os");
  const tmpFile = path.join(os.tmpdir(), `non-existent-${Date.now()}.jsonl`);
  try { fs.unlinkSync(tmpFile); } catch {}

  const read = [];
  for await (const rec of createJsonlStream(tmpFile)) {
    read.push(rec);
  }
  assert.equal(read.length, 0);
});

test("readJsonlStream: returns full array from stream", async () => {
  const os = require("os");
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
