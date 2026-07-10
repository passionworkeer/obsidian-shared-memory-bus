// ops/memory/memory-contract/schema.js
//
// Schema constants and layer definitions used by the structured memory
// pipeline. Sourced preferentially from ops/adapters/generated/memory-contract-schema.cjs
// (produced by ops/adapters/generate-schemas.js from ops/adapters/schema-registry.json).
// Falls back to inline defaults when the generated file is unavailable.

// ---------------------------------------------------------------------------
// Schema constants — prefer generated schema, fall back to inline definitions.
// ---------------------------------------------------------------------------

let _genSchema;
try {
  _genSchema = await import("../../adapters/generated/memory-contract-schema.cjs");
} catch {
  _genSchema = null;
}

export const MEMORY_RECORD_SCHEMA_VERSION = _genSchema
  ? _genSchema.MEMORY_RECORD_SCHEMA_VERSION
  : 2;
export const MEMORY_INTEGRITY_CONTRACT_VERSION = _genSchema
  ? _genSchema.MEMORY_INTEGRITY_CONTRACT_VERSION
  : 2;
export const REQUIRED_RECORD_FIELDS = _genSchema
  ? _genSchema.REQUIRED_RECORD_FIELDS
  : ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"];
export const ALLOWED_SCOPES = _genSchema ? _genSchema.ALLOWED_SCOPES
  : new Set(["user", "feedback", "project", "reference", "summary", "task", "run"]);
export const ALLOWED_VISIBILITY = _genSchema ? _genSchema.ALLOWED_VISIBILITY
  : new Set(["shared", "private"]);
export const ALLOWED_SOURCE_KINDS = _genSchema ? _genSchema.ALLOWED_SOURCE_KINDS
  : new Set(["writeback", "hook", "session", "event", "blackboard", "run", "cron", "task"]);
export const ALLOWED_MEMORY_LEVELS = _genSchema ? _genSchema.ALLOWED_MEMORY_LEVELS
  : new Set(["durable", "session", "event", "task"]);
export const ALLOWED_DURABLE_TYPES = _genSchema ? _genSchema.ALLOWED_DURABLE_TYPES
  : new Set(["user", "feedback", "project", "reference"]);
export const ALLOWED_TIERS = _genSchema ? _genSchema.ALLOWED_TIERS
  : new Set([1, 2, 3, 4, 5]);

// Optional additional fields (not required for validation, pass-through):
//   name         — optional string, alternate title/identifier
//   description  — optional string, one-line semantic summary (buildMemoryDescription)

export const STRUCTURED_LAYER_DEFINITIONS = [
  {
    key: "sharedInbox",
    fileName: "shared-inbox.jsonl",
    label: "durable shared inbox",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "sessionMemory",
    fileName: "session-memory.jsonl",
    label: "session memory",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "sharedEvents",
    fileName: "shared-events.jsonl",
    label: "shared events",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "taskMemory",
    fileName: "task-memory.jsonl",
    label: "task memory",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "claudeCodeImported",
    fileName: "claude-code.jsonl",
    label: "Claude Code imported memory",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "openclawSessions",
    fileName: "openclaw.jsonl",
    label: "OpenClaw imported sessions",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "openclawBlackboard",
    fileName: "openclaw-blackboard.jsonl",
    label: "OpenClaw blackboard",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "openclawRuns",
    fileName: "openclaw-runs.jsonl",
    label: "OpenClaw runs",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "openclawJobs",
    fileName: "openclaw-jobs.jsonl",
    label: "OpenClaw jobs",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "openclawJournal",
    fileName: "openclaw-journal.jsonl",
    label: "OpenClaw journal",
    requiredFields: ["schemaVersion", "id", "tool", "type", "title", "source", "scope", "memory_level"],
  },
  {
    key: "dailyLogs",
    fileName: "logs",
    label: "daily append-only logs",
    requiredFields: [],
  },
];

export const GENERATED_MEMORY_DEFINITIONS = [
  { key: "memoryLayers", fileName: "MEMORY-LAYERS.json", label: "memory layers" },
  { key: "handoffPack", fileName: "HANDOFF.json", label: "handoff pack" },
  { key: "autoDream", fileName: "AUTO-DREAM.json", label: "auto dream" },
];

// (schema-registry.json path resolution lives in scoring.js, where it's used.)