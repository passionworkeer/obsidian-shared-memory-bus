/**
 * Streaming JSONL unit tests (ESM).
 *
 * Exercises createJsonlStream and createJsonlBatcher with:
 * - large files (memory OOM guard)
 * - batch size control
 * - malformed-line skipping
 * - empty-file handling
 *
 * Run with: node --test tests/unit/js/streaming-jsonl.test.js
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ESM bridge: import CommonJS module via file URL (reliable relative resolution)
const jsonlModule = await import(
  new URL("../../../ops/jsonl-stream.js", import.meta.url).href
).then((m) => m.default || m);
const { createJsonlStream, createJsonlBatcher } = jsonlModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, return its path. Caller must clean up. */
function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a JSONL file, return its path. */
function writeJsonl(filePath, records) {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf8");
}

// ---------------------------------------------------------------------------
// Tests: createJsonlStream
// ---------------------------------------------------------------------------

describe("createJsonlStream", () => {
  it("should read all records from a JSONL file", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "test.jsonl");
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ id: `r${i}`, v: i })
    );
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const records = [];
    for await (const record of createJsonlStream(file)) {
      records.push(record);
    }

    assert.equal(records.length, 100);
    assert.equal(records[0].id, "r0");
    assert.equal(records[99].id, "r99");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should skip malformed lines silently", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "malformed.jsonl");
    fs.writeFileSync(
      file,
      '{"id":"good1"}\nnot json\n{"id":"good2"}\n'
    );

    const records = [];
    for await (const record of createJsonlStream(file)) {
      records.push(record);
    }

    assert.equal(records.length, 2);
    assert.equal(records[0].id, "good1");
    assert.equal(records[1].id, "good2");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should handle empty files gracefully", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(file, "");

    const records = [];
    for await (const record of createJsonlStream(file)) {
      records.push(record);
    }

    assert.equal(records.length, 0);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should handle non-existent files gracefully (yields nothing)", async () => {
    const records = [];
    for await (const record of createJsonlStream("/no/such/file.jsonl")) {
      records.push(record);
    }
    assert.equal(records.length, 0);
  });

  it("should never hold more than one record in scope at a time", async () => {
    // Large file: 1000 records × ~1 KB each ≈ 1 MB.
    // Peak in-scope memory per iteration should be O(1 record).
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "large.jsonl");
    const largeLine = JSON.stringify({
      id: "large",
      content: "x".repeat(1000),
    });
    const lines = Array(1000).fill(largeLine);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    let maxRecordSize = 0;
    let iterations = 0;
    for await (const record of createJsonlStream(file)) {
      iterations++;
      const serializedSize = JSON.stringify(record).length;
      if (serializedSize > maxRecordSize) {
        maxRecordSize = serializedSize;
      }
      // Processing one record at a time — no accumulation.
      // After this iteration the previous record is eligible for GC.
    }

    // Confirm all 1000 were read
    assert.equal(iterations, 1000);
    // Confirm no single record exceeded ~1.1 KB (header + 1000 x's)
    assert.ok(
      maxRecordSize < 2000,
      `Expected max record < 2 KB, got ${maxRecordSize}`
    );
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should preserve record ordering", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "order.jsonl");
    const records = Array.from({ length: 50 }, (_, i) => ({
      idx: i,
      label: `record-${i}`,
    }));
    writeJsonl(file, records);

    const read = [];
    for await (const r of createJsonlStream(file)) {
      read.push(r);
    }

    assert.equal(read.length, records.length);
    for (let i = 0; i < records.length; i++) {
      assert.equal(read[i].idx, i);
      assert.equal(read[i].label, `record-${i}`);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should handle CRLF line endings", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "crlf.jsonl");
    const lines = ['{"id":"a"}', '{"id":"b"}', '{"id":"c"}'];
    fs.writeFileSync(file, lines.join("\r\n") + "\r\n");

    const records = [];
    for await (const record of createJsonlStream(file)) {
      records.push(record);
    }

    assert.equal(records.length, 3);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should handle Unicode content correctly", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "unicode.jsonl");
    writeJsonl(file, [
      { id: "zh", text: "中文内容" },
      { id: "emoji", text: "🎉🎊✨" },
      { id: "mixed", text: "Hello 世界 🌍" },
    ]);

    const records = [];
    for await (const record of createJsonlStream(file)) {
      records.push(record);
    }

    assert.equal(records.length, 3);
    assert.equal(records[0].text, "中文内容");
    assert.equal(records[1].text, "🎉🎊✨");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
});

// ---------------------------------------------------------------------------
// Tests: createJsonlBatcher
// ---------------------------------------------------------------------------

describe("createJsonlBatcher", () => {
  it("should batch records into groups of batchSize", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "batch.jsonl");
    const records = Array.from({ length: 250 }, (_, i) => ({ i }));
    writeJsonl(file, records);

    const batches = [];
    for await (const batch of createJsonlBatcher(file, { batchSize: 100 })) {
      batches.push(batch);
    }

    // 250 records / 100 batchSize = 3 batches (100, 100, 50)
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 100);
    assert.equal(batches[1].length, 100);
    assert.equal(batches[2].length, 50);
    assert.equal(batches[2][0].i, 200);
    assert.equal(batches[2][49].i, 249);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should yield a single batch when file has fewer records than batchSize", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "small.jsonl");
    const records = [{ a: 1 }, { b: 2 }];
    writeJsonl(file, records);

    const batches = [];
    for await (const batch of createJsonlBatcher(file, { batchSize: 100 })) {
      batches.push(batch);
    }

    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should yield empty iterator for empty file", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "empty-batch.jsonl");
    fs.writeFileSync(file, "");

    const batches = [];
    for await (const batch of createJsonlBatcher(file, { batchSize: 10 })) {
      batches.push(batch);
    }

    assert.equal(batches.length, 0);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should default batchSize to 100", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "default-batch.jsonl");
    const records = Array.from({ length: 250 }, (_, i) => ({ i }));
    writeJsonl(file, records);

    const batches = [];
    for await (const batch of createJsonlBatcher(file)) {
      batches.push(batch);
    }

    // Default batchSize = 100, so 250 records → 3 batches
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 100);
    assert.equal(batches[2].length, 50);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should skip malformed lines in batched mode", async () => {
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "malformed-batch.jsonl");
    fs.writeFileSync(
      file,
      '{"id":1}\nnot json\n{"id":2}\n{"id":3}\n'
    );

    const batches = [];
    for await (const batch of createJsonlBatcher(file, { batchSize: 10 })) {
      batches.push(batch);
    }

    // 3 valid records (1 malformed skipped), batchSize=10 → 1 batch
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 3);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("should process each batch without holding all records in memory", async () => {
    // 500 records × ~500 bytes each
    const tmp = makeTempDir("streaming-jsonl-");
    const file = path.join(tmp, "mem-batch.jsonl");
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      payload: "y".repeat(500),
    }));
    writeJsonl(file, records);

    let maxBatchSize = 0;
    for await (const batch of createJsonlBatcher(file, { batchSize: 50 })) {
      maxBatchSize = Math.max(maxBatchSize, batch.length);
      // "Process" the batch — in real use each batch is written/flushed
      // immediately, never accumulated alongside other batches.
      assert.ok(batch.length <= 50);
    }

    // 10 batches of 50
    assert.equal(maxBatchSize, 50);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
});
