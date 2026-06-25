/**
 * ops/cascade/cascade-worker.js
 *
 * Worker harness that drains the cascade queue and applies changes to a
 * downstream sink. The default sink is a simple "applied index" JSONL
 * that records (lsn, source, entryId, op, appliedAt). In production this
 * would be replaced with calls to bus/generate-embeddings.js (incremental
 * re-embed) and retrieval/ann_index.add() (incremental vector insert).
 *
 * Usage:
 *   node ops/cascade/cascade-worker.js --db path/to/cascade.sqlite3
 *                                      --sink path/to/applied.jsonl
 *                                      [--batch 50] [--loop]
 *
 * The PoC is intentionally a thin orchestrator: the interesting logic is
 * in cascade-queue.js. The worker's job is just "claim → apply → ack".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CascadeQueue } from "./cascade-queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadStoreRootHelper() {
  const candidates = [
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    path.join(__dirname, "bus", "store-root.js"),
    path.join(__dirname, "store-root.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i += 2) {
  argMap[args[i].replace(/^--/, "")] = args[i + 1];
}

const dbPath = argMap.db || path.join(process.cwd(), "cascade.sqlite3");
const sinkPath = argMap.sink || path.join(process.cwd(), "cascade-applied.jsonl");
const batchSize = Number(argMap.batch || 50);
const loop = args.includes("--loop");

const resolveStoreRootMod = await loadStoreRootHelper();
const resolveStoreRoot = resolveStoreRootMod?.resolveStoreRoot || resolveStoreRootMod;

const queue = new CascadeQueue({ dbPath });
queue.init();

function applyToSink(change) {
  // Append a single JSONL line recording the applied change. Append-only,
  // so concurrent workers don't conflict (worst case: two lines in
  // different order, which is acceptable for an audit log).
  const line = JSON.stringify({
    lsn: change.lsn,
    source: change.source,
    entryId: change.entryId,
    op: change.op,
    appliedAt: new Date().toISOString(),
  });
  fs.appendFileSync(sinkPath, line + "\n");
}

async function processOnce() {
  const batch = queue.claimBatch({ limit: batchSize });
  if (batch.length === 0) return 0;
  for (const change of batch) {
    try {
      applyToSink(change);
      queue.ack(change.lsn);
    } catch (err) {
      queue.fail(change.lsn, err.message);
    }
  }
  return batch.length;
}

async function main() {
  const total = await processOnce();
  process.stdout.write(
    JSON.stringify({ processed: total, dbPath, sinkPath, loop }) + "\n"
  );
  if (loop) {
    let idleTicks = 0;
    const tick = setInterval(async () => {
      const n = await processOnce();
      if (n === 0) {
        idleTicks += 1;
        if (idleTicks >= 5) {
          clearInterval(tick);
          queue.close();
          process.exit(0);
        }
      } else {
        idleTicks = 0;
      }
    }, 500);
  } else {
    queue.close();
  }
}

const IS_CLI = import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  main().catch((err) => {
    process.stderr.write(`cascade-worker failed: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export { applyToSink, processOnce };