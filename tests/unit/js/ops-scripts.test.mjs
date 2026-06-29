// Smoke/contract tests for ops scripts that have zero coverage:
//   - ops/verify/verify-atomic-write.js  (10-child stress runner)
//   - ops/setup/migrate-to-store.js      (one-shot migrator)
//   - ops/check/check-memory-integrity.js (--strict gate)
//
// Strategy:
//   - parse / load each script and assert it has the expected CLI shape
//   - for check-memory-integrity, exercise the actual report builder
//     (buildMemoryIntegrityReport) on a tiny fixture with one valid and one
//     invalid record, and assert the invalid one is flagged.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const VERIFY_ATOMIC = path.join(REPO_ROOT, "ops/verify/verify-atomic-write.js");
const MIGRATE_TO_STORE = path.join(REPO_ROOT, "ops/setup/migrate-to-store.js");
const CHECK_INTEGRITY = path.join(REPO_ROOT, "ops/check/check-memory-integrity.js");
const MEMORY_CONTRACT = path.join(REPO_ROOT, "ops/memory/memory-contract.js");

// ---------------------------------------------------------------------------
// node --check: each script must parse cleanly
// ---------------------------------------------------------------------------

test("verify-atomic-write.js parses as valid JavaScript", () => {
  const r = spawnSync(process.execPath, ["--check", VERIFY_ATOMIC], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr}`);
});

test("migrate-to-store.js parses as valid JavaScript", () => {
  const r = spawnSync(process.execPath, ["--check", MIGRATE_TO_STORE], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr}`);
});

test("check-memory-integrity.js parses as valid JavaScript", () => {
  const r = spawnSync(process.execPath, ["--check", CHECK_INTEGRITY], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Contract: each script's top exposes the expected CLI shape
// ---------------------------------------------------------------------------

test("verify-atomic-write.js uses spawn + Promise.all to orchestrate N children", () => {
  const src = fs.readFileSync(VERIFY_ATOMIC, "utf8");
  assert.match(src, /spawn\s*\(\s*process\.execPath/, "spawns node child");
  assert.match(src, /Promise\.all/, "orchestrates via Promise.all");
  assert.match(src, /RESULT:\s*PASS/, "prints PASS verdict on success");
  assert.match(src, /RESULT:\s*FAIL/, "prints FAIL verdict on failure");
});

test("migrate-to-store.js supports --dry-run / --verbose / --force flags", () => {
  const src = fs.readFileSync(MIGRATE_TO_STORE, "utf8");
  assert.match(src, /--dry-run/, "declares --dry-run");
  assert.match(src, /--verbose/, "declares --verbose");
  assert.match(src, /--force/, "declares --force");
  assert.match(src, /DRY RUN/, "prints DRY-RUN banner");
  assert.match(src, /MIGRATION COMPLETE/, "prints completion banner");
  assert.match(src, /process\.exit\(1\)/, "exits non-zero on failure");
});

test("check-memory-integrity.js supports --json and --strict flags", () => {
  const src = fs.readFileSync(CHECK_INTEGRITY, "utf8");
  assert.match(src, /--json/, "declares --json");
  assert.match(src, /--strict/, "declares --strict");
  assert.match(src, /buildMemoryIntegrityReport/, "calls the report builder");
  assert.match(src, /process\.exitCode\s*=\s*1/, "sets exit code 1 on --strict failure");
});

// ---------------------------------------------------------------------------
// Highest-value test: the --strict gate depends on the report builder.
// If the report builder ever stops flagging invalid records, the --strict
// gate silently lets corruption through. Guard that here.
// ---------------------------------------------------------------------------

test("buildMemoryIntegrityReport flags a corrupt record in a tiny fixture", async () => {
  const { buildMemoryIntegrityReport } = await import(pathToFileURL(MEMORY_CONTRACT).href);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ops-intg-test-"));
  const structuredDir = path.join(tmpRoot, "structured");
  const generatedDir = path.join(tmpRoot, "generated");
  fs.mkdirSync(structuredDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  // Valid record — matches REQUIRED_RECORD_FIELDS
  const validRecord = {
    schemaVersion: 2,
    id: "valid-1",
    tool: "test",
    type: "note",
    title: "valid title",
    source: "unit-test",
    scope: "project",
    memory_level: "durable",
    t: "2026-01-01T00:00:00.000Z",
  };

  // Invalid record — missing required fields and uses unknown scope
  const invalidRecord = {
    schemaVersion: 999, // wrong schema version
    id: "invalid-1",
    tool: "test",
    type: "note",
    scope: "not-a-real-scope", // not in ALLOWED_SCOPES
    memory_level: "bogus",     // not in ALLOWED_MEMORY_LEVELS
    // missing: title, source
  };

  const validLine = JSON.stringify(validRecord);
  const invalidLine = JSON.stringify(invalidRecord);

  // Write into session-memory.jsonl (one of the STRUCTURED_LAYER_DEFINITIONS)
  fs.writeFileSync(
    path.join(structuredDir, "session-memory.jsonl"),
    validLine + "\n" + invalidLine + "\n",
    "utf8"
  );

  const report = buildMemoryIntegrityReport({
    structuredRoot: structuredDir,
    generatedRoot: generatedDir,
  });

  assert.equal(report.totals.recordCount, 2, "both records counted");
  assert.equal(report.totals.validRecordCount, 1, "one valid record");
  assert.equal(report.totals.invalidRecordCount, 1, "one invalid record flagged");
  assert.notEqual(report.status, "ok", "status is not 'ok' — --strict would fire");
  assert.ok(
    report.issues.some((i) => i.startsWith("invalid-records:")),
    "issues include invalid-records summary"
  );

  // Cleanup
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("buildMemoryIntegrityReport returns status 'ok' for a clean fixture", async () => {
  const { buildMemoryIntegrityReport } = await import(pathToFileURL(MEMORY_CONTRACT).href);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ops-intg-test-"));
  const structuredDir = path.join(tmpRoot, "structured");
  const generatedDir = path.join(tmpRoot, "generated");
  fs.mkdirSync(structuredDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  const validRecord = {
    schemaVersion: 2,
    id: "clean-1",
    tool: "test",
    type: "note",
    title: "ok",
    source: "unit-test",
    scope: "project",
    memory_level: "durable",
    t: "2026-01-01T00:00:00.000Z",
  };

  fs.writeFileSync(
    path.join(structuredDir, "session-memory.jsonl"),
    JSON.stringify(validRecord) + "\n",
    "utf8"
  );

  // Provide a valid generated artifact so the builder doesn't surface a
  // 'generated-artifacts-missing' warn. The artifact must declare
  // contractVersion=2, recordSchemaVersion=2, and a sourceStructuredSignature
  // matching the current structured signature.
  const sigModule = await import(pathToFileURL(MEMORY_CONTRACT).href);
  const sig = sigModule.buildStructuredSignature
    ? sigModule.buildStructuredSignature(structuredDir)
    : null;
  for (const def of sigModule.GENERATED_MEMORY_DEFINITIONS || []) {
    const meta = {
      generatedAt: new Date().toISOString(),
      contractVersion: sigModule.MEMORY_INTEGRITY_CONTRACT_VERSION,
      recordSchemaVersion: sigModule.MEMORY_RECORD_SCHEMA_VERSION,
      sourceStructuredSignature: sig,
      description: def.label,
    };
    fs.writeFileSync(
      path.join(generatedDir, def.fileName),
      JSON.stringify(meta) + "\n",
      "utf8"
    );
  }

  const report = buildMemoryIntegrityReport({
    structuredRoot: structuredDir,
    generatedRoot: generatedDir,
  });

  assert.equal(report.totals.invalidRecordCount, 0);
  assert.equal(report.totals.malformedLineCount, 0);
  assert.equal(report.status, "ok", "clean fixture → status ok (--strict would pass)");

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("buildMemoryIntegrityReport flags malformed lines (non-JSON)", async () => {
  const { buildMemoryIntegrityReport } = await import(pathToFileURL(MEMORY_CONTRACT).href);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ops-intg-test-"));
  const structuredDir = path.join(tmpRoot, "structured");
  const generatedDir = path.join(tmpRoot, "generated");
  fs.mkdirSync(structuredDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  // Garbage line that is not valid JSON
  fs.writeFileSync(
    path.join(structuredDir, "session-memory.jsonl"),
    "this is not json\n",
    "utf8"
  );

  const report = buildMemoryIntegrityReport({
    structuredRoot: structuredDir,
    generatedRoot: generatedDir,
  });

  assert.equal(report.totals.malformedLineCount, 1, "malformed line counted");
  assert.notEqual(report.status, "ok", "malformed line → not ok");

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
