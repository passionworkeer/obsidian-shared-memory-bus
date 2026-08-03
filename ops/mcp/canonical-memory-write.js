import crypto from "node:crypto";
import path from "node:path";

import { resolveStoreRoot } from "../../bus/store-root.js";
import { appendLineAtomic } from "../inbox/inbox-atomic-write.js";

const MAX_FACT_FIELD_CHARS = 2000;
const MAX_BATCH_SIZE = 1000;
const VALID_SCOPES = new Set(["user", "feedback", "project", "reference"]);
const VALID_MEMORY_LEVELS = new Set(["durable", "session", "event", "task"]);

function normalizeString(value) {
  return String(value ?? "").trim();
}

function sanitizeProjectKey(raw) {
  const value = normalizeString(raw);
  if (!value || /[/\\]/.test(value) || value === "." || value === "..") {
    return "";
  }
  return value;
}

function detectProjectKey({ project = "", cwd = "" } = {}) {
  const explicit = sanitizeProjectKey(project);
  if (explicit) return explicit;

  const normalizedCwd = normalizeString(cwd).replace(/[/\\]+$/, "");
  const cwdLeaf = sanitizeProjectKey(path.basename(normalizedCwd));
  return cwdLeaf || "default";
}

function validateTextArray(value, fieldName) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`fact.${fieldName} must be an array`);
  }
  value.forEach((item, index) => {
    const serialized = typeof item === "string" ? item : JSON.stringify(item);
    if (typeof serialized !== "string" || serialized.length > MAX_FACT_FIELD_CHARS) {
      throw new Error(`fact.${fieldName}[${index}] must be under ${MAX_FACT_FIELD_CHARS} characters`);
    }
  });
}

function validateFact(fact) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
    throw new Error("fact must be an object");
  }
  if (typeof fact.content !== "string" || !fact.content.trim()) {
    throw new Error("fact.content (non-empty string) is required");
  }
  if (fact.content.length > MAX_FACT_FIELD_CHARS) {
    throw new Error(`fact.content must be under ${MAX_FACT_FIELD_CHARS} characters`);
  }
  if (fact.scope && !VALID_SCOPES.has(normalizeString(fact.scope).toLowerCase())) {
    throw new Error(`fact.scope must be one of ${Array.from(VALID_SCOPES).join(", ")}`);
  }
  if (fact.memory_level && !VALID_MEMORY_LEVELS.has(normalizeString(fact.memory_level).toLowerCase())) {
    throw new Error(`fact.memory_level must be one of ${Array.from(VALID_MEMORY_LEVELS).join(", ")}`);
  }
  if (
    fact.confidence != null &&
    (typeof fact.confidence !== "number" || fact.confidence < 0 || fact.confidence > 1)
  ) {
    throw new Error("fact.confidence must be between 0 and 1");
  }
  validateTextArray(fact.facts, "facts");
  validateTextArray(fact.decisions, "decisions");
  validateTextArray(fact.entities, "entities");
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function buildTitle(fact) {
  const explicit = normalizeString(fact.title);
  if (explicit) return explicit.slice(0, 160);
  return fact.content.replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled memory";
}

function buildCanonicalRecord(fact, { projectKey, agentId, now }) {
  const id = normalizeString(fact.id) || `rec_${crypto.randomUUID()}`;
  const scope = normalizeString(fact.scope).toLowerCase() || "project";
  const requestedLevel = normalizeString(fact.memory_level || fact.memoryLevel).toLowerCase();
  const memoryLevel = requestedLevel || (VALID_SCOPES.has(scope) ? "durable" : "session");
  const tool = normalizeString(fact.tool || agentId) || "mcp";
  const type = normalizeString(fact.type || fact.session_type) || "note";
  const timestamp = normalizeString(fact.t) || now;

  return {
    schemaVersion: 2,
    id,
    tool,
    type,
    title: buildTitle(fact),
    source: normalizeString(fact.source) || `mcp:memory_write:${projectKey}`,
    scope,
    memory_level: memoryLevel,
    visibility: "shared",
    source_kind: "writeback",
    project: projectKey,
    content: fact.content,
    content_hash: contentHash(fact.content),
    confidence: fact.confidence ?? 0.9,
    facts: Array.isArray(fact.facts) ? fact.facts : [],
    decisions: Array.isArray(fact.decisions) ? fact.decisions : [],
    entities: Array.isArray(fact.entities) ? fact.entities : [],
    session_id: normalizeString(fact.session_id) || `manual_${crypto.randomUUID()}`,
    session_type: normalizeString(fact.session_type) || "note",
    extraction_failed: false,
    write_mode: "manual",
    t: timestamp,
    metadata: {
      ...(fact.metadata && typeof fact.metadata === "object" && !Array.isArray(fact.metadata)
        ? fact.metadata
        : {}),
      canonical_write: true,
    },
  };
}

function buildLegacyProjection(record) {
  return {
    id: record.id,
    session_id: record.session_id,
    project: record.project,
    scope: record.scope,
    content: record.content,
    confidence: record.confidence,
    facts: record.facts,
    decisions: record.decisions,
    entities: record.entities,
    session_type: record.session_type,
    extraction_failed: false,
    write_mode: "canonical-projection",
    t: record.t,
  };
}

async function writeCanonicalMemory({ agent_id = "", project = "", cwd = "", facts = [] } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error("facts[] is required");
  }
  if (facts.length > MAX_BATCH_SIZE) {
    throw new Error(`facts[] batch size ${facts.length} exceeds cap of ${MAX_BATCH_SIZE}`);
  }
  facts.forEach(validateFact);

  const storeRoot = resolveStoreRoot();
  const projectKey = detectProjectKey({ project, cwd });
  const structuredRoot = path.join(storeRoot, "structured");
  const projectsRoot = path.join(storeRoot, "projects");
  const canonicalPath = path.join(structuredRoot, "shared-inbox.jsonl");
  const legacyPath = path.join(projectsRoot, `${projectKey}.jsonl`);
  const now = new Date().toISOString();
  const records = facts.map((fact) => buildCanonicalRecord(fact, {
    projectKey,
    agentId: agent_id,
    now,
  }));

  for (const record of records) {
    appendLineAtomic(canonicalPath, record, {
      createDir: true,
      fsync: true,
      safeRoot: structuredRoot,
    });
    appendLineAtomic(legacyPath, buildLegacyProjection(record), {
      createDir: true,
      safeRoot: projectsRoot,
    });
  }

  return {
    ok: true,
    project: projectKey,
    canonical_path: canonicalPath,
    compatibility_path: legacyPath,
    written: records.map((record) => record.id),
    canonical: true,
  };
}

export {
  MAX_BATCH_SIZE,
  MAX_FACT_FIELD_CHARS,
  buildCanonicalRecord,
  detectProjectKey,
  writeCanonicalMemory,
};
