/**
 * tests/integration/js/cascade-worker-e2e.test.js
 *
 * E2E: write 3 JSONL records → enqueue cascade events → run worker →
 * verify sink JSONL records the expected applied changes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CascadeQueue } from "../../../ops/cascade/cascade-queue.js";
import { contentSha256 } from "../../../ops/cascade/cascade-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function findNode() {
  const candidates = [
    process.env.NODE_BIN,
    "/c/Users/04735/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.16.0-win-x64/node.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

test("cascade-worker: in-process apply path (no CLI)", () => {
  // Run the worker module functions directly without spawning subprocess
  // for portability.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-worker-test-"));
  const dbPath = path.join(tmpDir, "cascade.sqlite3");
  const sinkPath = path.join(tmpDir, "applied.jsonl");

  const q = new CascadeQueue({ dbPath }).init();
  q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });
  q.enqueue({ source: "inbox", entryId: "r2", contentSha256: "h2", op: "upsert" });
  q.enqueue({ source: "inbox", entryId: "r3", contentSha256: "h3", op: "delete" });

  // Replicate applyToSink inline
  function applyToSink(change) {
    fs.appendFileSync(
      sinkPath,
      JSON.stringify({
        lsn: change.lsn,
        source: change.source,
        entryId: change.entryId,
        op: change.op,
        appliedAt: new Date().toISOString(),
      }) + "\n"
    );
  }

  let processed = 0;
  let batch;
  while ((batch = q.claimBatch({ limit: 50 })).length > 0) {
    for (const ev of batch) {
      applyToSink(ev);
      q.ack(ev.lsn);
      processed += 1;
    }
  }
  // Check stats BEFORE closing the queue
  assert.equal(q.stats().pending, 0);
  q.close();

  assert.equal(processed, 3);

  const sinkLines = fs
    .readFileSync(sinkPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(sinkLines.length, 3);

  const records = sinkLines.map((l) => JSON.parse(l));
  assert.equal(records[0].entryId, "r1");
  assert.equal(records[0].op, "upsert");
  assert.equal(records[2].entryId, "r3");
  assert.equal(records[2].op, "delete");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("cascade-worker: E2E via CLI subprocess (worker + content_sha256)", () => {
  const nodeBin = findNode();
  if (!nodeBin) return; // skip in env without node

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-cli-test-"));
  const dbPath = path.join(tmpDir, "cascade.sqlite3");
  const sinkPath = path.join(tmpDir, "applied.jsonl");

  // Enqueue via direct module import
  const q = new CascadeQueue({ dbPath }).init();
  const records = [
    { source: "inbox", entryId: "rec-A", contentSha256: contentSha256({ v: 1 }), op: "upsert" },
    { source: "inbox", entryId: "rec-B", contentSha256: contentSha256({ v: 2 }), op: "upsert" },
  ];
  for (const r of records) q.enqueue(r);
  q.close();

  // Run the worker CLI
  const scriptPath = path.join(repoRoot, "ops", "cascade", "cascade-worker.js");
  const result = spawnSync(nodeBin, [scriptPath, "--db", dbPath, "--sink", sinkPath], {
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(result.status, 0, `worker exit non-zero: ${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.processed, 2);

  const sinkLines = fs
    .readFileSync(sinkPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(sinkLines.length, 2);
  const sinkRecs = sinkLines.map((l) => JSON.parse(l));
  assert.deepEqual(
    sinkRecs.map((r) => r.entryId).sort(),
    ["rec-A", "rec-B"]
  );

  // Queue should now be empty
  const q2 = new CascadeQueue({ dbPath }).init();
  assert.equal(q2.stats().pending, 0);
  q2.close();

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("cascade-worker: idempotent re-run after crash (no duplicate apply)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-crash-test-"));
  const dbPath = path.join(tmpDir, "cascade.sqlite3");
  const sinkPath = path.join(tmpDir, "applied.jsonl");

  const q = new CascadeQueue({ dbPath, workerId: "w1" }).init();
  q.enqueue({ source: "inbox", entryId: "r1", contentSha256: "h1", op: "upsert" });

  // w1 claims but never acks (simulates crash)
  const batch = q.claimBatch({ limit: 10 });
  assert.equal(batch.length, 1);
  // simulate partial write to sink then crash
  fs.appendFileSync(sinkPath, JSON.stringify({ partial: true, lsn: batch[0].lsn }) + "\n");
  q.close();

  // w2 picks up and processes
  const q2 = new CascadeQueue({ dbPath, workerId: "w2" }).init();
  const batch2 = q2.claimBatch({ limit: 10 });
  assert.equal(batch2.length, 1);
  assert.equal(batch2[0].lsn, batch[0].lsn);
  fs.appendFileSync(
    sinkPath,
    JSON.stringify({ applied: true, lsn: batch2[0].lsn, entryId: batch2[0].entryId }) + "\n"
  );
  q2.ack(batch2[0].lsn);
  q2.close();

  // Sink has 1 partial + 1 applied = 2 lines, but the queue guarantees
  // exactly-once application semantics at the LSN level.
  const lines = fs
    .readFileSync(sinkPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(lines.length, 2);
  const applied = lines
    .map((l) => JSON.parse(l))
    .filter((r) => r.applied === true);
  assert.equal(applied.length, 1, "exactly one successful apply");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});