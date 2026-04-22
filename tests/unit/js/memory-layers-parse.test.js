"use strict";
// Tests for ops/memory-layers-parse.js

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Stub memory-contract and vault-root before the module is loaded
// ---------------------------------------------------------------------------
  exports: require("../../../ops/memory/memory-contract.js"),
delete require.cache[mcPath];
require.cache[mcPath] = {
  id: mcPath,
  filename: mcPath,
  loaded: true,
  exports: require("../../../ops/memory/memory-contract.js"),
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
const MEMORY_LAYERS_PARSE_PATH = require.resolve("../../../ops/memory/memory-layers-parse.js");
const _originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
  if (filename === MEMORY_LAYERS_PARSE_PATH) {
    code = code + "\nmodule.exports = {\n" +
      "normalizeSpaces,sha1,sha256,parseTimestamp,classifyScope,buildPromotionKey," +
      "buildPromotionMetadata,buildMemoryDescription,computeTier,buildRecord,getTargetJsonl," +
      "readJsonl,readText,writeText,ensureDirectory,withFileLock," +
      "parseInboxEntries,parseEventEntries," +
      "parseStructuredJsonl,coerceStructuredRecord,repairStructuredRecord,preserveDreamRecords," +
      "loadEntityExtractor,loadKnowledgeGraph," +
      "USER_HOME,OPENCLAW_HOME,CLAUDE_HOME,INBOX_ROOT,EVENTS_ROOT,STRUCTURED_ROOT," +
      "GENERATED_ROOT,STORE_ROOT,AI_MEMORY_ROOT," +
      "SHARED_INBOX_JSONL,DREAM_INBOX_JSONL,SESSION_MEMORY_JSONL,SHARED_EVENTS_JSONL," +
      "TASK_MEMORY_JSONL,CLAUDE_CODE_JSONL,OPENCLAW_SESSIONS_JSONL," +
      "OPENCLAW_BLACKBOARD_JSONL,OPENCLAW_RUNS_JSONL,OPENCLAW_JOBS_JSONL,OPENCLAW_JOURNAL_JSONL," +
      "DAILY_LOG_DIR,DURABLE_SCOPES,MIN_PROMOTION_CONFIDENCE," +
      "shouldSkipAsRecentDuplicate,getFreshness,tokenize," +
      "NON_PROMOTABLE_PROMOTION_TYPES," +
      "loadStructuredRecords," +
      "};\n";
  }
  return _originalCompile.call(this, code, filename);
};
delete require.cache[MEMORY_LAYERS_PARSE_PATH];

const {
  normalizeSpaces, sha1, sha256, parseTimestamp, classifyScope,
  buildPromotionKey, buildPromotionMetadata, buildMemoryDescription,
  computeTier, buildRecord, getTargetJsonl,
  readJsonl, readText, writeText, ensureDirectory, withFileLock,
  parseInboxEntries, parseEventEntries,
  parseStructuredJsonl, coerceStructuredRecord, repairStructuredRecord, preserveDreamRecords,
  loadEntityExtractor, loadKnowledgeGraph,
  USER_HOME, OPENCLAW_HOME, CLAUDE_HOME, INBOX_ROOT, EVENTS_ROOT, STRUCTURED_ROOT,
  GENERATED_ROOT, STORE_ROOT, AI_MEMORY_ROOT,
  SHARED_INBOX_JSONL, DREAM_INBOX_JSONL, SESSION_MEMORY_JSONL, SHARED_EVENTS_JSONL,
  TASK_MEMORY_JSONL, CLAUDE_CODE_JSONL, OPENCLAW_SESSIONS_JSONL,
  OPENCLAW_BLACKBOARD_JSONL, OPENCLAW_RUNS_JSONL, OPENCLAW_JOBS_JSONL, OPENCLAW_JOURNAL_JSONL,
  DAILY_LOG_DIR, DURABLE_SCOPES, MIN_PROMOTION_CONFIDENCE,
  shouldSkipAsRecentDuplicate, getFreshness, tokenize,
  NON_PROMOTABLE_PROMOTION_TYPES,
  loadStructuredRecords,
} = require("../../../ops/memory/memory-layers-parse.js");

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

test("path constants are absolute strings", () => {
  assert.ok(typeof STORE_ROOT === "string");
  assert.ok(typeof AI_MEMORY_ROOT === "string");
  assert.ok(typeof INBOX_ROOT === "string");
  assert.ok(typeof STRUCTURED_ROOT === "string");
  assert.ok(typeof GENERATED_ROOT === "string");
  assert.ok(typeof SHARED_INBOX_JSONL === "string");
  assert.ok(typeof DAILY_LOG_DIR === "string");
  assert.ok(AI_MEMORY_ROOT === STORE_ROOT);
});

test("DURABLE_SCOPES is a Set with expected members", () => {
  assert.ok(DURABLE_SCOPES instanceof Set);
  assert.ok(DURABLE_SCOPES.has("user"));
  assert.ok(DURABLE_SCOPES.has("feedback"));
  assert.ok(DURABLE_SCOPES.has("project"));
  assert.ok(DURABLE_SCOPES.has("reference"));
});

test("MIN_PROMOTION_CONFIDENCE is 0.6", () => {
  assert.equal(MIN_PROMOTION_CONFIDENCE, 0.6);
});

test("NON_PROMOTABLE_PROMOTION_TYPES is a Set", () => {
  assert.ok(NON_PROMOTABLE_PROMOTION_TYPES instanceof Set);
  assert.ok(NON_PROMOTABLE_PROMOTION_TYPES.has("summary"));
  assert.ok(NON_PROMOTABLE_PROMOTION_TYPES.has("session-summary"));
  assert.ok(NON_PROMOTABLE_PROMOTION_TYPES.has("daily-summary"));
});

// ---------------------------------------------------------------------------
// normalizeSpaces
// ---------------------------------------------------------------------------

test("normalizeSpaces: null becomes empty string", () => {
  assert.equal(normalizeSpaces(null), "");
});

test("normalizeSpaces: collapses multiple spaces", () => {
  assert.equal(normalizeSpaces("hello   world\n\nfoo"), "hello world foo");
});

test("normalizeSpaces: strips UTF-8 BOM", () => {
  const BOM = "\uFEFF";
  assert.equal(normalizeSpaces(BOM + "hello world"), "hello world");
});

test("normalizeSpaces: BOM + whitespace collapses correctly", () => {
  const BOM = "\uFEFF";
  assert.equal(normalizeSpaces(BOM + "  hello   world  " + BOM), "hello world");
});

// ---------------------------------------------------------------------------
// sha1 / sha256
// ---------------------------------------------------------------------------

test("sha1: 40-char lowercase hex", () => {
  const h = sha1("hello");
  assert.equal(h.length, 40);
  assert.ok(/^[a-f0-9]{40}$/.test(h));
});

test("sha1: deterministic", () => {
  assert.equal(sha1("test"), sha1("test"));
});

test("sha256: 64-char lowercase hex", () => {
  const h = sha256("hello");
  assert.equal(h.length, 64);
  assert.ok(/^[a-f0-9]{64}$/.test(h));
});

test("sha256: deterministic", () => {
  assert.equal(sha256("test"), sha256("test"));
});

test("sha1: null input produces valid hash", () => {
  assert.equal(sha1(null).length, 40);
});

test("sha256: null input produces valid hash", () => {
  assert.equal(sha256(null).length, 64);
});

// ---------------------------------------------------------------------------
// parseTimestamp
// ---------------------------------------------------------------------------

test("parseTimestamp: ISO string passes through", () => {
  const ts = "2024-06-15T10:00:00.000Z";
  assert.equal(parseTimestamp(ts), ts);
});

test("parseTimestamp: space-separated datetime is normalized to ISO format", () => {
  const result = parseTimestamp("2024-06-15 10:00:00");
  assert.ok(result !== null);
  assert.ok(result.startsWith("2024-06-15"));
  assert.ok(result.includes("T"));
});

test("parseTimestamp: null returns null", () => {
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(""), null);
  assert.equal(parseTimestamp("garbage"), null);
});

// ---------------------------------------------------------------------------
// getFreshness
// ---------------------------------------------------------------------------

test("getFreshness: recent returns hot", () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.equal(getFreshness(recent), "hot");
});

test("getFreshness: a few days returns warm", () => {
  const fewDays = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(getFreshness(fewDays), "warm");
});

test("getFreshness: weeks old returns cold", () => {
  const weeks = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(getFreshness(weeks), "cold");
});

test("getFreshness: invalid date returns unknown", () => {
  assert.equal(getFreshness("not-a-date"), "unknown");
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

test("tokenize: splits on whitespace", () => {
  assert.deepEqual(tokenize("hello world from tests"), ["hello", "world", "from", "tests"]);
});

test("tokenize: lowercase conversion", () => {
  assert.deepEqual(tokenize("Hello World"), ["hello", "world"]);
});

test("tokenize: filters tokens shorter than 2 chars", () => {
  assert.deepEqual(tokenize("a b cd ef"), ["cd", "ef"]);
});

test("tokenize: extracts CJK", () => {
  const tokens = tokenize("项目 任务");
  assert.ok(tokens.includes("项目"));
  assert.ok(tokens.includes("任务"));
});

test("tokenize: empty/null input returns empty array", () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(""), []);
});

// ---------------------------------------------------------------------------
// classifyScope
// ---------------------------------------------------------------------------

test("classifyScope: Chinese preference keyword returns user scope", () => {
  const result = classifyScope("用户偏好中文回复", "claude-code");
  assert.equal(result.scope, "user");
  assert.ok(result.confidence > 0);
});

test("classifyScope: language keyword returns user scope", () => {
  assert.equal(classifyScope("language preference: English", "claude-code").scope, "user");
});

test("classifyScope: must/never returns feedback scope", () => {
  const result = classifyScope("Always validate inputs before processing. Never skip checks.", "claude-code");
  assert.equal(result.scope, "feedback");
  assert.equal(result.type, "workflow-rule");
});

test("classifyScope: Chinese avoid rules return feedback", () => {
  assert.equal(classifyScope("不要在生产环境直接修改数据，必须经过审批", "claude-code").scope, "feedback");
});

test("classifyScope: issue/PR keyword returns project scope", () => {
  assert.equal(classifyScope("Working on the API refactoring issue", "claude-code").scope, "project");
});

test("classifyScope: path keyword returns reference scope", () => {
  assert.equal(classifyScope("Check the documentation path for details", "claude-code").scope, "reference");
});

test("classifyScope: openclaw run/subagent returns task scope", () => {
  const result = classifyScope("subagent run started", "openclaw");
  assert.equal(result.scope, "task");
});

test("classifyScope: generic text returns summary scope", () => {
  const result = classifyScope("The session covered various topics", "claude-code");
  assert.equal(result.scope, "summary");
  assert.ok(result.confidence < 0.5);
});

test("classifyScope: null text returns summary", () => {
  assert.equal(classifyScope(null, "claude-code").scope, "summary");
});

// ---------------------------------------------------------------------------
// buildPromotionKey
// ---------------------------------------------------------------------------

test("buildPromotionKey: same inputs produce same key", () => {
  const k1 = buildPromotionKey({ durableType: "project", project: "my-app", title: "Fix auth bug", content: "Handle null gracefully" });
  const k2 = buildPromotionKey({ durableType: "project", project: "my-app", title: "Fix auth bug", content: "Handle null gracefully" });
  assert.equal(k1, k2);
});

test("buildPromotionKey: different id produces different key", () => {
  const k1 = buildPromotionKey({ durableType: "project", project: "my-app", title: "Fix auth bug", content: "H", id: "rec-001", t: "2024-06-15T10:00:00.000Z" });
  const k2 = buildPromotionKey({ durableType: "project", project: "my-app", title: "Fix auth bug", content: "H", id: "rec-002", t: "2024-06-15T10:00:00.000Z" });
  assert.notEqual(k1, k2);
});

test("buildPromotionKey: empty all fields returns empty string", () => {
  const key = buildPromotionKey({ durableType: "", fallbackScope: "", project: "", workspace: "", title: "", content: "", sourceRecordId: "" });
  assert.equal(key, "");
});

test("buildPromotionKey: workspace used when project is absent", () => {
  const key = buildPromotionKey({ durableType: "project", workspace: "my-workspace", title: "Task title", content: "" });
  assert.ok(key.length > 0);
});

// ---------------------------------------------------------------------------
// buildPromotionMetadata
// ---------------------------------------------------------------------------

test("buildPromotionMetadata: valid record returns metadata with key", () => {
  const meta = buildPromotionMetadata({
    scope: "project", type: "note", sourceKind: "writeback", memoryLevel: "durable",
    confidence: 0.75, project: "my-app", title: "Fix auth bug", content: "Handle null", sourceRecordId: "rec-001",
  });
  assert.equal(typeof meta.version, "number");
  assert.equal(typeof meta.durable_type, "string");
  assert.ok(meta.key.length > 0);
  assert.equal(typeof meta.reason, "string");
});

test("buildPromotionMetadata: missing scope returns missing-scope reason", () => {
  const meta = buildPromotionMetadata({ scope: "", type: "note", confidence: 0.8, title: "T", content: "C", sourceRecordId: "r" });
  assert.equal(meta.reason, "missing-scope");
});

test("buildPromotionMetadata: non-durable scope returns prefixed reason", () => {
  const meta = buildPromotionMetadata({ scope: "summary", type: "session-summary", confidence: 0.7, title: "S", content: "C", sourceRecordId: "r" });
  assert.ok(meta.reason.startsWith("non-promotable-scope:"));
});

test("buildPromotionMetadata: low confidence returns prefixed reason", () => {
  const meta = buildPromotionMetadata({ scope: "project", type: "note", confidence: 0.3, title: "Low", content: "C", sourceRecordId: "r" });
  assert.ok(meta.reason.startsWith("low-confidence:"));
});

test("buildPromotionMetadata: writeback bypasses confidence check", () => {
  const meta = buildPromotionMetadata({ scope: "project", type: "note", sourceKind: "writeback", confidence: 0.3, title: "W", content: "C", sourceRecordId: "r" });
  assert.equal(meta.durable_type, "project");
  assert.ok(!meta.reason.startsWith("low-confidence:"));
});

// ---------------------------------------------------------------------------
// computeTier
// ---------------------------------------------------------------------------

test("computeTier: event scope returns tier 1", () => {
  assert.equal(computeTier({ memory_level: "event", scope: "" }), 1);
  assert.equal(computeTier({ scope: "event" }), 1);
});

test("computeTier: writeback project returns tier 3", () => {
  assert.equal(computeTier({ source_kind: "writeback", scope: "project" }), 3);
});

test("computeTier: writeback non-project returns tier 4", () => {
  assert.equal(computeTier({ source_kind: "writeback", scope: "user" }), 4);
});

test("computeTier: durable project returns tier 3", () => {
  assert.equal(computeTier({ memory_level: "durable", scope: "project" }), 3);
});

test("computeTier: durable non-project returns tier 4", () => {
  assert.equal(computeTier({ memory_level: "durable", scope: "reference" }), 4);
});

test("computeTier: session/task scope returns tier 2", () => {
  assert.equal(computeTier({ memory_level: "session", scope: "" }), 2);
  assert.equal(computeTier({ scope: "session" }), 2);
  assert.equal(computeTier({ scope: "task" }), 2);
  assert.equal(computeTier({ scope: "run" }), 2);
  assert.equal(computeTier({ scope: "job" }), 2);
});

test("computeTier: default fallback returns tier 2", () => {
  assert.equal(computeTier({}), 2);
});

// ---------------------------------------------------------------------------
// buildMemoryDescription
// ---------------------------------------------------------------------------

test("buildMemoryDescription: uses first fact", () => {
  const r = { facts: ["first fact here"], content: "some content" };
  assert.equal(buildMemoryDescription(r), "first fact here");
});

test("buildMemoryDescription: falls back to first concept", () => {
  const r = { concepts: [{ value: ["concept value"] }], content: "some content" };
  assert.equal(buildMemoryDescription(r), "concept value");
});

test("buildMemoryDescription: falls back to content substring", () => {
  const r = { content: "some content text here" };
  assert.ok(buildMemoryDescription(r).includes("some"));
});

test("buildMemoryDescription: strips markdown", () => {
  const r = { content: "# Title\n**bold** and `code`" };
  assert.ok(!buildMemoryDescription(r).includes("#"));
  assert.ok(!buildMemoryDescription(r).includes("*"));
});

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

test("buildRecord: creates full record with required fields", () => {
  const record = buildRecord({
    id: "rec-001", t: "2024-06-15T10:00:00.000Z", tool: "claude-code",
    type: "note", project: "my-app", title: "Fix the bug", content: "Handle null gracefully",
    facts: ["fact 1"], concepts: ["concept 1"], files_read: ["src/app.js"],
    files_modified: ["src/app.js"], source: "test", scope: "project", visibility: "shared",
    source_kind: "writeback", memory_level: "durable", workspace: "my-app",
    task_state: "done", confidence: 0.8, metadata: {}, content_hash: "abc123",
  });
  assert.equal(record.id, "rec-001");
  assert.equal(record.scope, "project");
  assert.equal(record.tier, 3);
  assert.ok(typeof record.freshness === "string");
  assert.ok(typeof record.metadata === "object");
  assert.ok(typeof record.metadata.promotion === "object");
  assert.ok(typeof record.lifecycle === "object");
  assert.equal(record.lifecycle.tier, 3);
});

test("buildRecord: title falls back to content then id", () => {
  const r1 = buildRecord({ id: "r1", t: "2024-06-15T10:00:00.000Z", tool: "c", title: "", content: "Content title", scope: "project", type: "note", confidence: 0.5 });
  assert.equal(r1.title, "Content title");

  const r2 = buildRecord({ id: "fallback-id", t: "2024-06-15T10:00:00.000Z", tool: "c", title: "", content: "", scope: "project", type: "note", confidence: 0.5 });
  assert.equal(r2.title, "fallback-id");
});

test("buildRecord: title truncated to 140 chars", () => {
  const r = buildRecord({ id: "r", t: "2024-06-15T10:00:00.000Z", tool: "c", title: "x".repeat(200), content: "", scope: "project", type: "note", confidence: 0.5 });
  assert.ok(r.title.length <= 140);
});

test("buildRecord: includes promotion metadata", () => {
  const r = buildRecord({ id: "r", t: "2024-06-15T10:00:00.000Z", tool: "c", scope: "feedback", type: "workflow-rule", title: "Always validate", content: "Always validate", confidence: 0.72, source_kind: "writeback", memory_level: "durable", project: "app", workspace: "app" });
  assert.ok(r.metadata.promotion.key.length > 0);
  assert.ok(r.metadata.promotion.reason.length > 0);
});

test("buildRecord: expiresAt computed for feedback scope (90 days)", () => {
  const r = buildRecord({ id: "r", t: "2024-06-15T10:00:00.000Z", tool: "c", scope: "feedback", type: "workflow-rule", title: "T", content: "C", confidence: 0.7 });
  assert.ok(r.lifecycle.expires_at !== null);
  assert.ok(new Date(r.lifecycle.expires_at) > new Date("2024-06-15"));
});

test("buildRecord: user scope gets default 7-day expiry (ttl fallback via ?? 7)", () => {
  const r = buildRecord({ id: "r", t: "2024-06-15T10:00:00.000Z", tool: "c", scope: "user", type: "preference", title: "T", content: "C", confidence: 0.5 });
  // ttlByScope["user"] is null, so null ?? 7 = 7 days
  assert.ok(r.lifecycle.expires_at !== null);
  assert.ok(new Date(r.lifecycle.expires_at) > new Date("2024-06-15"));
});

// ---------------------------------------------------------------------------
// getTargetJsonl
// ---------------------------------------------------------------------------

test("getTargetJsonl: session scope returns SESSION_MEMORY_JSONL", () => {
  const result = getTargetJsonl({ scope: "session" });
  assert.equal(result, SESSION_MEMORY_JSONL);
});

test("getTargetJsonl: session level returns SESSION_MEMORY_JSONL", () => {
  const result = getTargetJsonl({ memory_level: "session" });
  assert.equal(result, SESSION_MEMORY_JSONL);
});

test("getTargetJsonl: task scope/type returns TASK_MEMORY_JSONL", () => {
  assert.equal(getTargetJsonl({ scope: "task" }), TASK_MEMORY_JSONL);
  assert.equal(getTargetJsonl({ type: "task-note" }), TASK_MEMORY_JSONL);
  assert.equal(getTargetJsonl({ type: "task-job" }), TASK_MEMORY_JSONL);
});

test("getTargetJsonl: event type/scope returns SHARED_EVENTS_JSONL", () => {
  assert.equal(getTargetJsonl({ type: "event" }), SHARED_EVENTS_JSONL);
  assert.equal(getTargetJsonl({ scope: "event" }), SHARED_EVENTS_JSONL);
});

test("getTargetJsonl: default returns SHARED_INBOX_JSONL", () => {
  assert.equal(getTargetJsonl({ scope: "project" }), SHARED_INBOX_JSONL);
  assert.equal(getTargetJsonl({}), SHARED_INBOX_JSONL);
});

// ---------------------------------------------------------------------------
// coerceStructuredRecord
// ---------------------------------------------------------------------------

test("coerceStructuredRecord: adds defaults for missing fields", () => {
  const payload = { id: "test-001", title: "My task", content: "Task content", tool: "claude-code" };
  const result = coerceStructuredRecord(payload);
  assert.equal(result.id, "test-001");
  assert.equal(result.scope, "summary");
  assert.equal(result.type, "summary");
  assert.equal(result.tool, "claude-code");
  assert.ok(typeof result.freshness === "string");
  assert.ok(typeof result.content_hash === "string");
  assert.ok(typeof result.metadata === "object");
});

test("coerceStructuredRecord: preserves existing fields", () => {
  const payload = { id: "test-002", title: "T", content: "C", scope: "project", type: "note", tool: "openclaw", confidence: 0.85, memory_level: "task", files_read: ["src/main.js"], facts: ["fact one"], concepts: ["concept one"] };
  const result = coerceStructuredRecord(payload);
  assert.equal(result.scope, "project");
  assert.equal(result.type, "note");
  assert.deepEqual(result.files_read, ["src/main.js"]);
  assert.deepEqual(result.facts, ["fact one"]);
  assert.deepEqual(result.concepts, ["concept one"]);
  assert.equal(result.confidence, 0.85);
});

test("coerceStructuredRecord: falls back to content when title missing", () => {
  const result = coerceStructuredRecord({ id: "test-003", content: "Content used as title" });
  assert.equal(result.title, "Content used as title");
});

test("coerceStructuredRecord: null/empty returns null", () => {
  assert.equal(coerceStructuredRecord(null), null);
  assert.equal(coerceStructuredRecord(undefined), null);
  assert.equal(coerceStructuredRecord({}), null);
});

test("coerceStructuredRecord: uses provided defaults", () => {
  const payload = { id: "test-004", title: "T", content: "C" };
  const defaults = { scope: "feedback", type: "workflow-rule", tool: "openclaw", confidence: 0.72 };
  const result = coerceStructuredRecord(payload, defaults);
  assert.equal(result.scope, "feedback");
  assert.equal(result.type, "workflow-rule");
  assert.equal(result.tool, "openclaw");
  assert.equal(result.confidence, 0.72);
});

test("coerceStructuredRecord: content truncated at 6000 chars", () => {
  const result = coerceStructuredRecord({ id: "t", title: "T", content: "x".repeat(8000) });
  assert.ok(result.content.length <= 6000);
});

test("coerceStructuredRecord: derives tier via computeTier", () => {
  const r = coerceStructuredRecord({ id: "t", content: "C", memory_level: "durable", scope: "project" });
  assert.equal(r.tier, 3);
});

test("coerceStructuredRecord: preserves existing lifecycle", () => {
  const existingLifecycle = { tier: 4, expires_at: "2025-01-01T00:00:00.000Z", access_count: 5, promotion_count: 1, archived: false };
  const r = coerceStructuredRecord({ id: "t", content: "C", lifecycle: existingLifecycle });
  assert.equal(r.lifecycle.tier, 4);
  assert.equal(r.lifecycle.access_count, 5);
});

// ---------------------------------------------------------------------------
// parseStructuredJsonl
// ---------------------------------------------------------------------------

test("parseStructuredJsonl: non-existent file returns empty array", () => {
  const result = parseStructuredJsonl("/non/existent/file.jsonl");
  assert.deepEqual(result, []);
});

test("parseStructuredJsonl: parses valid lines", () => {
  const tmpFile = path.join(os.tmpdir(), `parse-jsonl-test-${Date.now()}.jsonl`);
  try {
    const line1 = JSON.stringify({ id: "r1", title: "Rec 1", content: "Content 1", tool: "test" });
    const line2 = JSON.stringify({ id: "r2", title: "Rec 2", content: "Content 2", tool: "test" });
    fs.writeFileSync(tmpFile, `${line1}\n${line2}\n`, "utf8");
    const result = parseStructuredJsonl(tmpFile);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "r1");
    assert.equal(result[1].id, "r2");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("parseStructuredJsonl: skips malformed lines", () => {
  const tmpFile = path.join(os.tmpdir(), `parse-jsonl-malformed-${Date.now()}.jsonl`);
  try {
    // Valid lines need id + (title or content) for coerceStructuredRecord to accept them.
    // Malformed lines are skipped by the try/catch in parseStructuredJsonl.
    fs.writeFileSync(tmpFile, '{"id":"good","content":"Good entry"}\nnot-json\n{"id":"also-good","content":"Also good"}\n', "utf8");
    const result = parseStructuredJsonl(tmpFile);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "good");
    assert.equal(result[1].id, "also-good");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("parseStructuredJsonl: applies defaults to each record", () => {
  const tmpFile = path.join(os.tmpdir(), `parse-jsonl-defaults-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ id: "r1", content: "C" }) + "\n", "utf8");
    const result = parseStructuredJsonl(tmpFile, { scope: "feedback", tool: "openclaw" });
    assert.equal(result[0].scope, "feedback");
    assert.equal(result[0].tool, "openclaw");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ---------------------------------------------------------------------------
// repairStructuredRecord
// ---------------------------------------------------------------------------

test("repairStructuredRecord: normalizes record and adds content_hash", () => {
  const payload = { id: "repair-1", title: "Title", content: "Content here" };
  const result = repairStructuredRecord(payload);
  assert.ok(result !== null);
  assert.equal(result.id, "repair-1");
  assert.ok(typeof result.content_hash === "string");
  assert.ok(result.content_hash.length > 0);
});

test("repairStructuredRecord: null payload returns null", () => {
  assert.equal(repairStructuredRecord(null), null);
});

// ---------------------------------------------------------------------------
// preserveDreamRecords
// ---------------------------------------------------------------------------

test("preserveDreamRecords: keeps writeback records", () => {
  const records = [
    { id: "normal-1", source_kind: "normal" },
    { id: "dream-1", source_kind: "writeback" },
    { id: "dream-2", id: "dream-2" },
  ];
  const result = preserveDreamRecords(records);
  assert.equal(result.length, 2);
  assert.ok(result.some((r) => r.id === "dream-1"));
});

test("preserveDreamRecords: keeps dream-prefixed id records", () => {
  const records = [
    { id: "dream-abc123", content: "dream content" },
    { id: "normal-xyz", content: "normal" },
  ];
  const result = preserveDreamRecords(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "dream-abc123");
});

test("preserveDreamRecords: empty input returns empty array", () => {
  assert.deepEqual(preserveDreamRecords([]), []);
  assert.deepEqual(preserveDreamRecords([null, undefined]), []);
});

// ---------------------------------------------------------------------------
// shouldSkipAsRecentDuplicate
// ---------------------------------------------------------------------------

test("shouldSkipAsRecentDuplicate: exact hash within 30s returns true", () => {
  const nowMs = Date.now();
  const existing = new Map([["hash1", { id: "e1", t: new Date(nowMs - 10_000).toISOString(), content: "C", content_hash: "hash1" }]]);
  assert.equal(shouldSkipAsRecentDuplicate({ id: "n1", content: "C", content_hash: "hash1" }, existing, nowMs), true);
});

test("shouldSkipAsRecentDuplicate: no matching hash returns false", () => {
  const nowMs = Date.now();
  const existing = new Map();
  assert.equal(shouldSkipAsRecentDuplicate({ id: "n1", content: "C", content_hash: "unique" }, existing, nowMs), false);
});

test("shouldSkipAsRecentDuplicate: older than 30s returns false", () => {
  const nowMs = Date.now();
  const existing = new Map([["oldhash", { id: "e1", t: new Date(nowMs - 60_000).toISOString(), content: "C", content_hash: "oldhash" }]]);
  assert.equal(shouldSkipAsRecentDuplicate({ id: "n1", content: "C", content_hash: "oldhash" }, existing, nowMs), false);
});

// ---------------------------------------------------------------------------
// readJsonl / readText / writeText / ensureDirectory
// ---------------------------------------------------------------------------

test("readJsonl: non-existent file returns empty array", () => {
  assert.deepEqual(readJsonl("/non/existent.jsonl"), []);
});

test("readJsonl: parses valid JSONL", () => {
  const tmpFile = path.join(os.tmpdir(), `readjsonl-test-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, '{"id":"a"}\n{"id":"b"}\n', "utf8");
    const result = readJsonl(tmpFile);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "a");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("readText: non-existent file returns empty string", () => {
  assert.equal(readText("/non/existent.txt"), "");
});

test("readText: returns file content", () => {
  const tmpFile = path.join(os.tmpdir(), `readtext-test-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpFile, "hello world", "utf8");
    assert.equal(readText(tmpFile), "hello world");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("writeText: creates file with content", () => {
  const tmpDir = path.join(os.tmpdir(), `writetext-test-${Date.now()}`);
  const tmpFile = path.join(tmpDir, "subdir", "file.txt");
  ensureDirectory(tmpDir);
  writeText(tmpFile, "content here");
  assert.equal(readText(tmpFile), "content here");
  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

test("ensureDirectory: creates nested directories", () => {
  const tmpDir = path.join(os.tmpdir(), `ensure-dir-test-${Date.now()}`, "a", "b", "c");
  ensureDirectory(tmpDir);
  assert.ok(fs.existsSync(tmpDir));
  // cleanup
  try { fs.rmSync(path.join(os.tmpdir(), `ensure-dir-test-${Date.now()}`), { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// withFileLock
// ---------------------------------------------------------------------------

test("withFileLock: creates file and executes fn when file does not exist", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-parse-test-${Date.now()}.jsonl`);
  try {
    let executed = false;
    withFileLock(tmpFile, (fd) => { executed = true; });
    assert.equal(executed, true);
    assert.ok(fs.existsSync(tmpFile));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("withFileLock: writes to existing file", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-parse-test2-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, '{"id":"x"}\n', "utf8");
    let content = null;
    withFileLock(tmpFile, (fd) => { content = fs.readFileSync(tmpFile, "utf8"); });
    assert.equal(content, '{"id":"x"}\n');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("withFileLock: idempotent sequential calls", () => {
  const tmpFile = path.join(os.tmpdir(), `withfilelock-parse-test3-${Date.now()}.jsonl`);
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
// loadEntityExtractor / loadKnowledgeGraph
// ---------------------------------------------------------------------------

test("loadEntityExtractor: returns object with extractFromRecord", () => {
  const extractor = loadEntityExtractor();
  assert.equal(typeof extractor.extractFromRecord, "function");
  const result = extractor.extractFromRecord({ id: "test", content: "test" });
  assert.ok(result !== null && typeof result === "object");
});

test("loadKnowledgeGraph: returns object with ingestRecord and close", () => {
  const kg = loadKnowledgeGraph();
  assert.equal(typeof kg.ingestRecord, "function");
  assert.equal(typeof kg.close, "function");
});
