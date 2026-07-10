// ops/memory/memory-contract.js
//
// Re-export shim for the memory-contract module. The implementation lives
// in ./memory-contract/{schema,validation,scoring}.js. External callers
// continue to import from this top-level path for backward compatibility.

export {
  ALLOWED_DURABLE_TYPES,
  ALLOWED_MEMORY_LEVELS,
  ALLOWED_SCOPES,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_TIERS,
  ALLOWED_VISIBILITY,
  GENERATED_MEMORY_DEFINITIONS,
  MEMORY_INTEGRITY_CONTRACT_VERSION,
  MEMORY_RECORD_SCHEMA_VERSION,
  REQUIRED_RECORD_FIELDS,
  STRUCTURED_LAYER_DEFINITIONS,
} from "./memory-contract/schema.js";

export {
  buildFileStamp,
  buildGeneratedArtifactMetadata,
  buildMemoryIntegrityReport,
  buildStructuredSignature,
  isExpectedDerivedDuplicate,
  isPlainObject,
  normalizeLower,
  normalizeString,
  parseTimestampMs,
  sha1,
  validatePromotionMetadata,
  validateStructuredRecord,
} from "./memory-contract/validation.js";

export {
  buildRecordFingerprint,
  computeFingerprintOverlap,
  detectConflicts,
  exportSchemaAsJson,
  scorePromotionCandidate,
  validateSchemaConsistency,
} from "./memory-contract/scoring.js";