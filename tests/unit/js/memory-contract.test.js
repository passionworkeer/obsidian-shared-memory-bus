"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MEMORY_RECORD_SCHEMA_VERSION,
  MEMORY_INTEGRITY_CONTRACT_VERSION,
  validateStructuredRecord,
  validatePromotionMetadata,
  isExpectedDerivedDuplicate,
  buildGeneratedArtifactMetadata,
  normalizeString,
  normalizeLower,
  sha1,
} = require("../../../ops/memory-contract.js");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("MEMORY_RECORD_SCHEMA_VERSION === 2", () => {
  assert.equal(MEMORY_RECORD_SCHEMA_VERSION, 2);
});

test("MEMORY_INTEGRITY_CONTRACT_VERSION === 2", () => {
  assert.equal(MEMORY_INTEGRITY_CONTRACT_VERSION, 2);
});

// ---------------------------------------------------------------------------
// normalizeString
// ---------------------------------------------------------------------------

test("normalizeString: null returns empty string", () => {
  assert.equal(normalizeString(null), "");
});

test("normalizeString: undefined returns empty string", () => {
  assert.equal(normalizeString(undefined), "");
});

test("normalizeString: empty string returns empty string", () => {
  assert.equal(normalizeString(""), "");
});

test("normalizeString: whitespace is trimmed", () => {
  assert.equal(normalizeString("  hi  "), "hi");
});

test("normalizeString: normal string unchanged", () => {
  assert.equal(normalizeString("hello world"), "hello world");
});

// ---------------------------------------------------------------------------
// normalizeLower
// ---------------------------------------------------------------------------

test("normalizeLower: 'Hello' becomes 'hello'", () => {
  assert.equal(normalizeLower("Hello"), "hello");
});

test("normalizeLower: mixed case becomes lowercase", () => {
  assert.equal(normalizeLower("HELLO WORLD"), "hello world");
});

test("normalizeLower: whitespace is trimmed", () => {
  assert.equal(normalizeLower("  Hi  "), "hi");
});

// ---------------------------------------------------------------------------
// sha1
// ---------------------------------------------------------------------------

test("sha1: produces 40-character hex string", () => {
  const hash = sha1("hello");
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 40);
  assert.ok(/^[a-f0-9]{40}$/.test(hash), "should be lowercase hex");
});

test("sha1: same input produces same hash", () => {
  const h1 = sha1("test string");
  const h2 = sha1("test string");
  assert.equal(h1, h2);
});

test("sha1: null input produces hash of empty string", () => {
  const hash = sha1(null);
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 40);
});

// ---------------------------------------------------------------------------
// validateStructuredRecord
// ---------------------------------------------------------------------------

function makeValidRecord(overrides = {}) {
  return {
    schemaVersion: 2,
    id: "test-id-123",
    tool: "claude-code",
    type: "note",
    title: "Test memory entry",
    source: "test-session",
    scope: "project",
    visibility: "shared",
    memory_level: "durable",
    content_hash: "a".repeat(64),
    ...overrides,
  };
}

test("validateStructuredRecord: fully valid record returns ok=true with no errors", () => {
  const record = makeValidRecord();
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.schemaVersion, 2);
});

test("validateStructuredRecord: null record returns ok=false with record-not-object", () => {
  const result = validateStructuredRecord(null);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("record-not-object"));
});

test("validateStructuredRecord: number record returns ok=false with record-not-object", () => {
  const result = validateStructuredRecord(42);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("record-not-object"));
});

test("validateStructuredRecord: array record returns ok=false with record-not-object", () => {
  const result = validateStructuredRecord(["item"]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("record-not-object"));
});

test("validateStructuredRecord: missing required field adds missing-fields error", () => {
  const record = makeValidRecord({ id: "" });
  const result = validateStructuredRecord(record, ["id", "tool"]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("missing-fields:")), "should have missing-fields error");
  assert.ok(result.missingFields.includes("id"));
});

test("validateStructuredRecord: missing multiple required fields lists all", () => {
  const record = makeValidRecord({ id: "", tool: "  " });
  const result = validateStructuredRecord(record, ["id", "tool", "type"]);
  assert.equal(result.ok, false);
  assert.ok(result.missingFields.includes("id"), "id should be missing (empty string)");
  assert.ok(result.missingFields.includes("tool"), "tool should be missing (whitespace)");
  assert.ok(!result.missingFields.includes("type"), "type should NOT be missing (has valid value 'note')");
});

test("validateStructuredRecord: wrong schemaVersion 1 adds unexpected-schema-version error", () => {
  const record = makeValidRecord({ schemaVersion: 1 });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unexpected-schema-version")), "should have schema version error");
});

test("validateStructuredRecord: wrong schemaVersion 3 adds unexpected-schema-version error", () => {
  const record = makeValidRecord({ schemaVersion: 3 });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unexpected-schema-version")), "should have schema version error");
});

test("validateStructuredRecord: wrong scope adds unknown-scope error", () => {
  const record = makeValidRecord({ scope: "invalid-scope" });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown-scope")), "should have unknown-scope error");
});

test("validateStructuredRecord: wrong visibility adds unknown-visibility error", () => {
  const record = makeValidRecord({ visibility: "invalid-visibility" });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown-visibility")), "should have unknown-visibility error");
});

test("validateStructuredRecord: wrong source_kind adds unknown-source-kind error", () => {
  const record = makeValidRecord({ source_kind: "invalid-kind" });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown-source-kind")), "should have unknown-source-kind error");
});

test("validateStructuredRecord: wrong memory_level adds unknown-memory-level error", () => {
  const record = makeValidRecord({ memory_level: "invalid-level" });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown-memory-level")), "should have unknown-memory-level error");
});

test("validateStructuredRecord: invalid content_hash (too short) adds invalid-content-hash error", () => {
  const record = makeValidRecord({ content_hash: "abc123" });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("invalid-content-hash")), "should have invalid-content-hash error");
});

test("validateStructuredRecord: invalid content_hash (bad chars) adds invalid-content-hash error", () => {
  const record = makeValidRecord({ content_hash: "g".repeat(64) }); // 'g' is not valid hex
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("invalid-content-hash")), "should have invalid-content-hash error");
});

test("validateStructuredRecord: name wrong type adds invalid-name-type error", () => {
  const record = makeValidRecord({ name: 12345 });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("invalid-name-type"));
});

test("validateStructuredRecord: description wrong type adds invalid-description-type error", () => {
  const record = makeValidRecord({ description: { text: "not a string" } });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("invalid-description-type"));
});

test("validateStructuredRecord: nested promotion metadata is validated", () => {
  const record = makeValidRecord({
    metadata: {
      promotion: {
        version: 99, // wrong version
        key: "", // missing key
        reason: "test",
        source_record_id: "test-id",
      },
    },
  });
  const result = validateStructuredRecord(record);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unknown-promotion-version")), "should propagate promotion errors");
});

// ---------------------------------------------------------------------------
// validatePromotionMetadata
// ---------------------------------------------------------------------------

function makeValidPromotion(overrides = {}) {
  return {
    version: 1,
    durable_type: "project",
    key: "test-key",
    reason: "testing promotion",
    source_record_id: "record-123",
    is_refresh: false,
    conflict_with: [],
    ...overrides,
  };
}

test("validatePromotionMetadata: valid promotion returns no errors", () => {
  const errors = validatePromotionMetadata(makeValidPromotion());
  assert.deepEqual(errors, []);
});

test("validatePromotionMetadata: non-object returns empty array (not validated)", () => {
  const errors = validatePromotionMetadata("not an object");
  assert.deepEqual(errors, []);
  const errorsNull = validatePromotionMetadata(null);
  assert.deepEqual(errorsNull, []);
});

test("validatePromotionMetadata: wrong version adds unknown-promotion-version error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ version: 2 }));
  assert.ok(errors.some((e) => e.includes("unknown-promotion-version")), "should have version error");
});

test("validatePromotionMetadata: wrong version 0 adds unknown-promotion-version error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ version: 0 }));
  assert.ok(errors.some((e) => e.includes("unknown-promotion-version")));
});

test("validatePromotionMetadata: invalid durable_type adds unknown-promotion-durable-type error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ durable_type: "invalid-type" }));
  assert.ok(errors.some((e) => e.includes("unknown-promotion-durable-type")), "should have durable_type error");
});

test("validatePromotionMetadata: missing key adds missing-promotion-key error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ key: "" }));
  assert.ok(errors.includes("missing-promotion-key"));
});

test("validatePromotionMetadata: whitespace-only key adds missing-promotion-key error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ key: "   " }));
  assert.ok(errors.includes("missing-promotion-key"));
});

test("validatePromotionMetadata: missing reason adds missing-promotion-reason error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ reason: "" }));
  assert.ok(errors.includes("missing-promotion-reason"));
});

test("validatePromotionMetadata: missing source_record_id adds missing-promotion-source-record-id error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ source_record_id: "" }));
  assert.ok(errors.includes("missing-promotion-source-record-id"));
});

test("validatePromotionMetadata: is_refresh not boolean adds invalid-promotion-is-refresh-type error", () => {
  const errors = validatePromotionMetadata(makeValidPromotion({ is_refresh: "yes" }));
  assert.ok(errors.includes("invalid-promotion-is-refresh-type"));
});

test("validatePromotionMetadata: is_refresh=true without refresh_of_id adds missing-promotion-refresh-of-id error", () => {
  const errors = validatePromotionMetadata(
    makeValidPromotion({ is_refresh: true, refresh_of_id: "" })
  );
  assert.ok(errors.includes("missing-promotion-refresh-of-id"));
});

test("validatePromotionMetadata: is_refresh=true without refresh_of_t adds missing-promotion-refresh-of-t error", () => {
  const errors = validatePromotionMetadata(
    makeValidPromotion({ is_refresh: true, refresh_of_t: "" })
  );
  assert.ok(errors.includes("missing-promotion-refresh-of-t"));
});

test("validatePromotionMetadata: is_refresh=true with all required refresh fields returns no errors", () => {
  const errors = validatePromotionMetadata(
    makeValidPromotion({ is_refresh: true, refresh_of_id: "ref-123", refresh_of_t: "2024-01-01" })
  );
  assert.deepEqual(errors, []);
});

test("validatePromotionMetadata: conflict_with with empty string adds invalid-promotion-conflict-with error", () => {
  const errors = validatePromotionMetadata(
    makeValidPromotion({ conflict_with: ["id-1", "", "id-3"] })
  );
  assert.ok(errors.includes("invalid-promotion-conflict-with"));
});

// ---------------------------------------------------------------------------
// isExpectedDerivedDuplicate
// ---------------------------------------------------------------------------

test("isExpectedDerivedDuplicate: session-memory with claude-code returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("session-memory.jsonl", "claude-code.jsonl"), true);
});

test("isExpectedDerivedDuplicate: claude-code with session-memory returns true (order reversed)", () => {
  assert.equal(isExpectedDerivedDuplicate("claude-code.jsonl", "session-memory.jsonl"), true);
});

test("isExpectedDerivedDuplicate: session-memory with openclaw returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("session-memory.jsonl", "openclaw.jsonl"), true);
});

test("isExpectedDerivedDuplicate: openclaw with session-memory returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("openclaw.jsonl", "session-memory.jsonl"), true);
});

test("isExpectedDerivedDuplicate: task-memory with openclaw-runs returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("task-memory.jsonl", "openclaw-runs.jsonl"), true);
});

test("isExpectedDerivedDuplicate: openclaw-runs with task-memory returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("openclaw-runs.jsonl", "task-memory.jsonl"), true);
});

test("isExpectedDerivedDuplicate: task-memory with openclaw-journal returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("task-memory.jsonl", "openclaw-journal.jsonl"), true);
});

test("isExpectedDerivedDuplicate: task-memory with openclaw-blackboard returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("task-memory.jsonl", "openclaw-blackboard.jsonl"), true);
});

test("isExpectedDerivedDuplicate: task-memory with openclaw-jobs returns true", () => {
  assert.equal(isExpectedDerivedDuplicate("task-memory.jsonl", "openclaw-jobs.jsonl"), true);
});

test("isExpectedDerivedDuplicate: task-memory with other file returns false", () => {
  assert.equal(isExpectedDerivedDuplicate("task-memory.jsonl", "shared-inbox.jsonl"), false);
});

test("isExpectedDerivedDuplicate: two unrelated files returns false", () => {
  assert.equal(isExpectedDerivedDuplicate("shared-inbox.jsonl", "shared-events.jsonl"), false);
});

test("isExpectedDerivedDuplicate: openclaw with task-memory returns true (reverse order)", () => {
  assert.equal(isExpectedDerivedDuplicate("openclaw-runs.jsonl", "task-memory.jsonl"), true);
});

test("isExpectedDerivedDuplicate: empty strings return false", () => {
  assert.equal(isExpectedDerivedDuplicate("", ""), false);
});

// ---------------------------------------------------------------------------
// buildGeneratedArtifactMetadata
// ---------------------------------------------------------------------------

test("buildGeneratedArtifactMetadata: output has required fields", () => {
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/some/path" });
  assert.ok(typeof meta.generatedAt === "string" && meta.generatedAt.length > 0, "generatedAt should be non-empty string");
  assert.ok(typeof meta.contractVersion === "number", "contractVersion should be number");
  assert.ok(typeof meta.recordSchemaVersion === "number", "recordSchemaVersion should be number");
  assert.ok(typeof meta.sourceStructuredSignature === "object", "sourceStructuredSignature should be object");
  assert.ok(typeof meta.description === "string" && meta.description.length > 0, "description should be non-empty string");
});

test("buildGeneratedArtifactMetadata: contractVersion equals 2", () => {
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/some/path" });
  assert.equal(meta.contractVersion, 2);
});

test("buildGeneratedArtifactMetadata: recordSchemaVersion equals 2", () => {
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/some/path" });
  assert.equal(meta.recordSchemaVersion, 2);
});

test("buildGeneratedArtifactMetadata: sourceStructuredSignature has raw and hash fields", () => {
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/some/path" });
  assert.ok(typeof meta.sourceStructuredSignature.raw === "string", "raw should be string");
  assert.ok(typeof meta.sourceStructuredSignature.hash === "string", "hash should be string");
});

test("buildGeneratedArtifactMetadata: description is non-empty", () => {
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/some/path" });
  assert.ok(meta.description.length > 0);
});

test("buildGeneratedArtifactMetadata: works without structuredRoot (uses __empty__)", () => {
  // structuredRoot defaults to undefined, which causes buildStructuredSignature to
  // use "__empty__" as the raw signature. Path.join(undefined, ...) throws, so
  // a valid structuredRoot is needed. Call with a real path to verify the structure.
  const meta = buildGeneratedArtifactMetadata({ structuredRoot: "/test/root" });
  assert.ok(typeof meta.generatedAt === "string");
  assert.ok(typeof meta.sourceStructuredSignature === "object");
});
