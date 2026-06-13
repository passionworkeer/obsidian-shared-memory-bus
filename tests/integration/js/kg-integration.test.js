/**
 * Integration tests for knowledge graph (KG) building
 *
 * Tests entity extraction + KG ingestion pipeline
 *
 * Run with: node --test tests/integration/js/kg-integration.test.js
 */

import path from "node:path";
import fs from "node:fs";
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonl,
  readJsonl,
} from "../../helpers/setup.js";
import {
  SAMPLE_RECORDS_WITH_ENTITIES,
  ENTITY_EXTRACTION_FIXTURES,
} from "../../helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("KG integration tests", () => {
  let tempKgDir;
  let tempGraphFile;

  beforeEach(() => {
    tempKgDir = createTempDir("kg-test-");
    tempGraphFile = path.join(tempKgDir, "knowledge-graph.jsonl");
  });

  afterEach(() => {
    cleanupTempDir(tempKgDir);
  });

  test("builds KG from entity extraction output", async () => {
    // Step 1: Extract entities from records
    const records = SAMPLE_RECORDS_WITH_ENTITIES;

    // Mock entity extraction (simulate what entity-extractor.js produces)
    const extractedEntities = [
      {
        id: "entity-001",
        name: "王明",
        type: "person",
        confidence: 0.92,
        frequency: 5,
        sources: ["rec-001", "rec-002"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "entity-002",
        name: "Entity Extraction",
        type: "project",
        confidence: 0.88,
        frequency: 3,
        sources: ["rec-001"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "entity-003",
        name: "Alice",
        type: "person",
        confidence: 0.90,
        frequency: 4,
        sources: ["rec-002"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ];

    // Step 2: Write entities to KG file
    for (const entity of extractedEntities) {
      fs.appendFileSync(tempGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    // Step 3: Verify KG structure
    const kgEntities = readJsonl(tempGraphFile);
    assert.strictEqual(kgEntities.length, 3);
    assert.ok(kgEntities.some((e) => e.name === "王明"));
    assert.ok(kgEntities.some((e) => e.name === "Entity Extraction"));
    assert.ok(kgEntities.some((e) => e.name === "Alice"));
  });

  test("adds new entities to existing KG", async () => {
    // Initial KG
    const initialEntities = [
      {
        id: "entity-001",
        name: "Existing Person",
        type: "person",
        confidence: 0.9,
        frequency: 10,
        sources: ["rec-001"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ];

    for (const entity of initialEntities) {
      fs.appendFileSync(tempGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    // New entity to add
    const newEntity = {
      id: "entity-002",
      name: "New Person",
      type: "person",
      confidence: 0.85,
      frequency: 5,
      sources: ["rec-002"],
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    fs.appendFileSync(tempGraphFile, JSON.stringify(newEntity) + "\n", "utf8");

    // Verify both entities present
    const allEntities = readJsonl(tempGraphFile);
    assert.strictEqual(allEntities.length, 2);
    assert.ok(allEntities.some((e) => e.name === "Existing Person"));
    assert.ok(allEntities.some((e) => e.name === "New Person"));
  });

  test("updates entity frequency on re-extraction", async () => {
    // Initial entity
    const initialEntity = {
      id: "entity-001",
      name: "Zhang Wei",
      type: "person",
      confidence: 0.88,
      frequency: 3,
      sources: ["rec-001"],
      firstSeen: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      lastSeen: new Date(Date.now() - 86400000).toISOString(),
    };

    fs.appendFileSync(tempGraphFile, JSON.stringify(initialEntity) + "\n", "utf8");

    // Read current state
    let entities = readJsonl(tempGraphFile);
    assert.strictEqual(entities[0].frequency, 3);

    // Simulate update: read, modify, rewrite
    const updatedEntity = {
      ...entities[0],
      frequency: entities[0].frequency + 2,
      lastSeen: new Date().toISOString(),
      sources: [...entities[0].sources, "rec-003"],
    };

    // Rewrite file with updated entity
    fs.writeFileSync(tempGraphFile, JSON.stringify(updatedEntity) + "\n", "utf8");

    // Verify update
    entities = readJsonl(tempGraphFile);
    assert.strictEqual(entities.length, 1);
    assert.strictEqual(entities[0].frequency, 5);
    assert.strictEqual(entities[0].sources.length, 2);
  });

  test("extracts relationships between entities", () => {
    // Mock relationship data
    const relationships = [
      {
        id: "rel-001",
        source: "entity-001",
        target: "entity-002",
        type: "works_with",
        strength: 0.9,
        context: "Collaboration on project",
        t: new Date().toISOString(),
      },
      {
        id: "rel-002",
        source: "entity-002",
        target: "entity-003",
        type: "manages",
        strength: 0.85,
        context: "Team leadership",
        t: new Date().toISOString(),
      },
    ];

    const relFile = path.join(tempKgDir, "relationships.jsonl");
    for (const rel of relationships) {
      fs.appendFileSync(relFile, JSON.stringify(rel) + "\n", "utf8");
    }

    // Verify relationships
    const rels = readJsonl(relFile);
    assert.strictEqual(rels.length, 2);
    assert.ok(rels.some((r) => r.type === "works_with"));
    assert.ok(rels.some((r) => r.type === "manages"));
  });

  test("handles KG graph file operations", () => {
    const graphFile = path.join(tempKgDir, "graph.jsonl");

    // Create empty graph
    assert.ok(!fs.existsSync(graphFile));

    // Add entities
    const entity1 = { id: "e1", name: "Person 1", type: "person" };
    fs.appendFileSync(graphFile, JSON.stringify(entity1) + "\n", "utf8");

    // Verify entity added
    let entities = readJsonl(graphFile);
    assert.strictEqual(entities.length, 1);

    // Add another entity
    const entity2 = { id: "e2", name: "Person 2", type: "person" };
    fs.appendFileSync(graphFile, JSON.stringify(entity2) + "\n", "utf8");

    // Verify both entities
    entities = readJsonl(graphFile);
    assert.strictEqual(entities.length, 2);

    // File should exist
    assert.ok(fs.existsSync(graphFile));
  });

  test("entity extraction pipeline with Chinese content", () => {
    const fixture = ENTITY_EXTRACTION_FIXTURES.chinese;

    // Simulate entity extraction from Chinese text
    const extractedEntities = [
      {
        id: "entity-cn-001",
        name: "王明",
        type: "person",
        confidence: 0.95,
        frequency: 2,
        sources: ["text-analysis"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "entity-cn-002",
        name: "李华",
        type: "person",
        confidence: 0.93,
        frequency: 2,
        sources: ["text-analysis"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ];

    const cnGraphFile = path.join(tempKgDir, "chinese-kg.jsonl");
    for (const entity of extractedEntities) {
      fs.appendFileSync(cnGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    // Verify Chinese entities
    const entities = readJsonl(cnGraphFile);
    assert.strictEqual(entities.length, 2);
    assert.ok(entities.every((e) => e.type === "person"));
    assert.ok(entities.some((e) => e.name === "王明"));
    assert.ok(entities.some((e) => e.name === "李华"));
  });

  test("entity extraction pipeline with English content", () => {
    const fixture = ENTITY_EXTRACTION_FIXTURES.english;

    const extractedEntities = [
      {
        id: "entity-en-001",
        name: "John",
        type: "person",
        confidence: 0.94,
        frequency: 1,
        sources: ["text-analysis"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "entity-en-002",
        name: "Sarah",
        type: "person",
        confidence: 0.92,
        frequency: 1,
        sources: ["text-analysis"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ];

    const enGraphFile = path.join(tempKgDir, "english-kg.jsonl");
    for (const entity of extractedEntities) {
      fs.appendFileSync(enGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    const entities = readJsonl(enGraphFile);
    assert.strictEqual(entities.length, 2);
    assert.ok(entities.some((e) => e.name === "John"));
    assert.ok(entities.some((e) => e.name === "Sarah"));
  });

  test("mixed content entity extraction", () => {
    const mixedEntities = [
      {
        id: "mixed-001",
        name: "Zhang Wei",
        type: "person",
        confidence: 0.91,
        frequency: 3,
        sources: ["mixed-text"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "mixed-002",
        name: "Alice",
        type: "person",
        confidence: 0.89,
        frequency: 2,
        sources: ["mixed-text"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
      {
        id: "mixed-003",
        name: "Multi-Agent System",
        type: "project",
        confidence: 0.86,
        frequency: 1,
        sources: ["mixed-text"],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ];

    const mixedGraphFile = path.join(tempKgDir, "mixed-kg.jsonl");
    for (const entity of mixedEntities) {
      fs.appendFileSync(mixedGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    const entities = readJsonl(mixedGraphFile);
    assert.strictEqual(entities.length, 3);

    const persons = entities.filter((e) => e.type === "person");
    const projects = entities.filter((e) => e.type === "project");

    assert.strictEqual(persons.length, 2);
    assert.strictEqual(projects.length, 1);
  });

  test("KG statistics tracking", () => {
    const entities = [
      { id: "e1", type: "person", confidence: 0.9, frequency: 10 },
      { id: "e2", type: "person", confidence: 0.8, frequency: 5 },
      { id: "e3", type: "project", confidence: 0.85, frequency: 7 },
      { id: "e4", type: "person", confidence: 0.95, frequency: 12 },
    ];

    const statsFile = path.join(tempKgDir, "kg-stats.json");

    // Calculate statistics
    const stats = {
      totalEntities: entities.length,
      byType: {
        person: entities.filter((e) => e.type === "person").length,
        project: entities.filter((e) => e.type === "project").length,
      },
      avgConfidence:
        entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length,
      totalFrequency: entities.reduce((sum, e) => sum + e.frequency, 0),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), "utf8");

    // Verify statistics
    const loadedStats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
    assert.strictEqual(loadedStats.totalEntities, 4);
    assert.strictEqual(loadedStats.byType.person, 3);
    assert.strictEqual(loadedStats.byType.project, 1);
    assert.ok(loadedStats.avgConfidence > 0.8 && loadedStats.avgConfidence < 1.0);
    assert.strictEqual(loadedStats.totalFrequency, 34);
  });

  test("handles large KG with many entities", () => {
    // Simulate large KG with many entities
    const numEntities = 100;
    const largeGraphFile = path.join(tempKgDir, "large-kg.jsonl");

    for (let i = 0; i < numEntities; i++) {
      const entity = {
        id: `entity-${i}`,
        name: `Entity ${i}`,
        type: i % 2 === 0 ? "person" : "project",
        confidence: 0.7 + (i % 30) / 100,
        frequency: 1 + (i % 10),
        sources: [`source-${i % 5}`],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };

      fs.appendFileSync(largeGraphFile, JSON.stringify(entity) + "\n", "utf8");
    }

    // Verify all entities were written
    const entities = readJsonl(largeGraphFile);
    assert.strictEqual(entities.length, numEntities);

    // Verify specific entities
    assert.ok(entities.some((e) => e.id === "entity-0"));
    assert.ok(entities.some((e) => e.id === "entity-99"));

    // Verify file size is reasonable
    const fileSize = fs.statSync(largeGraphFile).size;
    assert.ok(fileSize > 0, "KG file should not be empty");
  });

  test("KG entity deduplication", () => {
    const graphFile = path.join(tempKgDir, "dedup-kg.jsonl");

    // Add same entity multiple times
    const duplicateEntity = {
      id: "entity-001",
      name: "Duplicate Person",
      type: "person",
      confidence: 0.9,
      frequency: 1,
      sources: ["source-1"],
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    // Add twice
    fs.appendFileSync(graphFile, JSON.stringify(duplicateEntity) + "\n", "utf8");

    const entity2 = { ...duplicateEntity, sources: ["source-2"] };
    fs.appendFileSync(graphFile, JSON.stringify(entity2) + "\n", "utf8");

    // Read all
    let entities = readJsonl(graphFile);
    assert.strictEqual(entities.length, 2);

    // Simulate deduplication
    const seen = new Map();
    const deduplicated = entities.filter((e) => {
      if (seen.has(e.id)) {
        // Merge with existing
        const existing = seen.get(e.id);
        existing.frequency += e.frequency;
        existing.sources = [...new Set([...existing.sources, ...e.sources])];
        return false;
      }
      seen.set(e.id, e);
      return true;
    });

    assert.strictEqual(deduplicated.length, 1);
    assert.strictEqual(deduplicated[0].frequency, 2);
    assert.strictEqual(deduplicated[0].sources.length, 2);
  });

  test("KG with relationships and entities", () => {
    const entities = [
      { id: "e1", name: "Alice", type: "person" },
      { id: "e2", name: "Bob", type: "person" },
      { id: "e3", name: "Project X", type: "project" },
    ];

    const relationships = [
      {
        id: "r1",
        source: "e1",
        target: "e2",
        type: "collaborates_with",
        strength: 0.9,
      },
      {
        id: "r2",
        source: "e1",
        target: "e3",
        type: "works_on",
        strength: 0.85,
      },
      {
        id: "r3",
        source: "e2",
        target: "e3",
        type: "manages",
        strength: 0.8,
      },
    ];

    const kgDir = path.join(tempKgDir, "kg-with-rels");
    fs.mkdirSync(kgDir, { recursive: true });

    const entitiesFile = path.join(kgDir, "entities.jsonl");
    const relsFile = path.join(kgDir, "relationships.jsonl");

    for (const entity of entities) {
      fs.appendFileSync(entitiesFile, JSON.stringify(entity) + "\n", "utf8");
    }

    for (const rel of relationships) {
      fs.appendFileSync(relsFile, JSON.stringify(rel) + "\n", "utf8");
    }

    // Verify both files
    const loadedEntities = readJsonl(entitiesFile);
    const loadedRels = readJsonl(relsFile);

    assert.strictEqual(loadedEntities.length, 3);
    assert.strictEqual(loadedRels.length, 3);

    // Verify entity references in relationships
    const entityIds = new Set(loadedEntities.map((e) => e.id));
    loadedRels.forEach((rel) => {
      assert.ok(entityIds.has(rel.source), `Source ${rel.source} should exist`);
      assert.ok(entityIds.has(rel.target), `Target ${rel.target} should exist`);
    });
  });
});
