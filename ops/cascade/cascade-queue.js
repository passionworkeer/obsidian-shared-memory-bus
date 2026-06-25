/**
 * ops/cascade/cascade-queue.js
 *
 * Cascade queue — incremental change tracking for the memory bus
 * (EverOS-inspired). JSONL append events are recorded in a SQLite queue
 * keyed by (path, lsn) with content_sha256 for diff; a worker drains the
 * queue and applies only the changed entries to the downstream index.
 *
 * Why this exists:
 *   - The legacy PowerShell watchdog (bus/memory-watchdog.ps1) triggers a
 *     full embeddings re-snapshot whenever mtime changes. That's safe but
 *     wasteful at scale (10k+ records) and has no crash-recovery story.
 *   - The cascade model: write-path enqueues a small change record;
 *     worker pulls changes in order; if the worker dies mid-batch, the
 *     next worker picks up where it left off via LSN.
 *
 * Schema (queue table):
 *   CREATE TABLE cascade_queue (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,   -- LSN
 *     source TEXT NOT NULL,                  -- e.g. "shared-inbox"
 *     entry_id TEXT,                         -- record id from JSONL
 *     content_sha256 TEXT,                   -- SHA-256 of the record payload
 *     op TEXT NOT NULL CHECK(op IN ('upsert','delete')),
 *     enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
 *     processed_at TEXT,                     -- when the worker acked
 *     worker_id TEXT,                        -- which worker drained it
 *     last_error TEXT
 *   );
 *   CREATE INDEX ... ON cascade_queue(processed_at, id)
 *
 * Usage:
 *   import { CascadeQueue } from "./cascade-queue.js";
 *   const q = new CascadeQueue({ dbPath: ".../cascade.sqlite3" });
 *   q.init();
 *   const lsn = q.enqueue({ source: "shared-inbox", entryId: "rec-001",
 *                            contentSha256: "abc...", op: "upsert" });
 *   const batch = q.claimBatch({ workerId: "w1", limit: 50 });
 *   for (const change of batch) { apply(change); q.ack(change.id); }
 *   q.close();
 *
 * Inspired by:
 *   - EverOS docs/cascade_runbook.md "watchdog + SQLite md_change_state"
 *   - tech-debt-roadmap.md §5.5 "cascade 队列触发增量索引"
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing; no DB needed)
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of a JSON-serializable value with deterministic key order.
 * Same input always produces same hash; consumers can compare hashes to
 * detect "did this record actually change?" without diffing the whole record.
 */
export function contentSha256(value) {
  const canonical = canonicalize(value);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]))
      .join(",") +
    "}"
  );
}

/**
 * Diff two record sets by content hash. Returns { upserts, deletes } —
 * upserts are ids present in `current` but not in `previous` OR with changed
 * hash; deletes are ids present in `previous` but not in `current`.
 *
 * This is the core "don't re-embed unchanged records" logic.
 */
export function diffByHash(previous, current) {
  const prevMap = new Map(previous.map((r) => [r.id, r.contentSha256]));
  const currMap = new Map(current.map((r) => [r.id, r.contentSha256]));
  const upserts = [];
  const deletes = [];
  for (const [id, hash] of currMap) {
    const prevHash = prevMap.get(id);
    if (prevHash !== hash) upserts.push({ id, contentSha256: hash });
  }
  for (const [id] of prevMap) {
    if (!currMap.has(id)) deletes.push({ id });
  }
  return { upserts, deletes };
}

// ---------------------------------------------------------------------------
// CascadeQueue — SQLite-backed change queue
// ---------------------------------------------------------------------------

export class CascadeQueue {
  /**
   * @param {{ dbPath: string, workerId?: string }} opts
   */
  constructor({ dbPath, workerId = "worker-" + process.pid }) {
    if (!dbPath) throw new Error("cascade-queue: dbPath is required");
    this.dbPath = dbPath;
    this.workerId = workerId;
    this._db = null;
  }

  /**
   * Open the SQLite database and ensure the schema exists. Safe to call
   * multiple times; CREATE IF NOT EXISTS is idempotent.
   */
  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    this._db.exec("PRAGMA journal_mode = WAL;");
    this._db.exec("PRAGMA busy_timeout = 10000;");
    this._db.exec("PRAGMA synchronous = NORMAL;");
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS cascade_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        entry_id TEXT,
        content_sha256 TEXT,
        op TEXT NOT NULL CHECK(op IN ('upsert','delete')),
        enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        worker_id TEXT,
        last_error TEXT
      )
    `);
    this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cascade_unprocessed
        ON cascade_queue(id)
        WHERE processed_at IS NULL
    `);
    return this;
  }

  /**
   * Append a change event. Returns the assigned LSN.
   * Idempotency: if the previous unprocessed event for the same (source,
   * entryId) has the same contentSha256 + op, this call returns the
   * existing LSN (no duplicate enqueue).
   */
  enqueue({ source, entryId = null, contentSha256: hash = null, op }) {
    this._assertOpen();
    if (!source) throw new Error("cascade-queue: source is required");
    if (op !== "upsert" && op !== "delete") {
      throw new Error(`cascade-queue: invalid op ${op}`);
    }
    // Dedup window: collapse consecutive identical events for the same key.
    const existing = this._db
      .prepare(
        `SELECT id, content_sha256, op FROM cascade_queue
         WHERE source = ? AND entry_id IS ? AND processed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get(source, entryId);
    if (
      existing &&
      existing.content_sha256 === hash &&
      existing.op === op
    ) {
      return existing.id;
    }
    const result = this._db
      .prepare(
        `INSERT INTO cascade_queue (source, entry_id, content_sha256, op)
         VALUES (?, ?, ?, ?)`
      )
      .run(source, entryId, hash, op);
    return Number(result.lastInsertRowid);
  }

  /**
   * Claim up to `limit` unprocessed events for the given worker.
   *
   * Crash-recovery semantics: any worker can claim events that have not
   * been processed yet, including events previously claimed by a worker
   * that crashed without calling ack() or fail(). This is safe because:
   *
   *   - LSN is monotonic (always pick the lowest unprocessed LSN first)
   *   - Downstream sinks MUST be idempotent on (lsn, op) so re-application
   *     is harmless. The cascade-worker default sink records every apply
   *     with a timestamp; production sinks like embeddings re-embed which
   *     is idempotent for a given content_sha256.
   *
   * If you want strict ownership (no claim-stealing), gate at a higher
   * layer with a distributed lock or limit to a single worker process.
   */
  claimBatch({ limit = 50 } = {}) {
    this._assertOpen();
    const stmt = this._db.prepare(
      `SELECT id, source, entry_id, content_sha256, op, enqueued_at
       FROM cascade_queue
       WHERE processed_at IS NULL
       ORDER BY id ASC
       LIMIT ?`
    );
    const rows = stmt.all(limit);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this._db
      .prepare(
        `UPDATE cascade_queue SET worker_id = ?
         WHERE id IN (${placeholders}) AND processed_at IS NULL`
      )
      .run(this.workerId, ...ids);
    return rows.map((r) => ({
      lsn: r.id,
      source: r.source,
      entryId: r.entry_id,
      contentSha256: r.content_sha256,
      op: r.op,
      enqueuedAt: r.enqueued_at,
    }));
  }

  /**
   * Mark a claimed event as successfully processed.
   */
  ack(lsn) {
    this._assertOpen();
    this._db
      .prepare(
        `UPDATE cascade_queue
         SET processed_at = datetime('now'), last_error = NULL
         WHERE id = ? AND worker_id = ?`
      )
      .run(lsn, this.workerId);
  }

  /**
   * Mark a claimed event as failed; release worker_id so another worker
   * (or this one on retry) can re-claim it. Keeps the event in the queue.
   */
  fail(lsn, error) {
    this._assertOpen();
    this._db
      .prepare(
        `UPDATE cascade_queue
         SET worker_id = NULL, last_error = ?
         WHERE id = ?`
      )
      .run(String(error || "unknown"), lsn);
  }

  /**
   * Return queue depth + oldest unprocessed LSN. Used by health checks.
   */
  stats() {
    this._assertOpen();
    const row = this._db
      .prepare(
        `SELECT COUNT(*) AS pending, MIN(id) AS oldest
         FROM cascade_queue WHERE processed_at IS NULL`
      )
      .get();
    return { pending: row.pending, oldestLsn: row.oldest };
  }

  /**
   * Truncate processed events older than `days` days. Garbage collection;
   * defaults to 7 days to keep audit trail bounded.
   */
  prune({ olderThanDays = 7 } = {}) {
    this._assertOpen();
    const r = this._db
      .prepare(
        `DELETE FROM cascade_queue
         WHERE processed_at IS NOT NULL
           AND processed_at < datetime('now', ?)`
      )
      .run(`-${olderThanDays} days`);
    return r.changes || 0;
  }

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  _assertOpen() {
    if (!this._db) throw new Error("cascade-queue: not initialized; call init() first");
  }
}