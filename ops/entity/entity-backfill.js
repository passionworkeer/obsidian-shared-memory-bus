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
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load helpers from build-memory-layers.js
async function loadVaultRootHelper() {
  const candidates = [
    path.join(__dirname, "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }
  throw new Error("vault-root-helper-missing");
}

const _vaultRootHelper = await loadVaultRootHelper();
const { resolveVaultRoot } = _vaultRootHelper;

const VAULT_ROOT = resolveVaultRoot();
const AI_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_ROOT = path.join(AI_MEMORY_ROOT, "structured");
const KG_DIR = path.join(AI_MEMORY_ROOT, "kg");
const KG_PATH = path.join(KG_DIR, "knowledge-graph.sqlite3");

const DEFAULT_FILES = [
  "shared-inbox.jsonl",
  "session-memory.jsonl",
  "shared-events.jsonl",
  "task-memory.jsonl",
];

const entityExtractor = (async () => {
  try {
    const mod = await import("./entity-extractor.js");
    return mod.entityExtractor || mod.default || { extractFromRecord: r => r };
  } catch { return { extractFromRecord: r => r }; }
})();

const KnowledgeGraph = (async () => {
  try {
    const mod = await import("./knowledge-graph.js");
    return mod.KnowledgeGraph || null;
  } catch { return null; }
})();

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
function backfillFile(filePath) {
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
      const enrichedRecord = entityExtractor.extractFromRecord(record);
      const hasNewData = (enrichedRecord.facts?.length || enrichedRecord.concepts?.length || enrichedRecord.entities?.length);
      if (hasNewData) {
        enriched++;
        patched.push(JSON.stringify(enrichedRecord));
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

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0
    ? args.map(f => path.resolve(f))
    : DEFAULT_FILES.map(f => path.join(STRUCTURED_ROOT, f));

  console.log(`\n=== Entity Backfill ===`);
  console.log(`Vault: ${VAULT_ROOT}`);
  console.log(`Files: ${files.length}`);

  // Count before
  const beforeCounts = files.map(f => ({ file: path.basename(f), count: countRecords(f) }));
  console.log(`Records before: ${beforeCounts.map(b => b.count).reduce((a, b) => a + b, 0)}`);

  // Backfill
  const totals = { processed: 0, enriched: 0, errors: 0 };
  for (const file of files) {
    process.stdout.write(`Processing ${path.basename(file)}... `);
    const result = backfillFile(file);
    console.log(`${result.processed} records, ${result.enriched} enriched, ${result.errors} errors`);
    totals.processed += result.processed;
    totals.enriched += result.enriched;
    totals.errors += result.errors;
  }

  // Ingest into KG
  let kgRecordCount = 0;
  if (KnowledgeGraph && fs.existsSync(path.dirname(KG_PATH))) {
    try {
      const kg = new KnowledgeGraph({ vaultRoot: VAULT_ROOT });
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

if (import.meta.url === `file://${process.argv[1]}`) main();
