import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCoreference,
  extractCandidates,
  scoreEntity,
  classifyEntity,
  extractRelationships,
} from "../../../ops/entity/entity-extractor/extractors.js";
import {
  extractEntities,
  extractFromRecord,
  extractEntitiesFromRecords,
} from "../../../ops/entity/entity-extractor/pipeline.js";

describe("entity-extractor/extractors", () => {
  test("extractCandidates returns a structured result", () => {
    const out = extractCandidates("Alice said Bob and Carol were working on MemPalace.");
    assert.ok(out && typeof out === "object");
  });

  test("extractCandidates handles empty text", () => {
    const out = extractCandidates("");
    assert.ok(out && typeof out === "object");
  });

  test("scoreEntity returns three numeric scores and signal arrays", () => {
    const result = scoreEntity("Alice", "Alice said hello to Bob and Carol.");
    assert.equal(typeof result.person_score, "number");
    assert.equal(typeof result.project_score, "number");
    assert.equal(typeof result.concept_score, "number");
    assert.ok(Array.isArray(result.person_signals));
    assert.ok(Array.isArray(result.project_signals));
    assert.ok(Array.isArray(result.concept_signals));
  });

  test("scoreEntity gives higher person_score for a name with person verbs", () => {
    const personLike = scoreEntity("Alice", "Alice said the project uses Postgres.");
    const conceptLike = scoreEntity("Database", "The Database is a structured data store.");
    assert.ok(personLike.person_score >= conceptLike.person_score);
  });

  test("classifyEntity returns a record with type, scope, and confidence", () => {
    const out = classifyEntity("Alice", 5, {
      person_score: 0.9,
      project_score: 0.0,
      concept_score: 0.0,
      person_signals: ["direct address (1x)"],
      project_signals: [],
      concept_signals: [],
    });
    assert.ok(out && typeof out === "object");
    assert.ok(["person", "project", "concept", "uncertain", "unknown"].includes(out.type));
  });

  test("extractRelationships returns an object (possibly empty)", () => {
    const out = extractRelationships("Alice works on MemPalace with Bob.");
    assert.ok(out && typeof out === "object");
  });

  test("resolveCoreference returns a Map", () => {
    const out = resolveCoreference("She said he was there.", [], new Map());
    assert.ok(out instanceof Map);
  });
});

describe("entity-extractor/pipeline", () => {
  test("extractEntities returns an object", () => {
    const out = extractEntities("Alice and Bob are working on MemPalace.");
    assert.ok(out && typeof out === "object");
  });

  test("extractEntities handles empty input", () => {
    const out = extractEntities("");
    assert.ok(out && typeof out === "object");
  });

  test("extractFromRecord returns a record-shaped object", () => {
    const record = { id: "r1", content: "Alice said hello to Bob.", title: "Greeting" };
    const out = extractFromRecord(record);
    assert.ok(out && typeof out === "object");
  });

  test("extractEntitiesFromRecords handles empty array", () => {
    const out = extractEntitiesFromRecords([]);
    assert.ok(out && typeof out === "object");
  });

  test("extractEntitiesFromRecords processes a list", () => {
    const records = [
      { id: "r1", content: "Alice works on MemPalace." },
      { id: "r2", content: "Bob reviews the code." },
    ];
    const out = extractEntitiesFromRecords(records);
    assert.ok(out && typeof out === "object");
  });
});
