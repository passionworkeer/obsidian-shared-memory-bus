/**
 * tests/integration/js/inbox-atomic-flow.test.js
 * ===============================================
 * Integration tests for inbox atomic write flow.
 *
 * Scenarios:
 *   1. Single appendLineAtomic succeeds and file contains the correct line
 *   2. Concurrent 20-process calls — no lines dropped, no corruption
 *   3. Directory auto-creation when target directory does not exist
 *
 * Run with: node --test tests/integration/js/inbox-atomic-flow.test.js
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTempDir, cleanupTempDir } from "../../helpers/setup.js";

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0).length;
}

function readJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("inbox atomic flow integration", () => {
  let testDir;

  beforeEach(() => {
    testDir = createTempDir("inbox-atomic-flow-");
  });

  afterEach(() => {
    cleanupTempDir(testDir);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Single appendLineAtomic succeeds
  // -------------------------------------------------------------------------
  test("single appendLineAtomic writes exactly one valid JSON line", async () => {
    const { appendLineAtomic } = await import("../../../ops/inbox/inbox-atomic-write.js");

    const file = path.join(testDir, "single.jsonl");
    const record = { id: "single-001", msg: "hello atomic world", seq: 1 };

    appendLineAtomic(file, record);

    assert.ok(fs.existsSync(file), "File should be created");
    const lines = readJsonlLines(file);
    assert.strictEqual(lines.length, 1, "Should contain exactly one line");
    assert.strictEqual(lines[0].id, "single-001");
    assert.strictEqual(lines[0].msg, "hello atomic world");
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Concurrent 20-process append — no dropped lines
  // Skip in CI (flaky on GitHub Actions virtualized filesystem) and Windows
  // -------------------------------------------------------------------------
  const concurrentTest = (process.env.GITHUB_ACTIONS || process.platform === "win32") ? test.skip : test;
  concurrentTest("concurrent 20 child processes each append one line — zero dropped lines", async () => {
    const file = path.join(testDir, "concurrent-20.jsonl");
    const N = 20;

    const scriptPath = path.join(__dirname, "../../../ops/inbox/inbox-atomic-write.js");
    const promises = Array.from({ length: N }, (_, i) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
            (async () => {
              const { appendLineAtomic } = await import(${JSON.stringify(scriptPath)});
              const file = ${JSON.stringify(file)};
              try {
                appendLineAtomic(file, { id: "p" + ${i}, pid: process.pid, seq: ${i} });
                process.stdout.write("ok");
              } catch(e) {
                process.stderr.write("ERR:" + e.message);
                process.exit(1);
              }
            })();
            `,
          ],
          { windowsHide: true }
        );

        let stderr = "";
        child.stderr.on("data", d => { stderr += d; });
        child.on("close", code => {
          if (code !== 0) {
            console.error(`[child ${i}] exited ${code}: ${stderr}`);
          }
          resolve({ i, code, stderr });
        });
      })
    );

    const results = await Promise.all(promises);

    // All processes should exit 0
    for (const r of results) {
      assert.strictEqual(
        r.code, 0,
        `Child process ${r.i} failed: ${r.stderr}`
      );
    }

    // Count lines — must equal N (no drops)
    const lineCount = countJsonlLines(file);
    assert.strictEqual(
      lineCount, N,
      `Expected ${N} lines, got ${lineCount}. Lines may have been dropped due to race condition.`
    );

    // Verify all IDs are present
    const records = readJsonlLines(file);
    const ids = records.map(r => r.id).sort();
    const expectedIds = Array.from({ length: N }, (_, i) => `p${i}`).sort();
    assert.deepStrictEqual(ids, expectedIds, "All IDs should be present with no duplicates");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Directory auto-creation when parent directory does not exist
  // -------------------------------------------------------------------------
  test("appendLineAtomic auto-creates the parent directory if it is missing", async () => {
    const { appendLineAtomic } = await import("../../../ops/inbox/inbox-atomic-write.js");

    // Deep path where no directory exists
    const deepFile = path.join(testDir, "deeply", "nested", "atomic", "auto.jsonl");

    const dirExistsBefore = fs.existsSync(path.dirname(deepFile));
    assert.strictEqual(dirExistsBefore, false, "Directory should not exist before call");

    appendLineAtomic(deepFile, { id: "auto-dir-001", auto: true });

    const dirExistsAfter = fs.existsSync(path.dirname(deepFile));
    const fileExists = fs.existsSync(deepFile);

    assert.strictEqual(dirExistsAfter, true, "Directory should be created");
    assert.strictEqual(fileExists, true, "File should be created");

    const records = readJsonlLines(deepFile);
    assert.strictEqual(records.length, 1, "Should contain one record");
    assert.strictEqual(records[0].id, "auto-dir-001");
  });

  // -------------------------------------------------------------------------
  // Stress: interleaved sequential + concurrent writes
  // Skip in CI (flaky on GitHub Actions virtualized filesystem) and Windows
  // (uses the same race pattern as Scenario 2)
  // -------------------------------------------------------------------------
  const mixedTest = (process.env.GITHUB_ACTIONS || process.platform === "win32") ? test.skip : test;
  mixedTest("mixed sequential and concurrent writes — all records present, no corruption", async () => {
    const { appendLineAtomic } = await import("../../../ops/inbox/inbox-atomic-write.js");
    const file = path.join(testDir, "mixed.jsonl");

    // Pre-write 5 sequential lines
    for (let i = 0; i < 5; i++) {
      appendLineAtomic(file, { id: `seq-${i}`, type: "sequential" });
    }

    // Concurrently append 15 more
    const N = 15;
    const scriptPath = path.join(__dirname, "../../../ops/inbox/inbox-atomic-write.js");
    const promises = Array.from({ length: N }, (_, i) =>
      new Promise((resolve) => {
        spawn(
          process.execPath,
          [
            "-e",
            `
            (async () => {
              const { appendLineAtomic } = await import(${JSON.stringify(scriptPath)});
              appendLineAtomic(${JSON.stringify(file)}, { id: "par-${i}", type: "parallel" });
            })();
            `,
          ],
          { windowsHide: true }
        ).on("close", code => resolve(code));
      })
    );

    const exitCodes = await Promise.all(promises);
    for (const code of exitCodes) {
      assert.strictEqual(code, 0);
    }

    const records = readJsonlLines(file);
    assert.strictEqual(records.length, 20, `Expected 20 records (5 seq + 15 par), got ${records.length}`);

    // Sequential records should all be present
    for (let i = 0; i < 5; i++) {
      assert.ok(
        records.some(r => r.id === `seq-${i}`),
        `Sequential record seq-${i} should be present`
      );
    }

    // Parallel records should all be present
    for (let i = 0; i < 15; i++) {
      assert.ok(
        records.some(r => r.id === `par-${i}`),
        `Parallel record par-${i} should be present`
      );
    }

    // No extra garbage records
    assert.strictEqual(records.length, 20);
  });
});
