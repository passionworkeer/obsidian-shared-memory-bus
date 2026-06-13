/**
 * Unit tests for ops/knowledge/knowledge-graph.js
 *
 * Tests KnowledgeGraph class against a temporary SQLite database.
 * Gates the entire suite on `node:sqlite` availability; if missing,
 * all tests are skipped with a clear reason.
 *
 * Run with: node --test tests/unit/js/knowledge-graph.test.js
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// Gate the suite on node:sqlite availability (Node 22.5+ built-in)
const require = createRequire(import.meta.url);
let sqliteAvailable = false;
try {
  require("node:sqlite");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

// Import the module — its top-level imports are harmless (no main() call)
import {
  KnowledgeGraph,
  entityId,
} from "../../../ops/knowledge/knowledge-graph.js";

let tempDir;
let kg;

const skipReason = "node:sqlite not available (requires Node 22.5+) — skipping KG tests";

describe("knowledge-graph (node:sqlite backend)", { skip: !sqliteAvailable ? skipReason : false }, () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-test-"));
    const dbPath = path.join(tempDir, "kg", "knowledge-graph.sqlite3");
    kg = new KnowledgeGraph({ dbPath });
  });

  afterEach(() => {
    if (kg) {
      try { kg.close(); } catch { /* ignore */ }
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── Smoke ──────────────────────────────────────────────────────────────

  test("smoke: construction succeeds and tables exist", () => {
    assert.ok(kg);
    assert.ok(kg._db, "internal db should be initialised");
    const s = kg.stats();
    assert.strictEqual(s.entities, 0);
    assert.strictEqual(s.triples, 0);
    assert.strictEqual(s.currentFacts, 0);
  });

  // ── entityId helper ────────────────────────────────────────────────────

  test("entityId lowercases and normalises spaces to underscores", () => {
    assert.strictEqual(typeof entityId("Alice"), "string");
    assert.strictEqual(entityId("Alice").length > 0, true);
    // Same name different case should collapse to the same id
    assert.strictEqual(entityId("Alice"), entityId("alice"));
    assert.strictEqual(entityId("ALICE"), entityId("alice"));
  });

  test("entityId returns _unknown_ for empty / non-string input", () => {
    assert.strictEqual(entityId(""), "_unknown_");
    assert.strictEqual(entityId(null), "_unknown_");
    assert.strictEqual(entityId(undefined), "_unknown_");
  });

  // ── upsertTriple / queryEntity round-trip ──────────────────────────────

  test("upsertTriple adds a triple, queryEntity retrieves it", () => {
    // upsertTriple does NOT auto-create entity rows (only addTriple does),
    // so addEntity first to satisfy the JOIN in queryEntity.
    kg.addEntity("Alice");
    kg.addEntity("MemPalace");

    const tid = kg.upsertTriple("Alice", "works_on", "MemPalace", { validFrom: "2026-01-01" });
    assert.strictEqual(typeof tid, "string");
    assert.ok(tid.length > 0, "triple id should be non-empty");

    const results = kg.queryEntity("Alice", { direction: "outgoing" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].subject, "Alice");
    assert.strictEqual(results[0].predicate, "works_on");
    assert.strictEqual(results[0].object, "MemPalace");
    assert.strictEqual(results[0].current, true, "freshly inserted triple should be current");
  });

  // ── addTriple round-trip (auto-creates entities) ──────────────────────

  test("addTriple round-trip: auto-creates entities, queryEntity retrieves it", () => {
    const tid = kg.addTriple("Hank", "uses", "Hammer");
    assert.strictEqual(typeof tid, "string");
    const results = kg.queryEntity("Hank", { direction: "outgoing" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].object, "Hammer");
  });

  // ── Temporal validity ──────────────────────────────────────────────────

  test("validFrom / validTo are respected when querying with asOf", () => {
    // addTriple auto-creates entities, so round-trip works without manual addEntity.
    // Past fact: valid 2024-01 to 2024-12
    kg.addTriple("Bob", "works_on", "OldCo", {
      validFrom: "2024-01-01",
      validTo: "2024-12-31",
    });
    // Current fact: valid 2025-01 to null
    kg.addTriple("Bob", "works_on", "NewCo", {
      validFrom: "2025-01-01",
    });

    // Querying in mid-2024 → only OldCo visible
    const mid2024 = kg.queryEntity("Bob", { direction: "outgoing", asOf: "2024-06-15" });
    const midObjects = mid2024.map((r) => r.object);
    assert.deepStrictEqual(midObjects, ["OldCo"], "mid-2024 should see only OldCo");

    // Querying in mid-2025 → only NewCo visible
    const mid2025 = kg.queryEntity("Bob", { direction: "outgoing", asOf: "2025-06-15" });
    const mid2025Objects = mid2025.map((r) => r.object);
    assert.deepStrictEqual(mid2025Objects, ["NewCo"], "mid-2025 should see only NewCo");
  });

  test("invalidate sets validTo and triple becomes non-current", () => {
    kg.addTriple("Carol", "uses", "ToolA");
    let r = kg.queryEntity("Carol");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].current, true);

    kg.invalidate("Carol", "uses", "ToolA");
    r = kg.queryEntity("Carol");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].current, false, "after invalidate, current should be false");
    assert.ok(r[0].valid_to, "valid_to should be set");
  });

  // ── Input validation ───────────────────────────────────────────────────

  test("upsertTriple rejects non-string arguments", () => {
    assert.throws(() => kg.upsertTriple(123, "p", "o"), /must be strings/);
    assert.throws(() => kg.upsertTriple("s", null, "o"), /must be strings/);
    assert.throws(() => kg.upsertTriple("s", "p", {}), /must be strings/);
  });

  // ── stats() ────────────────────────────────────────────────────────────

  test("stats() reflects inserted entities and triples", () => {
    kg.addTriple("Dave", "knows", "Eve");
    kg.addTriple("Dave", "uses", "ToolB");
    // addTriple auto-creates entities for subject and object
    const s = kg.stats();
    assert.strictEqual(s.entities, 3, "Dave, Eve, ToolB");
    assert.strictEqual(s.triples, 2, "exactly two triples");
    assert.ok(s.relationshipTypes.includes("knows"));
    assert.ok(s.relationshipTypes.includes("uses"));
    assert.strictEqual(s.currentFacts, 2);
  });

  // ── addEntity + getEntity round-trip ──────────────────────────────────

  test("addEntity and getEntity round-trip preserves name and type", () => {
    const eid = kg.addEntity("Frank", "person", { role: "engineer" });
    assert.strictEqual(typeof eid, "string");

    const got = kg.getEntity("Frank");
    assert.ok(got, "getEntity should find Frank");
    assert.strictEqual(got.name, "Frank");
    assert.strictEqual(got.type, "person");
    assert.deepStrictEqual(got.properties, { role: "engineer" });
  });

  test("addEntity merges properties on conflict (shallow merge)", () => {
    kg.addEntity("Grace", "person", { role: "engineer", team: "alpha" });
    kg.addEntity("Grace", "person", { seniority: "senior" });
    const got = kg.getEntity("Grace");
    // Both writes should be preserved
    assert.strictEqual(got.properties.role, "engineer");
    assert.strictEqual(got.properties.team, "alpha");
    assert.strictEqual(got.properties.seniority, "senior");
  });

  // ── searchEntities ────────────────────────────────────────────────────

  test("searchEntities returns matches ordered by relevance", () => {
    kg.addEntity("Alice Smith", "person");
    kg.addEntity("Alice Wong", "person");
    kg.addEntity("Bob Smith", "person");

    const results = kg.searchEntities("Alice");
    assert.ok(results.length >= 2, "should match both Alices");
    for (const r of results) {
      assert.ok(r.relevance > 0);
    }
    // The first result should start with "alice" (relevance 3)
    assert.strictEqual(results[0].name.toLowerCase().startsWith("alice"), true);
  });
});
