// ops/memory/record-coercion.js
// Record coercion, classification, promotion, and structured record parsing.
// Extracted from memory-layers-parse.js so callers can import coercion logic
// without pulling in entry parsers or lazy module loaders.

import crypto from "node:crypto";
import fs from "node:fs";
import { MS_PER_DAY, MS_PER_WEEK } from "../../bus/time-constants.js";
import { isCjkChar } from "../util/cjk-tokenize.js";
import { createJsonlStream } from "../util/jsonl-stream.js";
import { MEMORY_RECORD_SCHEMA_VERSION } from "./memory-contract.js";
import { readText } from "./paths-and-io.js";

// ---------------------------------------------------------------------------
// Shared configuration constants (used across modules)
// ---------------------------------------------------------------------------

const MIN_PROMOTION_CONFIDENCE = 0.6;
const DURABLE_SCOPES = new Set(["user", "feedback", "project", "reference"]);

const NON_PROMOTABLE_PROMOTION_TYPES = new Set([
  "summary",
  "session-summary",
  "daily-summary",
  "session-response",
  "task-note",
  "task-run",
  "task-job",
  "task-journal",
]);

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function normalizeSpaces(value) {
  return String(value || "")
    .replace(/\uFEFF/g, "")   // strip BOM
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimestamp(rawValue) {
  const candidate = normalizeSpaces(rawValue);
  if (!candidate) {
    return null;
  }
  const parsed = new Date(candidate.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function getFreshness(isoTimestamp) {
  if (!isoTimestamp) {
    return "unknown";
  }
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ageMs)) return "unknown";  // guard: invalid date string
  if (ageMs <= MS_PER_DAY) {
    return "hot";
  }
  if (ageMs <= MS_PER_WEEK) {
    return "warm";
  }
  return "cold";
}

function tokenize(text) {
  // CJK range is sourced from ops/util/cjk-tokenize.js to keep both callers
  // (this module and ops/entity/entity-extractor.js) using the same Unicode
  // boundary. Update there if the range needs to widen.
  const source = String(text || "").toLowerCase();
  const out = [];
  let buf = "";
  for (const ch of source) {
    if (/[a-z0-9_./:-]/.test(ch) || isCjkChar(ch)) {
      buf += ch;
    } else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

// ---------------------------------------------------------------------------
// Classification and promotion
// ---------------------------------------------------------------------------

function classifyScope(text, toolName) {
  const lower = String(text || "").toLowerCase();
  const hasAny = (patterns) => patterns.some((pattern) => pattern.test(lower));

  if (hasAny([/偏好/, /喜欢/, /中文/, /language/, /style/, /reply/, /沟通/, /用户/, /user prefers/, /简洁/])) {
    return { scope: "user", type: "preference", visibility: "shared", confidence: 0.7 };
  }
  if (hasAny([/必须/, /不要/, /避免/, /always/, /\bnever\b/, /\bmust\b/, /\bshould\b/, /workflow/, /rule/, /约定/, /规范/])) {
    return { scope: "feedback", type: "workflow-rule", visibility: "shared", confidence: 0.72 };
  }
  if (hasAny([/\bissue\b/, /\bpr\b/, /\brepo\b/, /\bproject\b/, /\btask\b/, /cron/, /blackboard/, /queue/, /workspace/, /任务/, /项目/])) {
    return { scope: "project", type: "project-context", visibility: "shared", confidence: 0.68 };
  }
  if (hasAny([/\bpath\b/, /\burl\b/, /\blink\b/, /\bdashboard\b/, /\blinear\b/, /\bslack\b/, /路径/, /链接/, /位置/])) {
    return { scope: "reference", type: "reference", visibility: "shared", confidence: 0.66 };
  }
  if (toolName === "openclaw" && hasAny([/\brun\b/, /\bsubagent\b/, /\bcron\b/, /\bjob\b/])) {
    return { scope: "task", type: "task-note", visibility: "shared", confidence: 0.6 };
  }
  return { scope: "summary", type: "summary", visibility: "shared", confidence: 0.45 };
}

function buildPromotionKey({
  durableType = "",
  fallbackScope = "",
  project = "",
  workspace = "",
  title = "",
  content = "",
  sourceRecordId = "",
  id = "",
  t = "",
} = {}) {
  const normalizedTargetScope = normalizeSpaces(durableType || fallbackScope || "record").toLowerCase();
  const normalizedProject = normalizeSpaces(project || workspace).toLowerCase();
  const text = normalizeSpaces([title, content].filter(Boolean).join(" ")).toLowerCase();
  const normalizedSourceRecordId = normalizeSpaces(sourceRecordId).toLowerCase();
  // Salt fields: id and timestamp prevent hash collisions from content truncation
  const idSalt = normalizeSpaces(id || "").toLowerCase();
  const tSalt = normalizeSpaces(t || "").toLowerCase();
  const tokens = tokenize(text)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 18);

  if (!normalizedTargetScope) {
    return "";
  }

  const fingerprint = tokens.length > 0
    ? tokens.join(" ")
    : normalizeSpaces(normalizedSourceRecordId || text).toLowerCase();
  if (!fingerprint) {
    return "";
  }

  return sha1(`${normalizedTargetScope}|${normalizedProject}|${idSalt}|${tSalt}|${fingerprint}`);
}

function buildPromotionMetadata({
  scope = "",
  type = "",
  sourceKind = "",
  memoryLevel = "",
  confidence = 0,
  project = "",
  workspace = "",
  title = "",
  content = "",
  sourceRecordId = "",
} = {}) {
  const normalizedScope = normalizeSpaces(scope).toLowerCase();
  const normalizedType = normalizeSpaces(type).toLowerCase();
  const normalizedSourceKind = normalizeSpaces(sourceKind).toLowerCase();
  const normalizedMemoryLevel = normalizeSpaces(memoryLevel).toLowerCase();
  const normalizedText = normalizeSpaces([title, content].filter(Boolean).join(" "));
  const normalizedSourceRecordId = normalizeSpaces(sourceRecordId);
  const numericConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  let durableType = "";

  let reason = "";
  if (!normalizedScope) {
    reason = "missing-scope";
  } else if (!normalizedText) {
    reason = "missing-content";
  } else if (!DURABLE_SCOPES.has(normalizedScope)) {
    reason = `non-promotable-scope:${normalizedScope}`;
  } else if (normalizedSourceKind === "writeback" || normalizedMemoryLevel === "durable") {
    durableType = normalizedScope;
    reason = `scope:${durableType}`;
  } else if (!normalizedType) {
    reason = "missing-type";
  } else if (NON_PROMOTABLE_PROMOTION_TYPES.has(normalizedType)) {
    reason = `non-promotable-type:${normalizedType}`;
  } else if (numericConfidence > 0 && numericConfidence < MIN_PROMOTION_CONFIDENCE) {
    reason = `low-confidence:${numericConfidence.toFixed(2)}`;
  } else {
    durableType = normalizedScope;
    reason = `scope+type:${durableType}`;
  }

  const key = buildPromotionKey({
    durableType,
    fallbackScope: normalizedScope,
    project,
    workspace,
    title,
    content,
    sourceRecordId: normalizedSourceRecordId,
  });

  return {
    version: 1,
    durable_type: durableType,
    key,
    reason,
    source_type: normalizedType,
    source_confidence: numericConfidence || 0,
    source_record_id: normalizedSourceRecordId,
  };
}

/**
 * Build a one-line semantic description from a record's content/facts/concepts.
 * Used as a lightweight summary field for relevance matching.
 * Follows the restored-cli pattern: "one-line hook for this memory".
 */
function buildMemoryDescription(record) {
  const firstFact = Array.isArray(record.facts) && record.facts[0]
    ? (typeof record.facts[0] === "string" ? record.facts[0] : record.facts[0].value?.[0] || "")
    : "";
  const firstConcept = Array.isArray(record.concepts) && record.concepts[0]
    ? (typeof record.concepts[0] === "string" ? record.concepts[0] : record.concepts[0].value?.[0] || "")
    : "";
  const shortContent = (record.content || "").substring(0, 120).trim();
  const text = firstFact || firstConcept || shortContent;
  // Clean up: remove markdown artifacts, collapse whitespace
  return text.replace(/[#*`_~[\]]/g, "").replace(/\s+/g, " ").trim();
}

function computeTier(record) {
  // ADR-002 v2 5-tier system: tier derived from memory_level + scope + source_kind
  const ml = (record.memory_level || record.memoryLevel || "").toLowerCase();
  const sk = (record.source_kind || record.sourceKind || "").toLowerCase();
  const scope = (record.scope || "").toLowerCase();
  if (ml === "event" || scope === "event") return 1;
  if (sk === "writeback") {
    return scope === "project" ? 3 : 4;
  }
  if (ml === "durable") {
    return scope === "project" ? 3 : 4;
  }
  if (ml === "session" || scope === "session" || scope === "summary" || scope === "task" || scope === "run" || scope === "job") return 2;
  // Default: session-level pending confirmation
  return 2;
}

/**
 * 30-second dedup window: skip inbox entries whose content_hash matches
 * an existing record written within the last 30 seconds.
 * This prevents burst writes (e.g., multiple tools writing the same observation)
 * from creating duplicate records.
 */
function shouldSkipAsRecentDuplicate(newRecord, existingRecordsByHash, nowMs) {
  const hash = newRecord.content_hash || sha256(newRecord.content || "");
  const existing = existingRecordsByHash.get(hash);
  if (!existing) return false;
  const existingMs = new Date(existing.t || existing.created_at || 0).getTime();
  return (nowMs - existingMs) < 30_000; // 30 seconds
}

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

function buildRecord({
  id,
  t,
  tool,
  session = "",
  type,
  project = "",
  title,
  content,
  facts = [],
  concepts = [],
  files_read = [],
  files_modified = [],
  source,
  scope,
  visibility,
  source_kind,
  memory_level,
  workspace = "",
  task_state = "",
  confidence = 0.5,
  metadata = {},
  content_hash = "",
}) {
  const normalizedTitle = normalizeSpaces(title || content).slice(0, 140) || id;
  const normalizedContent = String(content || "").trim();
  const normalizedWorkspace = normalizeSpaces(workspace || "");
  const normalizedMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
  normalizedMetadata.promotion = {
    ...(normalizedMetadata.promotion && typeof normalizedMetadata.promotion === "object" ? normalizedMetadata.promotion : {}),
    ...buildPromotionMetadata({
      scope,
      type,
      sourceKind: source_kind,
      memoryLevel: memory_level,
      confidence,
      project,
      workspace: normalizedWorkspace,
      title: normalizedTitle,
      content: normalizedContent,
      sourceRecordId: id,
    }),
  };
  const tier = computeTier({
    memory_level: memory_level || "",
    scope: scope || "",
    source_kind: source_kind || "",
  });

  const ttlByScope = { user: null, feedback: 90, reference: 180, project: 30, summary: 7 };
  const expiresAt = (() => {
    const offsetDays = ttlByScope[scope] ?? 7;
    if (offsetDays === null) return null;
    const base = new Date(t || new Date().toISOString());
    base.setDate(base.getDate() + offsetDays);
    return base.toISOString();
  })();

  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id,
    t,
    tool,
    session,
    type,
    project,
    title: normalizedTitle,
    description: buildMemoryDescription({ content: normalizedContent, facts, concepts }),
    content: normalizedContent,
    facts,
    concepts,
    files_read,
    files_modified,
    source,
    scope,
    visibility,
    source_kind,
    memory_level,
    workspace: normalizedWorkspace,
    task_state,
    freshness: getFreshness(t),
    confidence,
    metadata: normalizedMetadata,
    content_hash,
    // ADR-002 v2 tier + lifecycle fields
    tier,
    lifecycle: {
      tier,
      expires_at: expiresAt,
      access_count: 0,
      promotion_count: 0,
      archived: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Structured record coercion
// ---------------------------------------------------------------------------

function coerceStructuredRecord(payload, defaults = {}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const timestamp = parseTimestamp(payload.t || payload.timestamp || payload.updated_at || payload.created_at);
  const title = normalizeSpaces(payload.title || payload.content || "");
  const content = String(payload.content || payload.title || "").trim();
  if (!title && !content) {
    return null;
  }

  const recordId =
    normalizeSpaces(payload.id) ||
    `${defaults.prefix || "record"}-${sha1(`${defaults.source || ""}|${title}|${content.slice(0, 200)}`)}`;

  const normalizedScope = normalizeSpaces(payload.scope || defaults.scope || "summary") || "summary";
  const normalizedType = normalizeSpaces(payload.type || defaults.type || "summary") || "summary";
  const normalizedProject = normalizeSpaces(payload.project || defaults.project || "");
  const normalizedWorkspace = normalizeSpaces(payload.workspace || defaults.workspace || "");
  const normalizedSourceKind = normalizeSpaces(payload.source_kind || payload.sourceKind || defaults.source_kind || "") || "";
  const normalizedMemoryLevel = normalizeSpaces(payload.memory_level || payload.memoryLevel || defaults.memory_level || "task") || "task";
  const normalizedConfidence = typeof payload.confidence === "number" ? payload.confidence : defaults.confidence ?? 0.65;
  const normalizedMetadata = payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : {};
  normalizedMetadata.promotion = {
    ...(normalizedMetadata.promotion && typeof normalizedMetadata.promotion === "object" ? normalizedMetadata.promotion : {}),
    ...buildPromotionMetadata({
      scope: normalizedScope,
      type: normalizedType,
      sourceKind: normalizedSourceKind,
      memoryLevel: normalizedMemoryLevel,
      confidence: normalizedConfidence,
      project: normalizedProject,
      workspace: normalizedWorkspace,
      title: title || recordId,
      content,
      sourceRecordId: recordId,
    }),
  };

  return {
    schemaVersion: Number(payload.schemaVersion || MEMORY_RECORD_SCHEMA_VERSION),
    id: recordId,
    t: timestamp,
    tool: normalizeSpaces(payload.tool || defaults.tool || "system") || "system",
    session: normalizeSpaces(payload.session || ""),
    type: normalizedType,
    project: normalizedProject,
    title: title || recordId,
    description: typeof payload.description === "string" ? payload.description : buildMemoryDescription(payload),
    content: content.slice(0, 6000),
    facts: Array.isArray(payload.facts) ? payload.facts : [],
    concepts: Array.isArray(payload.concepts) ? payload.concepts : [],
    files_read: Array.isArray(payload.files_read) ? payload.files_read : [],
    files_modified: Array.isArray(payload.files_modified) ? payload.files_modified : [],
    source: normalizeSpaces(payload.source || defaults.source || "structured-record") || "structured-record",
    scope: normalizedScope,
    visibility: normalizeSpaces(payload.visibility || defaults.visibility || "shared") || "shared",
    source_kind: normalizedSourceKind,
    memory_level: normalizedMemoryLevel,
    workspace: normalizedWorkspace,
    task_state: normalizeSpaces(payload.task_state || payload.taskState || defaults.task_state || "") || "",
    freshness: normalizeSpaces(payload.freshness || getFreshness(timestamp)) || getFreshness(timestamp),
    confidence: normalizedConfidence,
    metadata: normalizedMetadata,
    content_hash: normalizeSpaces(payload.content_hash) || sha256(content),
    // ADR-002 v2: preserve or derive tier + lifecycle
    tier: payload.lifecycle?.tier ?? computeTier({ memory_level: normalizedMemoryLevel, scope: normalizedScope, source_kind: normalizedSourceKind }),
    lifecycle: payload.lifecycle && typeof payload.lifecycle === "object" ? payload.lifecycle : {
      tier: payload.lifecycle?.tier ?? computeTier({ memory_level: normalizedMemoryLevel, scope: normalizedScope, source_kind: normalizedSourceKind }),
      expires_at: null,
      access_count: 0,
      promotion_count: 0,
      archived: false,
    },
  };
}

function repairStructuredRecord(payload, defaults = {}) {
  const normalized = coerceStructuredRecord(payload, defaults);
  if (!normalized) {
    return null;
  }

  normalized.content_hash = normalizeSpaces(payload && payload.content_hash)
    || normalized.content_hash
    || sha256(normalized.content || "");
  return normalized;
}

function parseStructuredJsonl(filePath, defaults = {}) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const records = [];
  for (const line of readText(filePath).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }

    const record = coerceStructuredRecord(payload, defaults);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Stream-parse a JSONL file and coerce each line to a structured record.
 * Uses createJsonlStream to avoid loading the entire file into memory.
 * Returns an array (consumes the async generator eagerly).
 *
 * @param {string} filePath
 * @param {object} defaults
 * @returns {Promise<object[]>}
 */
async function loadStructuredRecords(filePath, defaults = {}) {
  const records = [];
  for await (const payload of createJsonlStream(filePath)) {
    const record = coerceStructuredRecord(payload, defaults);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

export {
  // Constants
  MIN_PROMOTION_CONFIDENCE, DURABLE_SCOPES, NON_PROMOTABLE_PROMOTION_TYPES,
  MEMORY_RECORD_SCHEMA_VERSION,
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
};
