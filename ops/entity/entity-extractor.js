// ops/entity/entity-extractor.js
//
// Re-export shim for the entity-extractor module. The implementation lives
// in ./entity-extractor/{patterns,extractors,pipeline}.js. External callers
// continue to import from this top-level path for backward compatibility.
//
// Two-pass approach (inspired by MemPalace's entity_detector.py):
//   Pass 1: Scan text, extract entity candidates with frequency + signal patterns
//   Pass 2: Score and classify each candidate as person / project / concept
//
// Output: structured facts[] and concepts[] attached to each record.
// Input:  raw content string or memory record object.
//
// No external dependencies — pure regex + heuristics.
// Designed for Node.js 18+ (no ESM-only features).
//
// Usage (standalone):
//   node entity-extractor.js extract "Alice said the project uses Postgres"
//   node entity-extractor.js extract-file <path-to-jsonl>
//
// Usage (as module):
//   import { extractEntities, extractFromRecord, extractEntitiesFromRecords } from './entity-extractor.js';

export {
  extractCandidates,
  classifyEntity,
  extractRelationships,
  resolveCoreference,
  scoreEntity,
} from "./entity-extractor/extractors.js";

export {
  extractEntities,
  extractFromRecord,
  extractEntitiesFromRecords,
} from "./entity-extractor/pipeline.js";