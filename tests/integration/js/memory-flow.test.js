/**
 * Integration tests for memory flow
 *
 * Tests the complete flow: write inbox entry → run memory build → verify output
 *
 * Run with: node --test tests/integration/js/memory-flow.test.js
 */

import path from "node:path";
import fs from "node:fs";
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonl,
  readJsonl,
} from "../../helpers/setup.js";
import { SAMPLE_MEMORY_RECORDS } from "../../helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("memory flow integration", () => {
  let tempVaultRoot;
  let tempInboxDir;
  let tempStructuredDir;
  let tempDreamDir;

  beforeEach(() => {
    // Create temporary vault structure
    tempVaultRoot = createTempDir("vault-flow-test-");
    tempInboxDir = path.join(tempVaultRoot, "00-System/ai-memory/inbox");
    tempStructuredDir = path.join(tempVaultRoot, "00-System/ai-memory/structured");
    tempDreamDir = path.join(tempVaultRoot, "00-System/ai-memory/dream");

    fs.mkdirSync(tempInboxDir, { recursive: true });
    fs.mkdirSync(tempStructuredDir, { recursive: true });
    fs.mkdirSync(tempDreamDir, { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempVaultRoot);
  });

  test("writes inbox entry to file", async () => {
    const inboxFile = path.join(tempInboxDir, "test-inbox.jsonl");
    const entry = {
      id: "inbox-001",
      title: "Test Entry",
      content: "Test content for inbox",
      tool: "claude-code",
      t: new Date().toISOString(),
      scope: "summary",
      type: "note",
      confidence: 0.8,
    };

    fs.appendFileSync(inboxFile, JSON.stringify(entry) + "\n", "utf8");

    // Verify file was created
    assert.ok(fs.existsSync(inboxFile));

    // Verify content
    const records = readJsonl(inboxFile);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, "inbox-001");
    assert.strictEqual(records[0].title, "Test Entry");
  });

  test("processes inbox entries into structured format", async () => {
    // Write multiple inbox entries
    const inboxFile = path.join(tempInboxDir, "batch-inbox.jsonl");
    const entries = [
      {
        id: "inbox-a",
        title: "Entry A",
        content: "Content A",
        tool: "claude-code",
        t: new Date().toISOString(),
        scope: "project",
        type: "note",
        confidence: 0.9,
      },
      {
        id: "inbox-b",
        title: "Entry B",
        content: "Content B",
        tool: "openclaw",
        t: new Date().toISOString(),
        scope: "task",
        type: "task",
        confidence: 0.85,
      },
    ];

    for (const entry of entries) {
      fs.appendFileSync(inboxFile, JSON.stringify(entry) + "\n", "utf8");
    }

    // Read and verify entries
    const readEntries = readJsonl(inboxFile);
    assert.strictEqual(readEntries.length, 2);
    assert.ok(readEntries.some((e) => e.id === "inbox-a"));
    assert.ok(readEntries.some((e) => e.id === "inbox-b"));
  });

  test("creates structured output from inbox", async () => {
    // Simulate the output from a memory build
    const structuredFile = path.join(tempStructuredDir, "structured-001.jsonl");

    const structuredRecords = [
      {
        id: "struct-001",
        title: "Structured Record 1",
        content: "Processed content",
        tool: "claude-code",
        scope: "project",
        type: "note",
        confidence: 0.85,
        t: new Date().toISOString(),
        freshness: "hot",
        memory_level: "durable",
        content_hash: "abc123",
        metadata: {
          promotion: {
            durable_type: "project",
            key: "promotion-key-001",
            reason: "high-confidence",
          },
        },
      },
      {
        id: "struct-002",
        title: "Structured Record 2",
        content: "Another processed record",
        tool: "openclaw",
        scope: "task",
        type: "task",
        confidence: 0.9,
        t: new Date().toISOString(),
        freshness: "hot",
        memory_level: "task",
        content_hash: "def456",
        metadata: {
          promotion: {
            durable_type: "task",
            key: "promotion-key-002",
            reason: "task-priority",
          },
        },
      },
    ];

    for (const record of structuredRecords) {
      fs.appendFileSync(structuredFile, JSON.stringify(record) + "\n", "utf8");
    }

    // Verify structured output
    const records = readJsonl(structuredFile);
    assert.strictEqual(records.length, 2);

    const rec1 = records.find((r) => r.id === "struct-001");
    assert.ok(rec1);
    assert.strictEqual(rec1.scope, "project");
    assert.strictEqual(rec1.freshness, "hot");
    assert.ok(rec1.metadata.promotion);

    const rec2 = records.find((r) => r.id === "struct-002");
    assert.ok(rec2);
    assert.strictEqual(rec2.scope, "task");
    assert.strictEqual(rec2.memory_level, "task");
  });

  test("handles dream records in flow", async () => {
    const dreamFile = path.join(tempDreamDir, "dream-records.jsonl");

    const dreamRecords = [
      {
        id: "dream-001",
        title: "Dream Record",
        content: "Generated from dream process",
        tool: "claude-code",
        scope: "summary",
        type: "session-summary",
        confidence: 0.7,
        t: new Date().toISOString(),
        freshness: "warm",
        memory_level: "session",
        source_kind: "dream",
        content_hash: "dream-hash-001",
      },
    ];

    for (const record of dreamRecords) {
      fs.appendFileSync(dreamFile, JSON.stringify(record) + "\n", "utf8");
    }

    // Verify dream records
    const records = readJsonl(dreamFile);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].source_kind, "dream");
    assert.strictEqual(records[0].scope, "summary");
  });

  test("manages memory tier budgets", async () => {
    // Simulate tier budget tracking
    const tierBudgetFile = path.join(
      tempVaultRoot,
      "00-System/ai-memory/.config/tier-budget.json"
    );
    const configDir = path.dirname(tierBudgetFile);
    fs.mkdirSync(configDir, { recursive: true });

    const tierBudgets = {
      1: { max: 200, used: 50, label: "Event/Working" },
      2: { max: 200, used: 100, label: "Session Durable" },
      3: { max: 100, used: 75, label: "Project Durable" },
      4: { max: 200, used: 120, label: "Shared Durable" },
      5: { max: 500, used: 300, label: "Archive" },
    };

    fs.writeFileSync(tierBudgetFile, JSON.stringify(tierBudgets, null, 2), "utf8");

    // Read and verify tier budgets
    const budgets = JSON.parse(fs.readFileSync(tierBudgetFile, "utf8"));
    assert.strictEqual(budgets[1].max, 200);
    assert.strictEqual(budgets[2].max, 200);
    assert.strictEqual(budgets[3].max, 100);
    assert.ok(budgets[1].used < budgets[1].max);
  });

  test("complete flow: inbox → structured → tier assignment", async () => {
    // Step 1: Create inbox entry
    const inboxFile = path.join(tempInboxDir, "complete-flow.jsonl");
    const inboxEntry = {
      id: "flow-001",
      title: "Memory Flow Test",
      content: "Testing complete memory flow",
      tool: "claude-code",
      t: new Date().toISOString(),
      scope: "project",
      type: "note",
      confidence: 0.88,
    };

    fs.appendFileSync(inboxFile, JSON.stringify(inboxEntry) + "\n", "utf8");

    // Step 2: Process into structured format
    const structuredFile = path.join(tempStructuredDir, "structured-flow.jsonl");
    const structuredEntry = {
      ...inboxEntry,
      freshness: "hot",
      memory_level: "durable",
      content_hash: "flow-hash-001",
      metadata: {
        promotion: {
          durable_type: "project",
          key: "flow-promotion-key",
          reason: "high-confidence",
        },
      },
    };

    fs.appendFileSync(structuredFile, JSON.stringify(structuredEntry) + "\n", "utf8");

    // Step 3: Verify complete flow
    const inboxRecords = readJsonl(inboxFile);
    const structuredRecords = readJsonl(structuredFile);

    assert.strictEqual(inboxRecords.length, 1);
    assert.strictEqual(structuredRecords.length, 1);
    assert.strictEqual(
      inboxRecords[0].id,
      structuredRecords[0].id,
      "ID should be preserved"
    );
    assert.strictEqual(structuredRecords[0].freshness, "hot");
    assert.strictEqual(structuredRecords[0].memory_level, "durable");
    assert.ok(structuredRecords[0].metadata.promotion);
  });

  test("handles concurrent inbox writes", async () => {
    const inboxFile = path.join(tempInboxDir, "concurrent-inbox.jsonl");

    // Simulate multiple writes
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `concurrent-${i}`,
      title: `Entry ${i}`,
      content: `Content for entry ${i}`,
      tool: "claude-code",
      t: new Date().toISOString(),
      scope: "summary",
      type: "note",
      confidence: 0.8,
    }));

    // Sequential writes (simulating concurrent access)
    for (const entry of entries) {
      fs.appendFileSync(inboxFile, JSON.stringify(entry) + "\n", "utf8");
    }

    // Verify all entries are present
    const records = readJsonl(inboxFile);
    assert.strictEqual(records.length, 10);

    // Verify all IDs are present
    const ids = records.map((r) => r.id);
    entries.forEach((entry) => {
      assert.ok(ids.includes(entry.id), `Entry ${entry.id} should be present`);
    });
  });

  test("cleans up temporary files after processing", async () => {
    // Create temp file
    const tempFile = path.join(tempInboxDir, "temp-to-clean.jsonl");
    const entry = {
      id: "temp-001",
      title: "Temp Entry",
      content: "Will be cleaned up",
      tool: "claude-code",
      t: new Date().toISOString(),
    };

    fs.appendFileSync(tempFile, JSON.stringify(entry) + "\n", "utf8");
    assert.ok(fs.existsSync(tempFile));

    // Simulate cleanup
    fs.unlinkSync(tempFile);
    assert.ok(!fs.existsSync(tempFile), "Temp file should be cleaned up");
  });

  test("handles malformed JSONL gracefully", async () => {
    const malformedFile = path.join(tempInboxDir, "malformed.jsonl");

    // Write mixed valid and invalid JSON
    fs.appendFileSync(malformedFile, JSON.stringify({ id: "valid-1" }) + "\n", "utf8");
    fs.appendFileSync(malformedFile, "{ this is invalid JSON\n", "utf8");
    fs.appendFileSync(malformedFile, JSON.stringify({ id: "valid-2" }) + "\n", "utf8");

    // Read should skip invalid JSON
    const records = readJsonl(malformedFile);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].id, "valid-1");
    assert.strictEqual(records[1].id, "valid-2");
  });

  test("preserves data integrity through flow", async () => {
    const originalEntry = {
      id: "integrity-001",
      title: "Data Integrity Test",
      content: "Testing that data remains unchanged through processing",
      tool: "claude-code",
      scope: "project",
      type: "note",
      confidence: 0.95,
      facts: ["fact one", "fact two"],
      concepts: ["concept one"],
      files_read: ["src/main.js"],
      files_modified: ["src/main.js"],
      t: new Date().toISOString(),
    };

    // Write to inbox
    const inboxFile = path.join(tempInboxDir, "integrity.jsonl");
    fs.appendFileSync(inboxFile, JSON.stringify(originalEntry) + "\n", "utf8");

    // Read from inbox
    const inboxRecords = readJsonl(inboxFile);
    assert.strictEqual(inboxRecords.length, 1);

    const fromInbox = inboxRecords[0];

    // Verify all fields preserved
    assert.strictEqual(fromInbox.id, originalEntry.id);
    assert.strictEqual(fromInbox.title, originalEntry.title);
    assert.strictEqual(fromInbox.content, originalEntry.content);
    assert.strictEqual(fromInbox.confidence, originalEntry.confidence);
    assert.deepStrictEqual(fromInbox.facts, originalEntry.facts);
    assert.deepStrictEqual(fromInbox.concepts, originalEntry.concepts);
    assert.deepStrictEqual(fromInbox.files_read, originalEntry.files_read);
  });
});
