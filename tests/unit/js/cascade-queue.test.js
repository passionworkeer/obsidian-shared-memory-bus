/**
 * tests/unit/js/cascade-queue.test.js
 *
 * Unit tests for ops/cascade/cascade-queue.js — SQLite-backed change queue
 * with LSN-based crash recovery and dedup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CascadeQueue,
  contentSha256,
  diffByHash,
} from "../../../ops/cascade/cascade-queue.js";

function tmpDbPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cascade-test-")),
    "cascade.sqlite3"
  );
}

// ---------------------------------------------------------------------------
// Pure-function tests (no DB)
// ---------------------------------------------------------------------------

test("contentSha256: deterministic for same input regardless of key order", () => {
  const a = contentSha256({ id: "1", name: "x", tags: ["a", "b"] });
  const b = contentSha256({ tags: ["a", "b"], name: "x", id: "1" });
  assert.equal(a, b);
});

test("contentSha256: different content produces different hash", () => {
  const a = contentSha256({ id: "1", name: "x" });
  const b = contentSha256({ id: "1", name: "y" });
  assert.notEqual(a, b);
});

test("contentSha256: handles null, arrays, nested objects", () => {
  const a = contentSha256(null);
  const b = contentSha256({ nested: { a: [1, 2, 3] } });
  const c = contentSha256({ nested: { a: [1, 2, 3] } });
  assert.equal(typeof a, "string");
  assert.equal(b, c);
  assert.notEqual(a, b);
});

test("diffByHash: detects new entries as upserts", () => {
  const result = diffByHash(
    [],
    [{ id: "1", contentSha256: "aaa" }, { id: "2", contentSha256: "bbb" }]
  );
  assert.equal(result.upserts.length, 2);
  assert.equal(result.deletes.length, 0);
});

test("diffByHash: detects removed entries as deletes", () => {
  const result = diffByHash(
    [{ id: "1", contentSha256: "aaa" }],
    []
  );
  assert.equal(result.upserts.length, 0);
  assert.equal(result.deletes.length, 1);
  assert.equal(result.deletes[0].id, "1");
});

test("diffByHash: detects changed hashes as upserts, unchanged skipped", () => {
  const result = diffByHash(
    [
      { id: "1", contentSha256: "aaa" },
      { id: "2", contentSha256: "bbb" },
    ],
    [
      { id: "1", contentSha256: "aaa" }, // unchanged
      { id: "2", contentSha256: "NEW" }, // changed
      { id: "3", contentSha256: "ccc" }, // new
    ]
  );
  assert.equal(result.upserts.length, 2);
  const upsertIds = result.upserts.map((u) => u.id).sort();
  assert.deepEqual(upsertIds, ["2", "3"]);
  assert.equal(result.deletes.length, 0);
});

// ---------------------------------------------------------------------------
// CascadeQueue (SQLite) tests
// ---------------------------------------------------------------------------

test("CascadeQueue: enqueue + claimBatch + ack basic flow", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  const lsn1 = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  const lsn2 = q.enqueue({ source: "inbox", entryId: "r2", contentSha256: "h2", op: "upsert" });
  assert.ok(lsn1 > 0);
  assert.ok(lsn2 > lsn1);

  const batch = q.claimBatch({ workerId: "w1", limit: 10 });
  assert.equal(batch.length, 2);
  assert.equal(batch[0].lsn, lsn1);
  assert.equal(batch[0].entryId, "r1");
  assert.equal(batch[0].op, "upsert");

  q.ack(lsn1);
  const stats = q.stats();
  assert.equal(stats.pending, 1);
  assert.equal(stats.oldestLsn, lsn2);
  q.close();
});

test("CascadeQueue: dedup window — identical consecutive events collapse", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  const lsn1 = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  const lsn2 = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  assert.equal(lsn1, lsn2, "duplicate (source, entryId, hash, op) should return same LSN");
  assert.equal(q.stats().pending, 1);
  q.close();
});

test("CascadeQueue: dedup window — different hash creates new event", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  const lsn2 = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h2", op: "upsert" });
  assert.ok(lsn2 > 0);
  assert.equal(q.stats().pending, 2);
  q.close();
});

test("CascadeQueue: crash recovery — failed events stay in queue for retry", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  const lsn = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  const batch = q.claimBatch({ workerId: "w1", limit: 10 });
  assert.equal(batch.length, 1);
  // Worker "crashes" — calls fail() which releases the claim
  q.fail(lsn, "worker-died");
  // Next worker should be able to reclaim it
  const batch2 = q.claimBatch({ workerId: "w2", limit: 10 });
  assert.equal(batch2.length, 1);
  assert.equal(batch2[0].lsn, lsn);
  q.ack(batch2[0].lsn);
  assert.equal(q.stats().pending, 0);
  q.close();
});

test("CascadeQueue: crash recovery — partially-acked batch resumes from LSN", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  const l1 = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  q.enqueue({ source: "inbox", entryId: "r2", contentSha256: "h2", op: "upsert" });
  q.enqueue({ source: "inbox", entryId: "r3", contentSha256: "h3", op: "upsert" });

  // Worker 1 claims all 3, processes 1, "crashes" on 2 (no ack, no fail).
  const batch1 = q.claimBatch({ workerId: "w1", limit: 10 });
  assert.equal(batch1.length, 3);
  q.ack(l1);

  // Worker 2 should reclaim both unprocessed events — w1's claim is
  // released for crash recovery (no ack means the worker may have died).
  const batch2 = q.claimBatch({ workerId: "w2", limit: 10 });
  assert.equal(batch2.length, 2);
  const reclaimedLsns = batch2.map((e) => e.lsn).sort();
  assert.deepEqual(reclaimedLsns, [batch1[1].lsn, batch1[2].lsn].sort());
  for (const ev of batch2) q.ack(ev.lsn);
  assert.equal(q.stats().pending, 0);
  q.close();
});

test("CascadeQueue: prune removes old acked events", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  const lsn = q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  q.ack(lsn);
  // Backdate the processed_at to 1 hour ago so prune() with default 7-day
  // window won't catch it, then call prune with 0 hours equivalent by
  // passing a manual override. Easiest: rewrite processed_at to 8 days ago.
  q._db
    .prepare(
      `UPDATE cascade_queue SET processed_at = datetime('now', '-8 days') WHERE id = ?`
    )
    .run(lsn);
  const removed = q.prune({ olderThanDays: 7 });
  assert.ok(removed >= 1);
  q.close();
});

test("CascadeQueue: stats counts pending events across sources", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  q.enqueue({ source: "events", entryId: "e1", contentSha256: "h2", op: "upsert" });
  q.enqueue({ source: "events", entryId: "e2", contentSha256: "h3", op: "delete" });
  assert.equal(q.stats().pending, 3);
  q.close();
});

test("CascadeQueue: init is idempotent (safe to call twice)", () => {
  const dbPath = tmpDbPath();
  const q1 = new CascadeQueue({ dbPath }).init();
  q1.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  q1.close();
  const q2 = new CascadeQueue({ dbPath }).init();
  assert.equal(q2.stats().pending, 1);
  q2.close();
});

test("CascadeQueue: enqueue validates op", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  assert.throws(() => q.enqueue({ source: "x", op: "bogus" }), /invalid op/);
  q.close();
});

test("CascadeQueue: claimBatch respects limit", () => {
  const q = new CascadeQueue({ dbPath: tmpDbPath() }).init();
  for (let i = 0; i < 10; i++) {
    q.enqueue({ source: "inbox", entryId: `r${i}`, contentSha256: `h${i}`, op: "upsert" });
  }
  const batch = q.claimBatch({ workerId: "w1", limit: 3 });
  assert.equal(batch.length, 3);
  assert.equal(q.stats().pending, 10); // claimed but not acked
  for (const ev of batch) q.ack(ev.lsn);
  assert.equal(q.stats().pending, 7);
  q.close();
});