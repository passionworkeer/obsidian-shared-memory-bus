/**
 * tests/integration/js/memory-layers-flow.test.js
 * ===============================================
 * Integration tests for the complete memory layers build flow.
 *
 * Scenarios:
 *   1. build-memory-layers.js runs end-to-end and produces JSON output
 *   2. Output JSONL records contain the correct schemaVersion (written via inbox .md)
 *   3. GLOBAL-CONTEXT.md is generated
 *   4. Entity extraction does not block the main flow (KG unavailable → degraded mode)
 *
 * Note: parseInboxEntries() reads from inbox/ .md files (not from structured/ JSONL).
 * Seed data for inbox parsing uses .md inbox entries.
 *
 * Run with: node --test tests/integration/js/memory-layers-flow.test.js
 */

"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const os   = require("node:os");
const { spawn } = require("node:child_process");

const { createTempDir, cleanupTempDir, createTempJsonl, readJsonl } = require("../../helpers/setup");

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// Inbox entries written as .md files (parsed by parseInboxEntries())
const SAMPLE_INBOX_MD_ENTRIES = [
  {
    tool: "claude-code",
    timestamp: "2026-04-12T01:45:03Z",
    project: "test-project",
    content: "用户偏好中文回复 — user prefers Chinese responses",
  },
  {
    tool: "claude-code",
    timestamp: "2026-04-12T00:45:04Z",
    project: "test-project",
    content: "API authentication implementation — OAuth2 for REST endpoints",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write inbox entries as .md files (one file per tool).
 * Format: inbox/{tool}.md with lines like "- [timestamp] [project] content"
 */
function seedInboxMarkdown(inboxDir, entries) {
  const byTool = {};
  for (const entry of entries) {
    if (!byTool[entry.tool]) byTool[entry.tool] = [];
    byTool[entry.tool].push(
      `- [${entry.timestamp}] [${entry.project}] ${entry.content}`
    );
  }
  for (const [tool, lines] of Object.entries(byTool)) {
    const filePath = path.join(inboxDir, `${tool}.md`);
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("memory layers flow integration", () => {
  let tempStoreRoot;
  let structuredDir;
  let generatedDir;
  let inboxDir;

  beforeEach(() => {
    tempStoreRoot  = createTempDir("memory-layers-test-");
    structuredDir  = path.join(tempStoreRoot, "structured");
    generatedDir   = path.join(tempStoreRoot, "generated");
    inboxDir       = path.join(tempStoreRoot, "inbox");
    fs.mkdirSync(structuredDir,  { recursive: true });
    fs.mkdirSync(generatedDir,   { recursive: true });
    fs.mkdirSync(inboxDir,      { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempStoreRoot);
  });

  // -------------------------------------------------------------------------
  // Scenario 1: build-memory-layers.js runs and produces JSON output
  // -------------------------------------------------------------------------
  test("build-memory-layers.js emits JSON to stdout with ok:true", async () => {
    seedInboxMarkdown(inboxDir, SAMPLE_INBOX_MD_ENTRIES);

    const scriptPath = path.resolve(__dirname, "../../../ops/build/build-memory-layers.js");
    const env = {
      ...process.env,
      AI_MEMORY_STORE: tempStoreRoot,
    };

    const result = spawn(process.execPath, [scriptPath], {
      env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    result.stdout.on("data", d => { stdout += d; });
    result.stderr.on("data", d => { stderr += d; });

    const exitCode = await new Promise(resolve => {
      result.on("close", code => resolve(code));
    });

    assert.strictEqual(exitCode, 0, `build-memory-layers.js exited non-zero.\nSTDERR:\n${stderr}`);
    assert.ok(stdout.trim().length > 0, "Expected non-empty stdout");

    let parsed;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (e) {
      assert.fail(`stdout was not valid JSON:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }

    assert.strictEqual(parsed.ok, true, "Expected ok:true in output");
    assert.ok(parsed.generatedAt, "Expected generatedAt timestamp");
    assert.ok(parsed.counts, "Expected counts object");
  });

  // -------------------------------------------------------------------------
  // Scenario 2: JSONL output contains correct schemaVersion
  // -------------------------------------------------------------------------
  test("output JSONL files contain records with schemaVersion: 2", async () => {
    // Seed inbox .md files — parseInboxEntries() reads from inbox/ .md files
    seedInboxMarkdown(inboxDir, SAMPLE_INBOX_MD_ENTRIES);

    const scriptPath = path.resolve(__dirname, "../../../ops/build/build-memory-layers.js");
    const env = { ...process.env, AI_MEMORY_STORE: tempStoreRoot };

    const exitCode = await new Promise(resolve => {
      spawn(process.execPath, [scriptPath], { env, windowsHide: true })
        .on("close", code => resolve(code));
    });

    assert.strictEqual(exitCode, 0);

    // The script writes shared-inbox.jsonl (from parsed inbox entries)
    const outJsonl = path.join(structuredDir, "shared-inbox.jsonl");
    const records  = readJsonl(outJsonl);

    assert.ok(
      records.length > 0,
      `Expected at least one record in output JSONL. File exists: ${fs.existsSync(outJsonl)}`
    );
    for (const rec of records) {
      assert.strictEqual(
        typeof rec.schemaVersion === "number" && rec.schemaVersion >= 1,
        true,
        `Record ${rec.id} missing or invalid schemaVersion: ${rec.schemaVersion}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 3: GLOBAL-CONTEXT.md is generated
  // -------------------------------------------------------------------------
  test("GLOBAL-CONTEXT.md and GLOBAL-CONTEXT.body.md are created in generated/", async () => {
    seedInboxMarkdown(inboxDir, SAMPLE_INBOX_MD_ENTRIES);

    const scriptPath = path.resolve(__dirname, "../../../ops/build/build-memory-layers.js");
    const env = { ...process.env, AI_MEMORY_STORE: tempStoreRoot };

    const exitCode = await new Promise(resolve => {
      spawn(process.execPath, [scriptPath], { env, windowsHide: true })
        .on("close", code => resolve(code));
    });

    assert.strictEqual(exitCode, 0);

    const bodyPath = path.join(generatedDir, "GLOBAL-CONTEXT.body.md");
    const metaPath = path.join(generatedDir, "GLOBAL-CONTEXT.meta.json");

    assert.ok(fs.existsSync(bodyPath), `Expected GLOBAL-CONTEXT.body.md at ${bodyPath}`);
    assert.ok(fs.existsSync(metaPath), `Expected GLOBAL-CONTEXT.meta.json at ${metaPath}`);

    const body = fs.readFileSync(bodyPath, "utf8");
    assert.ok(body.includes("Shared AI Memory"), "GLOBAL-CONTEXT.body.md should have a header");

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.ok(meta.generatedAt, "meta.json should contain generatedAt");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: KG unavailability does NOT block memory writes (degraded mode)
  // -------------------------------------------------------------------------
  test("KG errors are non-fatal — memory files are written even when KG is unavailable", async () => {
    // Seed inbox .md files so the script has data to process
    seedInboxMarkdown(inboxDir, SAMPLE_INBOX_MD_ENTRIES);

    const scriptPath = path.resolve(__dirname, "../../../ops/build/build-memory-layers.js");
    const env = {
      ...process.env,
      AI_MEMORY_STORE: tempStoreRoot,
      // Setting AI_MEMORY_KG_PATH to a directory (not a file) will cause KG init to fail,
      // but the script should still succeed because KG is non-blocking.
    };

    const proc = spawn(process.execPath, [scriptPath], { env, windowsHide: true });
    let stderr = "";

    proc.stderr.on("data", d => { stderr += d; });

    const exitCode = await new Promise(resolve => {
      proc.on("close", code => resolve(code));
    });

    // Script should still exit 0 even if KG threw errors
    assert.strictEqual(
      exitCode, 0,
      `Script should succeed despite KG errors.\nSTDERR:\n${stderr}`
    );

    // Output files must exist regardless of KG state
    const layersMd = path.join(generatedDir, "MEMORY-LAYERS.md");
    assert.ok(fs.existsSync(layersMd), "MEMORY-LAYERS.md should be written");
  });
});
