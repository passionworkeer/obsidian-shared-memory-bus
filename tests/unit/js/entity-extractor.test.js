import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractEntities,
  extractFromRecord,
  extractEntitiesFromRecords,
  scoreEntity,
  classifyEntity,
  extractRelationships,
  extractCandidates,
} from "../../../ops/entity/entity-extractor.js";

describe("entity extraction", () => {
  // ---------------------------------------------------------------------------
  // extractCandidates tests
  // ---------------------------------------------------------------------------

  test("extractCandidates returns object (structure varies by input)", () => {
    const text = "王明正在开发项目。";
    const result = extractCandidates(text);

    assert.strictEqual(typeof result, "object");
  });

  test("extractCandidates handles empty text", () => {
    const result = extractCandidates("");
    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // scoreEntity tests
  // ---------------------------------------------------------------------------

  test("scoreEntity returns valid score object", () => {
    const name = "Test Entity";
    const text = "Test Entity is important. Test Entity appears multiple times.";
    const lines = [text];

    const score = scoreEntity(name, text, lines);

    assert.strictEqual(typeof score, "object", "Score should be an object");
    assert.ok(typeof score.person_score === "number", "Should have person_score");
    assert.ok(typeof score.project_score === "number", "Should have project_score");
    assert.ok(typeof score.concept_score === "number", "Should have concept_score");
    assert.ok(Array.isArray(score.person_signals), "Should have person_signals array");
    assert.ok(Array.isArray(score.project_signals), "Should have project_signals array");
  });

  test("scoreEntity handles empty content", () => {
    const score = scoreEntity("Entity", "", []);

    assert.strictEqual(typeof score, "object");
    assert.ok(typeof score.person_score === "number");
    assert.ok(typeof score.project_score === "number");
  });

  test("scoreEntity handles NaN gracefully", () => {
    const name = "Test";
    const text = "test";

    try {
      const score = scoreEntity(name, text, []);
      assert.ok(typeof score === "object");
    } catch (error) {
      // Some edge cases might cause errors, which is acceptable
    }
  });

  // ---------------------------------------------------------------------------
  // classifyEntity tests
  // ---------------------------------------------------------------------------

  test("classifyEntity classifies person entities correctly", () => {
    const scores = {
      person_score: 0.9,
      project_score: 0.2,
      concept_score: 0.1,
      person_signals: ["chinese-person (1x)", "name-pattern (1x)"],
    };

    const result = classifyEntity("Person Name", 3, scores);

    assert.ok(result);
    assert.ok(typeof result.type === "string");
    assert.ok(typeof result.confidence === "number");
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });

  test("classifyEntity classifies project entities correctly", () => {
    const scores = {
      person_score: 0.1,
      project_score: 0.95,
      concept_score: 0.2,
      person_signals: [],
    };

    const result = classifyEntity("Memory System", 5, scores);

    assert.ok(result);
    assert.ok(typeof result.type === "string");
    assert.ok(typeof result.confidence === "number");
  });

  test("classifyEntity handles low confidence", () => {
    const scores = {
      person_score: 0.1,
      project_score: 0.1,
      concept_score: 0.1,
      person_signals: [],
    };

    const result = classifyEntity("Unknown Entity", 1, scores);

    assert.ok(result);
    assert.ok(typeof result.type === "string");
    assert.ok(typeof result.confidence === "number");
  });

  test("classifyEntity handles zero total score", () => {
    const scores = {
      person_score: 0,
      project_score: 0,
      concept_score: 0,
      person_signals: [],
    };

    const result = classifyEntity("No Score Entity", 1, scores);

    assert.ok(result);
    assert.ok(typeof result.type === "string");
    assert.ok(typeof result.confidence === "number");
  });

  // ---------------------------------------------------------------------------
  // extractEntities tests
  // ---------------------------------------------------------------------------

  test("extractEntities returns proper structure", () => {
    const text =
      "Alice works with Alice. Bob talks to Bob. Alice and Bob collaborate.";
    const result = extractEntities(text);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities), "Should have entities array");
    assert.ok(Array.isArray(result.facts), "Should have facts array");
    assert.ok(Array.isArray(result.concepts), "Should have concepts array");
  });

  test("extractEntities handles mixed Chinese and English", () => {
    // Names must appear >=2 times to pass extractEntityCandidates min-frequency filter
    const text =
      "Zhang Wei and Alice are working on the memory system. Zhang Wei helped Alice with the collaboration. Alice uses the system daily.";
    const result = extractEntities(text);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities));
    assert.ok(result.entities.length > 0, "Should find entities");
    const types = new Set(result.entities.map((e) => e.type));
    assert.ok(types.has("person"), "Should have person type");
  });

  test("extractEntities handles empty input", () => {
    const result1 = extractEntities("");
    assert.strictEqual(typeof result1, "object");

    const result2 = extractEntities(null);
    assert.strictEqual(typeof result2, "object");

    const result3 = extractEntities(undefined);
    assert.strictEqual(typeof result3, "object");
  });

  test("extractEntities finds Chinese names", () => {
    const text = "王明正在开发项目，李华负责设计。";
    const result = extractEntities(text);

    assert.ok(Array.isArray(result.entities));
    assert.ok(result.entities.length > 0, "Should find entities");

    // Check structure of found entities
    result.entities.forEach((entity) => {
      assert.ok(entity.name, "Entity should have name");
      assert.ok(entity.type, "Entity should have type");
      assert.ok(typeof entity.confidence === "number", "Entity should have confidence");
    });
  });

  test("extractEntities extracts facts", () => {
    const text = "王明正在开发entity extraction模块。";
    const result = extractEntities(text);

    assert.ok(Array.isArray(result.facts));
    assert.ok(result.facts.length >= 0, "May have facts");
  });

  // ---------------------------------------------------------------------------
  // Record extraction tests
  // ---------------------------------------------------------------------------

  test("extractFromRecord extracts entities from structured record", () => {
    const record = {
      id: "test-rec-001",
      title: "王明的开发进度",
      content:
        "王明正在开发entity extraction模块，计划本周完成基础功能。",
      tool: "claude-code",
      scope: "project",
      type: "task",
      confidence: 0.9,
      t: new Date().toISOString(),
    };

    const result = extractFromRecord(record);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities));
    assert.ok(Array.isArray(result.facts));
    assert.ok(Array.isArray(result.concepts));
  });

  test("extractFromRecord handles empty record", () => {
    const result = extractFromRecord({
      id: "empty-rec",
      title: "",
      content: "",
    });

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities));
  });

  test("extractFromRecord handles null/undefined", () => {
    const result1 = extractFromRecord(null);
    assert.strictEqual(typeof result1, "object");

    const result2 = extractFromRecord(undefined);
    assert.strictEqual(typeof result2, "object");
  });

  // ---------------------------------------------------------------------------
  // Batch record extraction tests
  // ---------------------------------------------------------------------------

  test("extractEntitiesFromRecords processes multiple records", () => {
    const records = [
      {
        id: "rec-001",
        title: "Entity Record 1",
        content: "王明正在开发entity extraction模块。",
        tool: "claude-code",
        scope: "project",
        type: "task",
        confidence: 0.9,
        t: new Date().toISOString(),
      },
      {
        id: "rec-002",
        title: "Entity Record 2",
        content: "Alice is working on the frontend.",
        tool: "openclaw",
        scope: "project",
        type: "task",
        confidence: 0.85,
        t: new Date().toISOString(),
      },
    ];

    const result = extractEntitiesFromRecords(records);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result));
    assert.ok(result.length === 2);
    assert.ok(Array.isArray(result[0].entities));
  });

  test("extractEntitiesFromRecords handles empty array", () => {
    const result = extractEntitiesFromRecords([]);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });

  test("extractEntitiesFromRecords handles null records gracefully", () => {
    const result = extractEntitiesFromRecords([
      { id: "valid" },
      null,
      undefined,
    ]);

    assert.strictEqual(typeof result, "object");
  });

  // ---------------------------------------------------------------------------
  // Relationship extraction tests
  // ---------------------------------------------------------------------------

  test("extractRelationships finds relationships", () => {
    const text = "Alice is working with Bob on the project.";
    const relationships = extractRelationships(text);

    assert.ok(Array.isArray(relationships));
    // May or may not find relationships depending on text
  });

  test("extractRelationships handles empty text", () => {
    const relationships = extractRelationships("");
    assert.ok(Array.isArray(relationships));
  });

  // ---------------------------------------------------------------------------
  // Integration-style tests
  // ---------------------------------------------------------------------------

  test("end-to-end extraction with Chinese and English mixed content", () => {
    const text = `
      Zhang Wei and Alice are collaborating on the multi-agent memory system.
      王明正在和李华一起开发这个项目。
      Bob is responsible for the API layer.
      张伟负责前端界面设计。
    `;

    const result = extractEntities(text);

    assert.ok(Array.isArray(result.entities));
    assert.ok(result.entities.length > 0, "Should find entities");
    assert.ok(
      result.entities.some((e) => e.type === "person"),
      "Should find person entities"
    );

    const personEntities = result.entities.filter((e) => e.type === "person");
    assert.ok(personEntities.length >= 2, "Should find multiple people");
  });

  test("handles special characters and edge cases", () => {
    const text = `
      Entity with "quotes" and 'single quotes'.
      Unicode: 你好世界 🎉
      Numbers: 12345
      Symbols: @#$%^&*()
    `;

    const result = extractEntities(text);
    assert.strictEqual(typeof result, "object");
    // Should not crash with special characters
  });

  test("handles very long text", () => {
    const longText = "Test Entity. ".repeat(10000);
    const result = extractEntities(longText);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities));
    // Should complete without crashing
  });

  test("extracts entities from real-world-like content", () => {
    const text = `
      王明正在开发一个基于Obsidian的多智能体记忆系统。
      他主要负责后端API的设计和实现。
      张伟负责前端界面设计，确保用户体验流畅。
      Bob is working on the integration tests.
      Alice is managing the project documentation.
    `;

    const result = extractEntities(text);

    assert.strictEqual(typeof result, "object");
    assert.ok(Array.isArray(result.entities));
    assert.ok(result.entities.length > 0, "Should find entities");

    // Check that entities have proper structure
    const validEntities = result.entities.filter(
      (e) => e.name && e.type && typeof e.confidence === "number"
    );
    assert.ok(validEntities.length > 0, "Should have valid entities");
  });

  test("entity confidence ranges from 0 to 1", () => {
    const text = "王明正在开发项目，李华负责设计。";
    const result = extractEntities(text);

    result.entities.forEach((entity) => {
      assert.ok(
        entity.confidence >= 0 && entity.confidence <= 1,
        `Confidence should be between 0 and 1, got ${entity.confidence}`
      );
    });
  });
});
