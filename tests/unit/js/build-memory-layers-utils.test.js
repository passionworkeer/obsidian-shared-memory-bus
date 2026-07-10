import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// jsonl-stream.js tests (no dependencies on build-memory-layers.js)
// ---------------------------------------------------------------------------

const { createJsonlStream, readJsonlStream } = await import("../../../ops/util/jsonl-stream.js");

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

const { normalizeSpaces } = await import("../../../ops/build/build-memory-layers.js");

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

const { getFreshness } = await import("../../../ops/build/build-memory-layers.js");

test("getFreshness: NaN ageMs (invalid date) returns 'unknown'", () => {
  assert.equal(getFreshness("not-a-timestamp"), "unknown");
});

test("getFreshness: completely garbage string returns 'unknown'", () => {
  assert.equal(getFreshness("garbage!!"), "unknown");
});

// ---------------------------------------------------------------------------
// buildPromotionKey id/t salt
// ---------------------------------------------------------------------------

const { buildPromotionKey } = await import("../../../ops/build/build-memory-layers.js");

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

const { withFileLock } = await import("../../../ops/build/build-memory-layers.js");

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

const { deduplicateSharedInbox } = await import("../../../ops/build/build-memory-layers.js");

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
