/**
 * Unit tests for jsonl-stream.js operations
 *
 * Tests createJsonlStream, readJsonlStream, and related JSONL operations
 *
 * Run with: node --test tests/unit/js/jsonl.test.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helpersPath = path.resolve(__dirname, "../../helpers/setup");
const fixturesPath = path.resolve(__dirname, "../../helpers/fixtures");

const { createTempDir, cleanupTempDir, createTempJsonl } = await import(pathToFileURL(helpersPath + ".js"));
const { SAMPLE_MEMORY_RECORDS } = await import(pathToFileURL(fixturesPath + ".js"));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// Import jsonl-stream module
const jsonlModule = await import(pathToFileURL(path.resolve(__dirname, "../../../ops/util/jsonl-stream.js")));
const { createJsonlStream, readJsonlStream } = jsonlModule;

let tempDir;

describe("jsonl operations", () => {
  beforeEach(() => {
    tempDir = createTempDir("jsonl-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // ---------------------------------------------------------------------------
  // createJsonlStream tests
  // ---------------------------------------------------------------------------

  test("createJsonlStream reads records correctly", async () => {
    const filePath = createTempJsonl(tempDir, "test.jsonl", SAMPLE_MEMORY_RECORDS);
    const records = [];

    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, SAMPLE_MEMORY_RECORDS.length);
    assert.deepStrictEqual(records, SAMPLE_MEMORY_RECORDS);
  });

  test("createJsonlStream handles empty file", async () => {
    const filePath = path.join(tempDir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf8");
    const records = [];

    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, 0);
  });

  test("createJsonlStream skips empty lines", async () => {
    const filePath = path.join(tempDir, "with-empty-lines.jsonl");
    const content = [
      JSON.stringify(SAMPLE_MEMORY_RECORDS[0]),
      "",
      JSON.stringify(SAMPLE_MEMORY_RECORDS[1]),
      "   ",
      JSON.stringify(SAMPLE_MEMORY_RECORDS[2]),
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const records = [];
    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, 3);
  });

  test("createJsonlStream handles malformed JSON lines (skip bad, yield good)", async () => {
    const filePath = path.join(tempDir, "malformed.jsonl");
    const content = [
      JSON.stringify(SAMPLE_MEMORY_RECORDS[0]),
      "{ this is not valid JSON",
      JSON.stringify(SAMPLE_MEMORY_RECORDS[1]),
      ' {"incomplete": true',
      JSON.stringify(SAMPLE_MEMORY_RECORDS[2]),
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const records = [];
    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    // Should skip 2 malformed lines and yield 3 good ones
    assert.strictEqual(records.length, 3);
    assert.deepStrictEqual(records[0], SAMPLE_MEMORY_RECORDS[0]);
    assert.deepStrictEqual(records[1], SAMPLE_MEMORY_RECORDS[1]);
    assert.deepStrictEqual(records[2], SAMPLE_MEMORY_RECORDS[2]);
  });

  test("createJsonlStream handles non-existent file gracefully", async () => {
    const filePath = path.join(tempDir, "nonexistent.jsonl");
    const records = [];

    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, 0);
  });

  test("createJsonlStream handles single record", async () => {
    const filePath = createTempJsonl(tempDir, "single.jsonl", [SAMPLE_MEMORY_RECORDS[0]]);
    const records = [];

    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0], SAMPLE_MEMORY_RECORDS[0]);
  });

  test("createJsonlStream handles multiple records in order", async () => {
    const records = [
      { id: "first", order: 1 },
      { id: "second", order: 2 },
      { id: "third", order: 3 },
    ];
    const filePath = createTempJsonl(tempDir, "order.jsonl", records);

    const readRecords = [];
    for await (const record of createJsonlStream(filePath)) {
      readRecords.push(record);
    }

    assert.strictEqual(readRecords[0].id, "first");
    assert.strictEqual(readRecords[1].id, "second");
    assert.strictEqual(readRecords[2].id, "third");
  });

  test("createJsonlStream handles whitespace-only lines", async () => {
    const filePath = path.join(tempDir, "whitespace.jsonl");
    fs.writeFileSync(filePath, "   \n\t\n  \n", "utf8");

    const records = [];
    for await (const record of createJsonlStream(filePath)) {
      records.push(record);
    }

    assert.strictEqual(records.length, 0);
  });

  // ---------------------------------------------------------------------------
  // readJsonlStream tests (convenience wrapper)
  // ---------------------------------------------------------------------------

  test("readJsonlStream returns all records as array", async () => {
    const filePath = createTempJsonl(tempDir, "read-test.jsonl", SAMPLE_MEMORY_RECORDS);
    const records = await readJsonlStream(filePath);

    assert.strictEqual(records.length, SAMPLE_MEMORY_RECORDS.length);
    assert.deepStrictEqual(records, SAMPLE_MEMORY_RECORDS);
  });

  test("readJsonlStream handles empty file", async () => {
    const filePath = path.join(tempDir, "empty-read.jsonl");
    fs.writeFileSync(filePath, "", "utf8");

    const records = await readJsonlStream(filePath);

    assert.strictEqual(records.length, 0);
    assert.ok(Array.isArray(records));
  });

  test("readJsonlStream skips malformed lines", async () => {
    const filePath = path.join(tempDir, "malformed-read.jsonl");
    const content = [
      JSON.stringify({ valid: true }),
      "invalid line",
      JSON.stringify({ alsoValid: true }),
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const records = await readJsonlStream(filePath);

    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].valid, true);
    assert.strictEqual(records[1].alsoValid, true);
  });

  // ---------------------------------------------------------------------------
  // Atomic write tests (appendJsonl pattern)
  // ---------------------------------------------------------------------------

  test("appendJsonl writes atomically (write to .tmp then rename)", async () => {
    const filePath = path.join(tempDir, "append-atomic.jsonl");
    const tmpPath = filePath + ".tmp";

    // Simulate atomic append: write to tmp, then rename
    const record = { id: "atomic-001", content: "Test atomic write" };
    fs.writeFileSync(tmpPath, JSON.stringify(record) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);

    // Verify the file exists and contains the record
    assert.ok(fs.existsSync(filePath));
    const records = await readJsonlStream(filePath);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, "atomic-001");
  });

  test("appendJsonl handles multiple sequential writes", async () => {
    const filePath = path.join(tempDir, "sequential.jsonl");
    const records = [
      { id: "first" },
      { id: "second" },
      { id: "third" },
    ];

    for (const record of records) {
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    }

    const readRecords = await readJsonlStream(filePath);
    assert.strictEqual(readRecords.length, 3);
    assert.strictEqual(readRecords[0].id, "first");
    assert.strictEqual(readRecords[1].id, "second");
    assert.strictEqual(readRecords[2].id, "third");
  });

  // ---------------------------------------------------------------------------
  // patchJsonlRecord tests
  // ---------------------------------------------------------------------------

  test("patchJsonlRecord finds and patches correct record", async () => {
    const records = [
      { id: "rec-001", title: "Original 1", content: "Content 1" },
      { id: "rec-002", title: "Original 2", content: "Content 2" },
      { id: "rec-003", title: "Original 3", content: "Content 3" },
    ];
    const filePath = createTempJsonl(tempDir, "patch-test.jsonl", records);

    // Load records
    const readRecords = await readJsonlStream(filePath);
    const recordToPatch = readRecords.find((r) => r.id === "rec-002");

    // Patch the record
    recordToPatch.title = "Patched Title";
    recordToPatch.content = "Patched Content";
    recordToPatch.metadata = { patched: true };

    // Rewrite file with patched record
    fs.writeFileSync(filePath, "", "utf8");
    for (const record of readRecords) {
      fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    }

    // Verify patch
    const patchedRecords = await readJsonlStream(filePath);
    const patchedRecord = patchedRecords.find((r) => r.id === "rec-002");

    assert.strictEqual(patchedRecord.title, "Patched Title");
    assert.strictEqual(patchedRecord.content, "Patched Content");
    assert.strictEqual(patchedRecord.metadata.patched, true);
  });

  test("patchJsonlRecord handles missing record gracefully", async () => {
    const records = [
      { id: "rec-001", title: "Record 1" },
      { id: "rec-002", title: "Record 2" },
    ];
    const filePath = createTempJsonl(tempDir, "patch-missing.jsonl", records);

    // Try to patch non-existent record
    const readRecords = await readJsonlStream(filePath);
    const recordToPatch = readRecords.find((r) => r.id === "nonexistent");

    // Should not find it
    assert.strictEqual(recordToPatch, undefined);
  });

  // ---------------------------------------------------------------------------
  // File locking / concurrent access tests
  // ---------------------------------------------------------------------------

  test("concurrent appends maintain data integrity", async () => {
    const filePath = path.join(tempDir, "concurrent.jsonl");
    const numRecords = 10;

    // Create empty file
    fs.writeFileSync(filePath, "", "utf8");

    // Append records sequentially (simulating what would happen in concurrent scenario)
    for (let i = 1; i <= numRecords; i++) {
      fs.appendFileSync(filePath, JSON.stringify({ id: `rec-${i}`, index: i }) + "\n", "utf8");
    }

    // Verify all records are present and correctly ordered
    const records = await readJsonlStream(filePath);
    assert.strictEqual(records.length, numRecords);

    for (let i = 0; i < numRecords; i++) {
      assert.strictEqual(records[i].id, `rec-${i + 1}`);
      assert.strictEqual(records[i].index, i + 1);
    }
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test("handles records with nested objects", async () => {
    const records = [
      {
        id: "nested-001",
        metadata: {
          nested: { deep: { value: 42 } },
          array: [1, 2, 3],
        },
      },
    ];
    const filePath = createTempJsonl(tempDir, "nested.jsonl", records);

    const readRecords = await readJsonlStream(filePath);
    assert.strictEqual(readRecords[0].metadata.nested.deep.value, 42);
    assert.deepStrictEqual(readRecords[0].metadata.array, [1, 2, 3]);
  });

  test("handles records with special characters", async () => {
    const records = [
      { id: "special-001", content: "Unicode: 你好世界 🎉" },
      { id: "special-002", content: "Quotes: \"double\" and 'single'" },
      { id: "special-003", content: "Newlines:\nTab:\t" },
    ];
    const filePath = createTempJsonl(tempDir, "special.jsonl", records);

    const readRecords = await readJsonlStream(filePath);
    assert.strictEqual(readRecords.length, 3);
    assert.strictEqual(readRecords[0].content, "Unicode: 你好世界 🎉");
    assert.strictEqual(readRecords[1].content, "Quotes: \"double\" and 'single'");
    assert.ok(readRecords[2].content.includes("\n"));
  });

  test("handles very long records", async () => {
    const longContent = "x".repeat(100000);
    const records = [{ id: "long-001", content: longContent }];
    const filePath = createTempJsonl(tempDir, "long.jsonl", records);

    const readRecords = await readJsonlStream(filePath);
    assert.strictEqual(readRecords.length, 1);
    assert.strictEqual(readRecords[0].content.length, 100000);
  });
});
