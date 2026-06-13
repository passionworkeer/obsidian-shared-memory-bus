/**
 * ops/entity-backfill.js
 * Backfill entity extraction on existing structured JSONL files.
 * Can be run multiple times safely — skips already-enriched records.
 *
 * Usage: node entity-backfill.js [jsonl-path...]
 *   node entity-backfill.js                          # process all structured files
 *   node entity-backfill.js shared-inbox.jsonl      # process one file
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { resolveStoreRoot } = await import("../../bus/store-root.js");

const STORE_ROOT = resolveStoreRoot();
const STRUCTURED_ROOT = path.join(STORE_ROOT, "structured");

const DEFAULT_FILES = [
  "shared-inbox.jsonl",
  "session-memory.jsonl",
  "shared-events.jsonl",
  "task-memory.jsonl",
];

async function loadEntityExtractor() {
  try {
    const mod = await import("./entity-extractor.js");
    return mod.entityExtractor || mod.default || mod;
  } catch { return { extractFromRecord: r => r }; }
}

async function loadKnowledgeGraphClass() {
  try {
    const mod = await import("../knowledge/knowledge-graph.js");
    return mod.KnowledgeGraph || null;
  } catch { return null; }
}

const entityExtractor = await loadEntityExtractor();
const KnowledgeGraph = await loadKnowledgeGraphClass();

/**
 * Count records in a JSONL file.
 */
function countRecords(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
}

/**
 * Backfill a single JSONL file.
 * @returns {{ processed: number, enriched: number, errors: number }}
 */
function backfillFile(filePath, extractor) {
  if (!fs.existsSync(filePath)) {
    console.error(`  File not found: ${filePath}`);
    return { processed: 0, enriched: 0, errors: 0 };
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  let processed = 0, enriched = 0, errors = 0;
  const patched = [];

  for (const line of lines) {
    if (!line.trim()) { patched.push(line); continue; }
    processed++;
    try {
      const record = JSON.parse(line);
      // Skip if already extracted
      if (record._entityExtracted) {
        patched.push(line);
        continue;
      }
      const enrichedRecord = extractor.extractFromRecord(record);
      const hasNewData = (enrichedRecord.facts?.length || enrichedRecord.concepts?.length || enrichedRecord.entities?.length);
      if (hasNewData) {
        enriched++;
        patched.push(JSON.stringify({ ...enrichedRecord, _entityExtracted: true }));
      } else {
        patched.push(line);
      }
    } catch (err) {
      errors++;
      patched.push(line);  // preserve original on error
    }
  }

  fs.writeFileSync(filePath, patched.join("\n"), "utf-8");
  return { processed, enriched, errors };
}

/**
 * Ingest all records from a JSONL file into the KG.
 */
function ingestFileIntoKG(filePath, kg) {
  if (!fs.existsSync(filePath) || !kg) return 0;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const hasEntityData = (record.entities?.length || record.facts?.length);
      if (hasEntityData) {
        kg.ingestRecord(record);
        count++;
      }
    } catch {}
  }
  return count;
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0
    ? args.map(f => (path.isAbsolute(f) || path.dirname(f) !== "." ? path.resolve(f) : path.join(STRUCTURED_ROOT, f)))
    : DEFAULT_FILES.map(f => path.join(STRUCTURED_ROOT, f));

  console.log(`\n=== Entity Backfill ===`);
  console.log(`Store: ${STORE_ROOT}`);
  console.log(`Files: ${files.length}`);

  // entityExtractor and KnowledgeGraph are loaded at module top-level.

  // Count before
  const beforeCounts = files.map(f => ({ file: path.basename(f), count: countRecords(f) }));
  console.log(`Records before: ${beforeCounts.map(b => b.count).reduce((a, b) => a + b, 0)}`);

  // Backfill
  const totals = { processed: 0, enriched: 0, errors: 0 };
  for (const file of files) {
    process.stdout.write(`Processing ${path.basename(file)}... `);
    const result = backfillFile(file, entityExtractor);
    console.log(`${result.processed} records, ${result.enriched} enriched, ${result.errors} errors`);
    totals.processed += result.processed;
    totals.enriched += result.enriched;
    totals.errors += result.errors;
  }

  // Ingest into KG
  let kgRecordCount = 0;
  if (KnowledgeGraph) {
    try {
      const kg = new KnowledgeGraph({ storeRoot: STORE_ROOT });
      kg.beginBatch();
      for (const file of files) {
        kgRecordCount += ingestFileIntoKG(file, kg);
      }
      kg.endBatch(true);
      kg.close();
      console.log(`\nKG: ingested entities/facts from ${kgRecordCount} records`);
    } catch (err) {
      console.error(`KG ingest error: ${err.message}`);
    }
  }

  // Count after
  const afterCounts = files.map(f => ({ file: path.basename(f), count: countRecords(f) }));
  console.log(`Records after:  ${afterCounts.map(b => b.count).reduce((a, b) => a + b, 0)}`);
  console.log(`\nTotal: ${totals.processed} processed, ${totals.enriched} enriched, ${totals.errors} errors`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
