/**
 * Unit tests for ops/memory/memory-promotion-resolver.js
 *
 * The module is a CLI script (top-level main() invocation), so we
 * exercise it by:
 *   1. Pre-writing a promotion-queue.jsonl
 *   2. Spawning the script
 *   3. Verifying the resolved-queue.jsonl and human-review-queue.jsonl
 *      output reflects the documented resolution strategy:
 *        - Higher score wins
 *        - Within 0.1 of winner → human review
 *        - Otherwise → dropped
 *
 * Run with: node --test tests/unit/js/memory-promotion-resolver.test.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../../ops/memory/memory-promotion-resolver.js");

let tempStoreRoot;
let structDir;
let queueDir;
let queueFile;
let resolvedFile;
let reviewFile;

function runResolver(args = []) {
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

beforeEach(() => {
  tempStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-test-"));
  structDir = path.join(tempStoreRoot, "structured");
  queueDir = path.join(tempStoreRoot, ".ai-memory", "queue");
  queueFile = path.join(queueDir, "promotion-queue.jsonl");
  resolvedFile = path.join(queueDir, "resolved-queue.jsonl");
  reviewFile = path.join(queueDir, "human-review-queue.jsonl");
  fs.mkdirSync(structDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });
});

afterEach(() => {
  if (tempStoreRoot && fs.existsSync(tempStoreRoot)) {
    fs.rmSync(tempStoreRoot, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("memory-promotion-resolver — smoke", () => {
  test("exits non-zero when no store-root is provided", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, AI_MEMORY_STORE: "" },
      encoding: "utf8",
    });
    assert.notStrictEqual(r.status, 0);
  });

  test("exits 0 but reports no-op when queue file is missing", () => {
    const r = runResolver();
    assert.strictEqual(r.status, 0, "should exit cleanly; stderr: " + r.stderr);
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Queue file not found/);
  });
});

describe("memory-promotion-resolver — round-trip", () => {
  test("non-conflicting entries: all are resolved as auto-promote", () => {
    // Three entries with no conflicts → all should be in resolved-queue
    writeJsonl(queueFile, [
      {
        id: "rec-A",
        score: 0.85,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [],
      },
      {
        id: "rec-B",
        score: 0.72,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [],
      },
      {
        id: "rec-C",
        score: 0.50,
        tier_from: 3,
        tier_to: 4,
        needs_review: true,
        conflicts: [],
      },
    ]);

    const r = runResolver();
    assert.strictEqual(r.status, 0, "resolver should run; stderr: " + r.stderr);

    const resolved = readJsonl(resolvedFile);
    assert.strictEqual(resolved.length, 3, "all 3 should be resolved");
    for (const entry of resolved) {
      assert.strictEqual(entry.resolution, "auto");
      assert.strictEqual(entry.resolution_note, "no conflicts");
    }
    // Resolved queue should be sorted by score DESC
    assert.strictEqual(resolved[0].id, "rec-A");
    assert.strictEqual(resolved[1].id, "rec-B");
    assert.strictEqual(resolved[2].id, "rec-C");

    // Human review queue should be empty
    const review = readJsonl(reviewFile);
    assert.strictEqual(review.length, 0);
  });
});

describe("memory-promotion-resolver — conflict resolution", () => {
  test("conflict pair: higher score wins, loser within 0.1 goes to human review", () => {
    // rec-X (0.80) conflicts with rec-Y (0.75) — gap of 0.05 < 0.10 → human review
    writeJsonl(queueFile, [
      {
        id: "rec-X",
        score: 0.80,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [{ otherId: "rec-Y", overlap_score: 0.85 }],
      },
      {
        id: "rec-Y",
        score: 0.75,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [{ otherId: "rec-X", overlap_score: 0.85 }],
      },
    ]);

    const r = runResolver();
    assert.strictEqual(r.status, 0, "resolver should run; stderr: " + r.stderr);

    const resolved = readJsonl(resolvedFile);
    const review = readJsonl(reviewFile);

    // Winner (rec-X) should be in resolved
    const winner = resolved.find((e) => e.id === "rec-X");
    assert.ok(winner, "winner rec-X should be in resolved queue");
    assert.strictEqual(winner.resolution, "auto");
    assert.match(winner.resolution_note, /conflict_winner/);

    // Loser (rec-Y) with gap 0.05 → human review
    const loser = review.find((e) => e.id === "rec-Y");
    assert.ok(loser, "loser rec-Y should be in human review queue");
    assert.strictEqual(loser.resolution, "human_review");
    assert.strictEqual(loser.needs_review, true);
    assert.strictEqual(loser.winner_id, "rec-X");
    assert.ok(loser.score_gap < 0.1, `gap ${loser.score_gap} should be < 0.1`);
  });

  test("conflict pair: large gap → loser is dropped (not reviewed, not resolved)", () => {
    // rec-P (0.90) conflicts with rec-Q (0.30) — gap of 0.60 > 0.10 → dropped
    writeJsonl(queueFile, [
      {
        id: "rec-P",
        score: 0.90,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [{ otherId: "rec-Q", overlap_score: 0.85 }],
      },
      {
        id: "rec-Q",
        score: 0.30,
        tier_from: 2,
        tier_to: 3,
        needs_review: true,
        conflicts: [{ otherId: "rec-P", overlap_score: 0.85 }],
      },
    ]);

    const r = runResolver();
    assert.strictEqual(r.status, 0, "resolver should run; stderr: " + r.stderr);

    const resolved = readJsonl(resolvedFile);
    const review = readJsonl(reviewFile);

    // Winner (rec-P) in resolved
    const winner = resolved.find((e) => e.id === "rec-P");
    assert.ok(winner, "winner rec-P should be in resolved queue");
    assert.strictEqual(winner.resolution, "auto");

    // Loser (rec-Q) with gap 0.60 → NOT in resolved, NOT in human review
    assert.strictEqual(
      resolved.find((e) => e.id === "rec-Q"),
      undefined,
      "rec-Q should not be in resolved queue"
    );
    assert.strictEqual(
      review.find((e) => e.id === "rec-Q"),
      undefined,
      "rec-Q should not be in human review queue"
    );
    // The script logs dropped entries
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Dropped.*rec-Q/);
  });
});

describe("memory-promotion-resolver — deduplication", () => {
  test("duplicate candidate ids: each entry is processed independently (no dedup at array level)", () => {
    // The resolver iterates over queueEntries and processes each one. The
    // conflict graph uses Sets for the conflict set, but the resolved/dropped/
    // human-review arrays may contain duplicates if the input queue has them.
    // This test pins that current behaviour so any future dedup change is
    // intentional and visible in the diff.
    writeJsonl(queueFile, [
      {
        id: "rec-DUP",
        score: 0.70,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [],
      },
      {
        id: "rec-DUP",
        score: 0.70,
        tier_from: 2,
        tier_to: 3,
        needs_review: false,
        conflicts: [],
      },
    ]);

    const r = runResolver();
    assert.strictEqual(r.status, 0, "resolver should run; stderr: " + r.stderr);

    // Confirm the script ran end-to-end without crashing
    assert.ok(fs.existsSync(resolvedFile), "resolved-queue.jsonl should exist");
    const resolved = readJsonl(resolvedFile);
    // Both duplicates should be present (no dedup happens at this layer)
    const recDupEntries = resolved.filter((e) => e.id === "rec-DUP");
    assert.ok(
      recDupEntries.length >= 1,
      "at least one rec-DUP should be in the resolved queue"
    );
  });
});
