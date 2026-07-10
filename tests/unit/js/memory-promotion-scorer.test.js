/**
 * Unit tests for ops/memory/memory-promotion-scorer.js
 *
 * The module is a CLI script (top-level main() invocation), so we
 * exercise it by:
 *   1. Spawning it with structured/*.jsonl input and verifying the
 *      promotion-queue.jsonl output.
 *   2. Inspecting the JSONL records it produced to confirm scoring
 *      math is correct (round-trip behaviour).
 *
 * Run with: node --test tests/unit/js/memory-promotion-scorer.test.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../ops/memory/memory-promotion-scorer.js");

let tempStoreRoot;
let structDir;
let queueDir;
let queueFile;

function runScorer(args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, AI_MEMORY_STORE: tempStoreRoot },
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function writeJsonl(filePath, records) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

/** Build a structured/*.jsonl with the given records (default tier-2) */
function seedStructured(records) {
  const fpath = path.join(structDir, "session-memory.jsonl");
  writeJsonl(fpath, records);
  return fpath;
}

beforeEach(() => {
  tempStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scorer-test-"));
  structDir = path.join(tempStoreRoot, "structured");
  queueDir = path.join(tempStoreRoot, ".ai-memory", "queue");
  queueFile = path.join(queueDir, "promotion-queue.jsonl");
  fs.mkdirSync(structDir, { recursive: true });
});

afterEach(() => {
  if (tempStoreRoot && fs.existsSync(tempStoreRoot)) {
    fs.rmSync(tempStoreRoot, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("memory-promotion-scorer — smoke", () => {
  test("exits non-zero when no store-root is provided", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, AI_MEMORY_STORE: "" },
      encoding: "utf8",
    });
    assert.notStrictEqual(r.status, 0);
  });

  test("handles empty structured dir gracefully (no crash, no output)", () => {
    const r = runScorer();
    assert.strictEqual(r.status, 0, "should exit 0; stderr: " + r.stderr);
    assert.strictEqual(fs.existsSync(queueFile), false, "no queue should be written for empty input");
  });
});

describe("memory-promotion-scorer — round-trip", () => {
  test("writes a promotion-queue.jsonl with one entry per scored record", () => {
    // Seed 3 Tier-2 records
    seedStructured([
      {
        id: "rec-A",
        t: new Date().toISOString(),
        lifecycle: { tier: 2, last_access_at: new Date().toISOString() },
        content: "alpha bravo charlie delta echo",
        title: "Memory A",
        scope: "user",
        type: "fact",
        source: "session",
        confidence: 0.8,
        metadata: {
          promotion: {
            source_confidence: 0.9,
            cross_session_refs: ["s1", "s2", "s3"],
          },
        },
      },
      {
        id: "rec-B",
        t: new Date(Date.now() - 1000).toISOString(),
        lifecycle: { tier: 2, last_access_at: new Date(Date.now() - 1000).toISOString() },
        content: "echo foxtrot golf hotel india",
        title: "Memory B",
        scope: "user",
        type: "fact",
        source: "session",
        confidence: 0.6,
        metadata: { promotion: { source_confidence: 0.6 } },
      },
      {
        id: "rec-C",
        t: new Date().toISOString(),
        lifecycle: { tier: 3, last_access_at: new Date().toISOString() },
        content: "kilo lima mike november oscar",
        title: "Memory C",
        scope: "project",
        type: "fact",
        source: "session",
        confidence: 0.7,
      },
    ]);

    const r = runScorer();
    assert.strictEqual(r.status, 0, "scorer should run; stderr: " + r.stderr);

    assert.ok(fs.existsSync(queueFile), "promotion-queue.jsonl should be created");
    const queue = readJsonl(queueFile);
    // Tier 2 and Tier 3 records are scored; we seeded 2 tier-2 + 1 tier-3 = 3
    assert.strictEqual(queue.length, 3);

    // Every entry should have a score in [0, 1] and components
    for (const entry of queue) {
      assert.ok(typeof entry.score === "number");
      assert.ok(entry.score >= 0 && entry.score <= 1, `score out of range: ${entry.score}`);
      assert.ok(entry.components);
      assert.ok(typeof entry.components.recency === "number");
      assert.ok(typeof entry.components.confidence === "number");
      assert.ok(typeof entry.components.crossSessionHits === "number");
      assert.ok(typeof entry.components.sourceQuality === "number");
    }
  });

  test("monotonicity: better records score higher than worse records", () => {
    // "Better" record: high confidence, recent access, multiple cross-session refs, high source quality
    const better = {
      id: "better-rec",
      t: new Date().toISOString(),
      lifecycle: { tier: 2, last_access_at: new Date().toISOString() },
      content: "alpha bravo charlie",
      title: "Better",
      scope: "user",
      type: "fact",
      source: "session",
      confidence: 1.0,
      metadata: {
        promotion: {
          source_confidence: 1.0,
          cross_session_refs: ["s1", "s2", "s3", "s4", "s5"],
        },
      },
    };
    // "Worse" record: low confidence, old access, no cross-session refs, low source quality
    const worse = {
      id: "worse-rec",
      t: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),   // 1 year old
      lifecycle: { tier: 2, last_access_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() },
      content: "delta echo foxtrot",
      title: "Worse",
      scope: "user",
      type: "fact",
      source: "heuristic",
      confidence: 0.1,
      metadata: { promotion: { source_confidence: 0.1 } },
    };
    seedStructured([better, worse]);

    const r = runScorer();
    assert.strictEqual(r.status, 0, "scorer should run; stderr: " + r.stderr);

    const queue = readJsonl(queueFile);
    assert.strictEqual(queue.length, 2);

    const betterScored = queue.find((q) => q.id === "better-rec");
    const worseScored  = queue.find((q) => q.id === "worse-rec");
    assert.ok(betterScored, "better record should be in queue");
    assert.ok(worseScored, "worse record should be in queue");

    // Monotonicity: better should have a strictly higher score
    assert.ok(
      betterScored.score > worseScored.score,
      `better score (${betterScored.score}) should exceed worse score (${worseScored.score})`
    );

    // Queue should be sorted descending by score
    assert.strictEqual(queue[0].id, "better-rec");
  });
});

describe("memory-promotion-scorer — filter rules", () => {
  test("Tier 1 records are NOT scored (only Tier 2-3 are candidates)", () => {
    seedStructured([
      {
        id: "tier1-rec",
        t: new Date().toISOString(),
        lifecycle: { tier: 1 },
        content: "tier one content",
        source: "session",
        confidence: 0.9,
      },
    ]);
    const r = runScorer();
    assert.strictEqual(r.status, 0);
    // Queue file may exist but should have zero candidates
    const queue = fs.existsSync(queueFile) ? readJsonl(queueFile) : [];
    assert.strictEqual(queue.length, 0, "tier-1 records should be filtered out");
  });

  test("Tier 5 (archived) records are NOT scored", () => {
    seedStructured([
      {
        id: "tier5-rec",
        t: new Date().toISOString(),
        lifecycle: { tier: 5 },
        content: "archived content",
        source: "session",
        confidence: 0.9,
      },
    ]);
    const r = runScorer();
    assert.strictEqual(r.status, 0);
    const queue = fs.existsSync(queueFile) ? readJsonl(queueFile) : [];
    assert.strictEqual(queue.length, 0, "tier-5 records should be filtered out");
  });
});
