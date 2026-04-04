const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MEMORY_RECORD_SCHEMA_VERSION = 2;
const MEMORY_INTEGRITY_CONTRACT_VERSION = 2;
// Optional additional fields (not required for validation, pass-through):
//   name         — optional string, alternate title/identifier
//   description  — optional string, one-line semantic summary (buildMemoryDescription)
const ALLOWED_SCOPES = new Set(["user", "feedback", "project", "reference", "summary", "task", "run"]);
const ALLOWED_VISIBILITY = new Set(["shared", "private"]);
const ALLOWED_SOURCE_KINDS = new Set(["writeback", "hook", "session", "event", "blackboard", "run", "cron", "task"]);
const ALLOWED_MEMORY_LEVELS = new Set(["durable", "session", "event", "task"]);
const ALLOWED_DURABLE_TYPES = new Set(["user", "feedback", "project", "reference"]);

const STRUCTURED_LAYER_DEFINITIONS = [
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

const GENERATED_MEMORY_DEFINITIONS = [
  { key: "memoryLayers", fileName: "MEMORY-LAYERS.json", label: "memory layers" },
  { key: "handoffPack", fileName: "HANDOFF.json", label: "handoff pack" },
  { key: "autoDream", fileName: "AUTO-DREAM.json", label: "auto dream" },
];

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function buildFileStamp(filePath) {
  if (!fs.existsSync(filePath)) {
    return "__missing__";
  }

  const body = fs.readFileSync(filePath, "utf8");
  return `${path.basename(filePath)}:${sha1(body)}:${Buffer.byteLength(body, "utf8")}`;
}

function parseTimestampMs(value) {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function validatePromotionMetadata(promotion) {
  if (!isPlainObject(promotion)) {
    return [];
  }
  const errors = [];
  if (promotion.version !== 1) {
    errors.push(`unknown-promotion-version:${promotion.version}`);
  }
  if (normalizeLower(promotion.durable_type) && !ALLOWED_DURABLE_TYPES.has(normalizeLower(promotion.durable_type))) {
    errors.push(`unknown-promotion-durable-type:${normalizeString(promotion.durable_type)}`);
  }
  if (!normalizeString(promotion.key)) {
    errors.push("missing-promotion-key");
  }
  if (!normalizeString(promotion.reason)) {
    errors.push("missing-promotion-reason");
  }
  if (!normalizeString(promotion.source_record_id)) {
    errors.push("missing-promotion-source-record-id");
  }
  if (typeof promotion.is_refresh !== "undefined" && typeof promotion.is_refresh !== "boolean") {
    errors.push("invalid-promotion-is-refresh-type");
  }
  if (Array.isArray(promotion.conflict_with) && promotion.conflict_with.some((id) => !normalizeString(id))) {
    errors.push("invalid-promotion-conflict-with");
  }
  if (promotion.is_refresh === true) {
    if (!normalizeString(promotion.refresh_of_id)) {
      errors.push("missing-promotion-refresh-of-id");
    }
    if (!normalizeString(promotion.refresh_of_t)) {
      errors.push("missing-promotion-refresh-of-t");
    }
  }
  return errors;
}

function validateStructuredRecord(record, requiredFields = []) {
  if (!isPlainObject(record)) {
    return {
      ok: false,
      schemaVersion: null,
      missingFields: [...requiredFields],
      errors: ["record-not-object"],
    };
  }

  const missingFields = requiredFields.filter((fieldName) => {
    const value = record[fieldName];
    if (typeof value === "number") {
      return !Number.isFinite(value);
    }
    return !normalizeString(value);
  });

  const schemaVersion = Number(record.schemaVersion || 0) || null;
  const errors = [];
  if (schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
    errors.push(`unexpected-schema-version:${schemaVersion ?? "missing"}`);
  }
  if (normalizeLower(record.scope) && !ALLOWED_SCOPES.has(normalizeLower(record.scope))) {
    errors.push(`unknown-scope:${normalizeString(record.scope)}`);
  }
  if (normalizeLower(record.visibility) && !ALLOWED_VISIBILITY.has(normalizeLower(record.visibility))) {
    errors.push(`unknown-visibility:${normalizeString(record.visibility)}`);
  }
  if (normalizeLower(record.source_kind || record.sourceKind) && !ALLOWED_SOURCE_KINDS.has(normalizeLower(record.source_kind || record.sourceKind))) {
    errors.push(`unknown-source-kind:${normalizeString(record.source_kind || record.sourceKind)}`);
  }
  if (normalizeLower(record.memory_level || record.memoryLevel) && !ALLOWED_MEMORY_LEVELS.has(normalizeLower(record.memory_level || record.memoryLevel))) {
    errors.push(`unknown-memory-level:${normalizeString(record.memory_level || record.memoryLevel)}`);
  }
  if (isPlainObject(record.metadata) && isPlainObject(record.metadata.promotion)) {
    const promoErrors = validatePromotionMetadata(record.metadata.promotion);
    if (promoErrors.length > 0) {
      errors.push(...promoErrors);
    }
  }
  if (normalizeString(record.content_hash) && !/^[a-f0-9]{64}$/i.test(normalizeString(record.content_hash))) {
    errors.push(`invalid-content-hash:${normalizeString(record.content_hash)}`);
  }
  // name and description are optional; validate type if present
  if (typeof record.name !== "undefined" && typeof record.name !== "string") {
    errors.push("invalid-name-type");
  }
  if (typeof record.description !== "undefined" && typeof record.description !== "string") {
    errors.push("invalid-description-type");
  }
  if (missingFields.length > 0) {
    errors.push(`missing-fields:${missingFields.join(",")}`);
  }

  return {
    ok: errors.length === 0,
    schemaVersion,
    missingFields,
    errors,
  };
}

function analyzeStructuredLayer(filePath, layerDefinition, detailLimit = 12) {
  const summary = {
    key: layerDefinition.key,
    label: layerDefinition.label,
    path: filePath,
    exists: fs.existsSync(filePath),
    recordCount: 0,
    validRecordCount: 0,
    invalidRecordCount: 0,
    malformedLineCount: 0,
    latestRecordAt: "",
    latestRecordAtMs: 0,
    invalidSamples: [],
    malformedSamples: [],
    ids: [],
  };

  if (!summary.exists) {
    return summary;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      summary.malformedLineCount += 1;
      if (summary.malformedSamples.length < detailLimit) {
        summary.malformedSamples.push({
          line: index + 1,
          error: String(error && error.message ? error.message : error),
        });
      }
      return;
    }

    summary.recordCount += 1;
    const validation = validateStructuredRecord(payload, layerDefinition.requiredFields);
    const recordId = normalizeString(payload.id);
    if (recordId) {
      summary.ids.push(recordId);
    }

    const recordTimestampMs = parseTimestampMs(payload.t);
    if (recordTimestampMs > summary.latestRecordAtMs) {
      summary.latestRecordAtMs = recordTimestampMs;
      summary.latestRecordAt = payload.t || "";
    }

    if (validation.ok) {
      summary.validRecordCount += 1;
      return;
    }

    summary.invalidRecordCount += 1;
    if (summary.invalidSamples.length < detailLimit) {
      summary.invalidSamples.push({
        id: recordId || `line-${index + 1}`,
        line: index + 1,
        errors: validation.errors,
      });
    }
  });

  return summary;
}

function analyzeGeneratedArtifact(filePath, definition, latestStructuredMs = 0, currentStructuredSignature = null) {
  const summary = {
    key: definition.key,
    label: definition.label,
    path: filePath,
    exists: fs.existsSync(filePath),
    status: "missing",
    parseOk: false,
    generatedAt: "",
    generatedAtMs: 0,
    stale: false,
    error: "",
    contractVersion: null,
    contractAligned: null,
    recordSchemaVersion: null,
    recordSchemaAligned: null,
    sourceStructuredSignature: null,
    missingSourceStructuredSignature: false,
    alignmentMode: "timestamp",
    alignmentReason: "",
  };

  if (!summary.exists) {
    return summary;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    summary.parseOk = isPlainObject(payload);
    summary.generatedAt = normalizeString(payload.generatedAt);
    summary.generatedAtMs = parseTimestampMs(summary.generatedAt);
    summary.contractVersion = Number(payload.contractVersion || 0) || null;
    summary.contractAligned = summary.contractVersion === MEMORY_INTEGRITY_CONTRACT_VERSION;
    summary.recordSchemaVersion = Number(payload.recordSchemaVersion || 0) || null;
    summary.recordSchemaAligned = summary.recordSchemaVersion === MEMORY_RECORD_SCHEMA_VERSION;
    const sourceStructuredSignature = isPlainObject(payload.sourceStructuredSignature)
      ? payload.sourceStructuredSignature
      : isPlainObject(payload.structuredSignature)
        ? payload.structuredSignature
        : null;
    if (isPlainObject(sourceStructuredSignature)) {
      summary.sourceStructuredSignature = {
        raw: normalizeString(sourceStructuredSignature.raw),
        hash: normalizeString(sourceStructuredSignature.hash),
      };
    } else {
      summary.missingSourceStructuredSignature = true;
    }
  } catch (error) {
    summary.error = String(error && error.message ? error.message : error);
    summary.status = "error";
    return summary;
  }

  if (!summary.generatedAtMs) {
    const stat = fs.statSync(filePath);
    summary.generatedAtMs = stat.mtimeMs;
    summary.generatedAt = new Date(stat.mtimeMs).toISOString();
  }

  const currentRaw = normalizeString(currentStructuredSignature && currentStructuredSignature.raw);
  const currentHash = normalizeString(currentStructuredSignature && currentStructuredSignature.hash);
  const artifactRaw = normalizeString(summary.sourceStructuredSignature && summary.sourceStructuredSignature.raw);
  const artifactHash = normalizeString(summary.sourceStructuredSignature && summary.sourceStructuredSignature.hash);

  if (currentRaw && artifactRaw) {
    summary.alignmentMode = "signature";
    summary.stale = artifactRaw !== currentRaw;
    summary.alignmentReason = summary.stale ? "structured-signature-mismatch" : "structured-signature-match";
  } else if (currentHash && artifactHash) {
    summary.alignmentMode = "signature";
    summary.stale = artifactHash !== currentHash;
    summary.alignmentReason = summary.stale ? "structured-signature-hash-mismatch" : "structured-signature-hash-match";
  } else if (summary.missingSourceStructuredSignature && currentStructuredSignature) {
    summary.alignmentMode = "signature";
    summary.stale = true;
    summary.alignmentReason = "missing-source-structured-signature";
  } else {
    summary.alignmentMode = "timestamp";
    summary.stale = latestStructuredMs > 0 && summary.generatedAtMs > 0 && summary.generatedAtMs < latestStructuredMs;
    summary.alignmentReason = summary.stale ? "generated-at-older-than-structured" : "timestamp-aligned";
  }

  if (summary.contractAligned === false || summary.recordSchemaAligned === false) {
    summary.status = "error";
    summary.alignmentReason = "contract-version-mismatch";
  } else {
    summary.status = summary.stale ? "stale" : "aligned";
  }
  return summary;
}

function buildStructuredSignature(structuredRoot, definitions = STRUCTURED_LAYER_DEFINITIONS) {
  const parts = definitions.map((definition) => buildFileStamp(path.join(structuredRoot, definition.fileName)));
  const raw = parts.join("|") || "__empty__";
  return {
    raw,
    hash: sha1(raw).slice(0, 16),
  };
}

function buildGeneratedArtifactMetadata({ structuredRoot, generatedAt = "" } = {}) {
  return {
    generatedAt: normalizeString(generatedAt) || new Date().toISOString(),
    contractVersion: MEMORY_INTEGRITY_CONTRACT_VERSION,
    recordSchemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    sourceStructuredSignature: buildStructuredSignature(structuredRoot),
    description: "Generated artifact tracking structured memory layers and their freshness.",
  };
}

function isExpectedDerivedDuplicate(firstFileName, secondFileName) {
  const pair = new Set([normalizeString(firstFileName), normalizeString(secondFileName)]);
  if (pair.has("session-memory.jsonl")) {
    return pair.has("claude-code.jsonl") || pair.has("openclaw.jsonl");
  }

  if (!pair.has("task-memory.jsonl")) {
    return false;
  }

  return (
    pair.has("openclaw-blackboard.jsonl") ||
    pair.has("openclaw-runs.jsonl") ||
    pair.has("openclaw-jobs.jsonl") ||
    pair.has("openclaw-journal.jsonl")
  );
}

function buildMemoryIntegrityReport(options = {}) {
  const structuredRoot = normalizeString(options.structuredRoot);
  const generatedRoot = normalizeString(options.generatedRoot);
  const detailLimit = Math.max(4, Number(options.detailLimit || 12) || 12);
  const structuredSignature = buildStructuredSignature(structuredRoot);
  const structuredLayers = {};
  const generatedArtifacts = {};
  const seenIds = new Map();
  const duplicateIds = [];
  let latestStructuredMs = 0;

  for (const definition of STRUCTURED_LAYER_DEFINITIONS) {
    const filePath = path.join(structuredRoot, definition.fileName);
    const layerSummary = analyzeStructuredLayer(filePath, definition, detailLimit);
    structuredLayers[definition.key] = {
      key: layerSummary.key,
      label: layerSummary.label,
      path: layerSummary.path,
      exists: layerSummary.exists,
      recordCount: layerSummary.recordCount,
      validRecordCount: layerSummary.validRecordCount,
      invalidRecordCount: layerSummary.invalidRecordCount,
      malformedLineCount: layerSummary.malformedLineCount,
      latestRecordAt: layerSummary.latestRecordAt,
      invalidSamples: layerSummary.invalidSamples,
      malformedSamples: layerSummary.malformedSamples,
    };

    latestStructuredMs = Math.max(latestStructuredMs, layerSummary.latestRecordAtMs);
    for (const recordId of layerSummary.ids) {
      if (!recordId) {
        continue;
      }

      if (seenIds.has(recordId)) {
        if (isExpectedDerivedDuplicate(seenIds.get(recordId), definition.fileName)) {
          continue;
        }
        if (duplicateIds.length < detailLimit) {
          duplicateIds.push({
            id: recordId,
            firstSeenIn: seenIds.get(recordId),
            duplicateIn: definition.fileName,
          });
        }
        continue;
      }

      seenIds.set(recordId, definition.fileName);
    }
  }

  for (const definition of GENERATED_MEMORY_DEFINITIONS) {
    const filePath = path.join(generatedRoot, definition.fileName);
    generatedArtifacts[definition.key] = analyzeGeneratedArtifact(
      filePath,
      definition,
      latestStructuredMs,
      structuredSignature
    );
  }

  const totals = Object.values(structuredLayers).reduce(
    (accumulator, layer) => {
      accumulator.recordCount += Number(layer.recordCount || 0);
      accumulator.validRecordCount += Number(layer.validRecordCount || 0);
      accumulator.invalidRecordCount += Number(layer.invalidRecordCount || 0);
      accumulator.malformedLineCount += Number(layer.malformedLineCount || 0);
      return accumulator;
    },
    {
      recordCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      malformedLineCount: 0,
    }
  );

  const generatedStatuses = Object.values(generatedArtifacts);
  const hasGeneratedDrift = generatedStatuses.some((artifact) => artifact.status === "stale" || artifact.status === "error");
  const hasGeneratedMissing = latestStructuredMs > 0 && generatedStatuses.some((artifact) => !artifact.exists);
  const hasStructuredErrors =
    totals.invalidRecordCount > 0 || totals.malformedLineCount > 0 || duplicateIds.length > 0;

  let status = "ok";
  if (hasStructuredErrors) {
    status = "error";
  } else if (hasGeneratedDrift || hasGeneratedMissing) {
    status = "warn";
  }

  const issues = [];
  if (totals.invalidRecordCount > 0) {
    issues.push(`invalid-records:${totals.invalidRecordCount}`);
  }
  if (totals.malformedLineCount > 0) {
    issues.push(`malformed-lines:${totals.malformedLineCount}`);
  }
  if (duplicateIds.length > 0) {
    issues.push(`duplicate-ids:${duplicateIds.length}`);
  }
  if (hasGeneratedMissing) {
    issues.push("generated-artifacts-missing");
  }
  if (hasGeneratedDrift) {
    issues.push("generated-artifacts-stale-or-invalid");
  }
  if (Object.values(generatedArtifacts).some((artifact) => artifact.missingSourceStructuredSignature)) {
    issues.push("generated-artifacts-missing-source-signature");
  }
  if (Object.values(generatedArtifacts).some((artifact) => artifact.contractAligned === false || artifact.recordSchemaAligned === false)) {
    issues.push("generated-artifacts-contract-mismatch");
  }

  return {
    contractVersion: MEMORY_INTEGRITY_CONTRACT_VERSION,
    recordSchemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    status,
    issueCount: issues.length,
    issues,
    structuredSignature,
    latestStructuredAt: latestStructuredMs > 0 ? new Date(latestStructuredMs).toISOString() : "",
    totals: {
      ...totals,
      duplicateIdCount: duplicateIds.length,
    },
    structuredLayers,
    generatedArtifacts,
    duplicateIds,
  };
}

module.exports = {
  ALLOWED_DURABLE_TYPES,
  ALLOWED_MEMORY_LEVELS,
  ALLOWED_SCOPES,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_VISIBILITY,
  GENERATED_MEMORY_DEFINITIONS,
  MEMORY_INTEGRITY_CONTRACT_VERSION,
  MEMORY_RECORD_SCHEMA_VERSION,
  STRUCTURED_LAYER_DEFINITIONS,
  buildGeneratedArtifactMetadata,
  buildMemoryIntegrityReport,
  buildStructuredSignature,
  validatePromotionMetadata,
  validateStructuredRecord,
};
