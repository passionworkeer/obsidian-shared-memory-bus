// ops/entity/entity-extractor/pipeline.js
//
// High-level extraction pipeline: orchestrates candidate extraction,
// classification, relationship triple extraction, coreference resolution,
// and deduplication. Also provides the CLI entry point used when this
// module is executed directly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyEntity,
  extractCandidates,
  extractRelationships,
  resolveCoreference,
  scoreEntity,
} from "./extractors.js";

const __filename = fileURLToPath(import.meta.url);

/**
 * Extract entities + relationships from raw text.
 *
 * @param {string} text
 * @returns {{ entities: object[], facts: object[], concepts: object[] }}
 */
export function extractEntities(text) {
  if (!text || text.trim().length < 10) {
    return { entities: [], facts: [], concepts: [] };
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  const lines = normalized.split(/\n/);
  const candidates = extractCandidates(normalized);

  if (candidates.size === 0) {
    return { entities: [], facts: [], concepts: [] };
  }

  /** @type {object[]} */
  const entities = [];
  /** @type {object[]} */
  const facts = [];
  /** @type {object[]} */
  const concepts = [];

  // Sort by frequency descending
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);

  for (const [name, frequency] of sorted) {
    const scores = scoreEntity(name, normalized, lines);
    const classified = classifyEntity(name, frequency, scores);

    entities.push({
      name: classified.name,
      type: classified.type,
      confidence: classified.confidence,
      frequency: classified.frequency,
      signals: classified.signals,
    });

    // Generate facts for high-confidence persons/projects
    if (classified.confidence >= 0.6 && classified.type !== "uncertain") {
      facts.push({
        value: `${classified.name} is a ${classified.type}`,
        entity_type: classified.type,
        confidence: classified.confidence,
      });
    }
  }

  // Extract relationship triples
  const triples = extractRelationships(normalized);
  for (const triple of triples) {
    facts.push({
      value: `${triple.subject} → ${triple.predicate} → ${triple.object}`,
      predicate: triple.predicate,
      subject: triple.subject,
      object: triple.object,
      confidence: triple.confidence,
    });
  }

  // Resolve coreferences: map pronouns to canonical names
  const sentences = normalized.split(/[.。!！?]/).filter(s => s.trim().length > 5);
  const corefMap = resolveCoreference(normalized, sentences, candidates);
  if (corefMap.size > 0) {
    // For each pronoun found in facts, replace with canonical name
    for (const triple of triples) {
      if (corefMap.has(triple.subject)) triple.subject = corefMap.get(triple.subject);
      if (corefMap.has(triple.object))  triple.object  = corefMap.get(triple.object);
    }
    for (const entity of entities) {
      if (corefMap.has(entity.name)) entity.resolved_from = entity.name;
      const resolved = corefMap.get(entity.name);
      if (resolved) entity.name = resolved;
    }
  }

  // Deduplicate facts by value
  const seenFacts = new Set();
  const uniqueFacts = facts.filter(f => {
    const key = typeof f === "string" ? f : f.value;
    if (seenFacts.has(key)) return false;
    seenFacts.add(key);
    return true;
  });

  // Concepts: medium-confidence terms that aren't persons/projects
  for (const entity of entities) {
    if (
      entity.type === "concept" ||
      (entity.type === "uncertain" && entity.confidence >= 0.25 && entity.frequency >= 3)
    ) {
      concepts.push({
        value: entity.name,
        confidence: entity.confidence,
      });
    }
  }

  // Deduplicate concepts
  const seenConcepts = new Set();
  const uniqueConcepts = concepts.filter(c => {
    const key = typeof c === "string" ? c : c.value;
    if (seenConcepts.has(key)) return false;
    seenConcepts.add(key);
    return true;
  });

  return {
    entities,
    facts: uniqueFacts.slice(0, 10),   // cap at 10 facts per record
    concepts: uniqueConcepts.slice(0, 5), // cap at 5 concepts per record
  };
}

/**
 * Extract from a single memory record object.
 * Reads record.content + record.title as source text.
 *
 * @param {object} record - memory record with at least `content` or `title` field
 * @returns {object} - record augmented with `entities`, `facts`, `concepts`
 */
export function extractFromRecord(record) {
  if (!record) return { entities: [], facts: [], concepts: [] };
  const content = (record.content || record.text || "") + " " + (record.title || "");
  const { entities, facts, concepts } = extractEntities(content);

  return {
    ...record,
    entities: entities || [],
    facts: facts || [],
    concepts: concepts || [],
  };
}

/**
 * Process multiple records in batch.
 *
 * @param {object[]} records
 * @returns {object[]} - records augmented with entities/facts/concepts
 */
export function extractEntitiesFromRecords(records) {
  return records.map(r => extractFromRecord(r));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 */
function cliExtract(text) {
  const result = extractEntities(text);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * @param {string} filePath
 */
async function cliExtractFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim());
  const records = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const enriched = extractEntitiesFromRecords(records);
  for (const record of enriched) {
    if (record.facts?.length > 0 || record.concepts?.length > 0) {
      console.log(JSON.stringify(record, null, 2));
    }
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const [,, action, ...args] = process.argv;
  if (action === "extract" && args.length > 0) {
    cliExtract(args.join(" "));
  } else if (action === "extract-file" && args.length > 0) {
    cliExtractFile(args[0]);
  } else {
    console.error("Usage: node entity-extractor.js extract <text>");
    console.error("       node entity-extractor.js extract-file <path-to-jsonl>");
    process.exit(1);
  }
}