// ops/memory/memory-layers-parse.js
// Thin barrel re-exporting from the 4 split modules below. Existing importers
// keep working unchanged; the file no longer mixes path/I/O constants, record
// coercion, entry parsers, and lazy module loaders in a single 1.1k-line body.
//
//   - paths-and-io.js      : path constants + core I/O helpers + file locking
//   - record-coercion.js   : normalization, classification, promotion, buildRecord
//   - entry-parsers.js     : parseInbox/Event/Session/Task + resolveIncludes
//   - lazy-loaders.js      : loadEntityExtractor / loadKnowledgeGraph

export {
  // I/O
  readJsonl, readText, writeText, ensureDirectory, withFileLock, safeRealpathWithin,
  // Path constants
  USER_HOME, OPENCLAW_HOME, CLAUDE_HOME,
  INBOX_ROOT, EVENTS_ROOT, STRUCTURED_ROOT, GENERATED_ROOT, STORE_ROOT, AI_MEMORY_ROOT,
  SHARED_INBOX_JSONL, DREAM_INBOX_JSONL, SESSION_MEMORY_JSONL, SHARED_EVENTS_JSONL,
  TASK_MEMORY_JSONL, CLAUDE_CODE_JSONL, OPENCLAW_SESSIONS_JSONL,
  OPENCLAW_BLACKBOARD_JSONL, OPENCLAW_RUNS_JSONL, OPENCLAW_JOBS_JSONL, OPENCLAW_JOURNAL_JSONL,
  DAILY_LOG_DIR, PROJECTS_ROOT,
  MEMORY_LAYERS_MD, MEMORY_LAYERS_JSON, GLOBAL_CONTEXT_MD,
  GLOBAL_CONTEXT_META_JSON, GLOBAL_CONTEXT_BODY_MD,
} from "./paths-and-io.js";

export {
  // Utility
  normalizeSpaces, sha1, sha256, parseTimestamp, tokenize,
  // Classification & promotion
  classifyScope, buildPromotionKey, buildPromotionMetadata, buildMemoryDescription,
  // Record builder + tier
  computeTier, buildRecord,
  // Coercion
  coerceStructuredRecord, repairStructuredRecord, getFreshness, shouldSkipAsRecentDuplicate,
  // JSONL readers
  parseStructuredJsonl, loadStructuredRecords,
  // Constants
  MIN_PROMOTION_CONFIDENCE, DURABLE_SCOPES, NON_PROMOTABLE_PROMOTION_TYPES,
  MEMORY_RECORD_SCHEMA_VERSION,
} from "./record-coercion.js";

export {
  parseInboxEntries, parseEventEntries, parseSessionMemoryEntries, parseTaskMemoryEntries,
  preserveDreamRecords, getTargetJsonl, resolveIncludes,
} from "./entry-parsers.js";

export { loadEntityExtractor, loadKnowledgeGraph } from "./lazy-loaders.js";

export { buildGeneratedArtifactMetadata } from "./memory-contract.js";
