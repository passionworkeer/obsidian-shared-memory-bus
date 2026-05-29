import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createJsonlStream } from "../util/jsonl-stream.js";
import { buildGeneratedArtifactMetadata, MEMORY_RECORD_SCHEMA_VERSION } from "./memory-contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Store root resolution
// ---------------------------------------------------------------------------

async function loadStoreRootHelper() {
  const candidates = [
    path.join(__dirname, "store-root.js"),
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    path.join(__dirname, "..", "bus", "store-root.js"),
    path.join(__dirname, "bus", "store-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }

  throw new Error(`store-root-helper-missing: tried ${candidates.join(", ")}`);
}

const resolveStoreRootMod = await loadStoreRootHelper();
const resolveStoreRoot = resolveStoreRootMod.resolveStoreRoot || resolveStoreRootMod;

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, ".openclaw");
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(USER_HOME, ".claude");

const STORE_ROOT = resolveStoreRoot(); // e.g. "E:\\.ai-memory"
const AI_MEMORY_ROOT = STORE_ROOT;
const INBOX_ROOT = path.join(AI_MEMORY_ROOT, "inbox");
const EVENTS_ROOT = path.join(AI_MEMORY_ROOT, "events");
const STRUCTURED_ROOT = path.join(AI_MEMORY_ROOT, "structured");
const GENERATED_ROOT = path.join(AI_MEMORY_ROOT, "generated");
const MEMORY_LAYERS_MD = path.join(GENERATED_ROOT, "MEMORY-LAYERS.md");
const MEMORY_LAYERS_JSON = path.join(GENERATED_ROOT, "MEMORY-LAYERS.json");
const GLOBAL_CONTEXT_MD = path.join(GENERATED_ROOT, "GLOBAL-CONTEXT.md");
const GLOBAL_CONTEXT_META_JSON = path.join(GENERATED_ROOT, "GLOBAL-CONTEXT.meta.json");
// Body file: the full token-budgeted memory content.
// memory-bus.ps1 reads this and wraps it in the outer GLOBAL-CONTEXT.md header
// to avoid a read/write cycle on the same file path.
const GLOBAL_CONTEXT_BODY_MD = path.join(GENERATED_ROOT, "GLOBAL-CONTEXT.body.md");
const SHARED_INBOX_JSONL = path.join(STRUCTURED_ROOT, "shared-inbox.jsonl");
const DREAM_INBOX_JSONL = path.join(STRUCTURED_ROOT, "dream-inbox.jsonl");
const SESSION_MEMORY_JSONL = path.join(STRUCTURED_ROOT, "session-memory.jsonl");
const SHARED_EVENTS_JSONL = path.join(STRUCTURED_ROOT, "shared-events.jsonl");
const TASK_MEMORY_JSONL = path.join(STRUCTURED_ROOT, "task-memory.jsonl");
const CLAUDE_CODE_JSONL = path.join(STRUCTURED_ROOT, "claude-code.jsonl");
const OPENCLAW_SESSIONS_JSONL = path.join(STRUCTURED_ROOT, "openclaw.jsonl");
const OPENCLAW_BLACKBOARD_JSONL = path.join(STRUCTURED_ROOT, "openclaw-blackboard.jsonl");
const OPENCLAW_RUNS_JSONL = path.join(STRUCTURED_ROOT, "openclaw-runs.jsonl");
const OPENCLAW_JOBS_JSONL = path.join(STRUCTURED_ROOT, "openclaw-jobs.jsonl");
const OPENCLAW_JOURNAL_JSONL = path.join(STRUCTURED_ROOT, "openclaw-journal.jsonl");
const DAILY_LOG_DIR = path.join(STRUCTURED_ROOT, "logs");
const PROJECTS_ROOT = path.join(AI_MEMORY_ROOT, "projects");

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
// Core I/O helpers
// ---------------------------------------------------------------------------

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, content) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function ensureDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File locking
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock on a file, execute fn, then unlock and close.
 * Uses exponential backoff (100ms, 200ms, 400ms) up to 3 retries.
 * Falls back to lock-free atomic write when tryLockSync is unavailable (e.g. some Windows builds).
 * @param {string} filePath
 * @param {function(number): void} fn  - receives the file descriptor
 */
function withFileLock(filePath, fn) {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 100;

  // Detect availability of tryLockSync (not available on some Node.js/Windows builds)
  const supportsTryLock = typeof fs.tryLockSync === "function";

  if (!supportsTryLock) {
    // Fallback: use a cross-process lock file (.lock suffix) as semaphore.
    // The lock is advisory — all concurrent writers must cooperate.
    const lockFile = `${filePath}.lock`;
    let lockFd = null;
    let attempt = 0;

    const wait = (delay) => {
      const start = Date.now();
      while (Date.now() - start < delay) { /* spin */ }
    };

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        // Ensure the target file exists (create it if needed)
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, "", "utf8");
        }
        // Try to create/open the lock file exclusively
        lockFd = fs.openSync(lockFile, "w+");
        // If the lock file is non-empty, another process holds the lock
        const content = fs.readFileSync(lockFile, "utf8");
        if (content && content.trim()) {
          // Another process holds the lock
          fs.closeSync(lockFd);
          lockFd = null;
          if (attempt < MAX_RETRIES) {
            wait(BASE_DELAY_MS * Math.pow(2, attempt - 1));
          }
          continue;
        }
        // Write PID as lock token
        fs.writeFileSync(lockFile, `${process.pid}`, "utf8");
        try {
          fn(-1);  // no valid fd in fallback mode
          return;
        } finally {
          try { fs.unlinkSync(lockFile); } catch {}
          if (lockFd !== null) {
            try { fs.closeSync(lockFd); } catch {}
          }
        }
      } catch (err) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `[withFileLock] could not acquire lock on ${filePath} after ${MAX_RETRIES} attempts: ${err.message}`
          );
        }
        if (lockFd !== null) {
          try { fs.closeSync(lockFd); } catch {}
        }
        lockFd = null;
        wait(BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
    throw new Error(`[withFileLock] could not acquire lock on ${filePath}: lock held after ${MAX_RETRIES} retries`);
  }

  // Primary path: use native tryLockSync / unlockSync
  let fd = null;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      fd = fs.openSync(filePath, "r+");
      if (fs.tryLockSync(fd, "ex")) {
        try {
          fn(fd);
          return;
        } finally {
          try { fs.unlockSync(fd); } catch {}
          try { fs.closeSync(fd); } catch {}
        }
      } else {
        // Lock held by another process — close and retry with backoff
        try { fs.closeSync(fd); } catch {}
        fd = null;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          const start = Date.now();
          while (Date.now() - start < delay) { /* spin */ }
        }
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet — create it with 'w' flag, lock, then proceed
        try {
          fd = fs.openSync(filePath, "w");
          if (fs.tryLockSync(fd, "ex")) {
            try {
              fn(fd);
              return;
            } finally {
              try { fs.unlockSync(fd); } catch {}
              try { fs.closeSync(fd); } catch {}
            }
          } else {
            try { fs.closeSync(fd); } catch {}
          }
        } catch {}
      }
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `[withFileLock] could not acquire lock on ${filePath} after ${MAX_RETRIES} attempts: ${err.message}`
        );
      }
      try { if (fd) fs.closeSync(fd); } catch {}
      fd = null;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const start = Date.now();
      while (Date.now() - start < delay) { /* spin */ }
    }
  }

  throw new Error(
    `[withFileLock] could not acquire lock on ${filePath}: lock held after ${MAX_RETRIES} retries`
  );
}

// ---------------------------------------------------------------------------
// @include directive resolver
// ---------------------------------------------------------------------------

/**
 * Resolve @include directives in markdown content.
 * Syntax: @include filename.md
 * Resolves relative to baseDir.
 * Nested @include supported up to depth 5.
 *
 * @param {string} content
 * @param {string} baseDir  - directory to resolve relative paths against
 * @param {number} [maxDepth=5]
 * @param {number} [currentDepth=0]
 * @returns {{ content: string, includes_resolved: string[], depth: number }}
 */
function resolveIncludes(content, baseDir, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) {
    process.stderr.write(`[resolve-include] max depth ${maxDepth} reached, stopping\n`);
    return { content, includes_resolved: [], depth: currentDepth };
  }

  const includePattern = /^@include\s+(.+)$/gm;
  const includes_resolved = [];
  let resolved = content;
  let match;

  // Reset lastIndex before iteration
  includePattern.lastIndex = 0;
  while ((match = includePattern.exec(content)) !== null) {
    const includePath = match[1].trim();
    const fullPath = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(baseDir, includePath);

    if (!fs.existsSync(fullPath)) {
      process.stderr.write(`[resolve-include] file not found: ${fullPath}\n`);
      continue;
    }

    let includedContent;
    try {
      includedContent = fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      process.stderr.write(`[resolve-include] read error ${fullPath}: ${err.message}\n`);
      continue;
    }

    includes_resolved.push(includePath);

    // Recursively resolve nested includes
    const nested = resolveIncludes(
      includedContent,
      path.dirname(fullPath),
      maxDepth,
      currentDepth + 1
    );

    resolved = resolved.replace(match[0], nested.content);
    includes_resolved.push(...nested.includes_resolved);
  }

  return { content: resolved, includes_resolved, depth: currentDepth };
}

// ---------------------------------------------------------------------------
// Entity extraction helpers (lazy-loaded, no external dependencies)
// ---------------------------------------------------------------------------

/** @returns {Promise<{ extractFromRecord: (r: object) => object }>} */
async function loadEntityExtractor() {
  try {
    const moduleUrl = new URL("../entity/entity-extractor.js", import.meta.url);
    const mod = await import(moduleUrl.href);
    return mod.default || mod;
  } catch (error) {
    return {
      available: false,
      error: String(error?.message || error),
      extractFromRecord: (r) => r,
    };
  }
}

/** @returns {Promise<{ ingestRecord: (r: object) => void, close: () => void }>} */
async function loadKnowledgeGraph() {
  try {
    const moduleUrl = new URL("../knowledge/knowledge-graph.js", import.meta.url);
    const { KnowledgeGraph } = await import(moduleUrl.href);
    return new KnowledgeGraph({ storeRoot: STORE_ROOT });
  } catch (error) {
    return {
      available: false,
      error: String(error?.message || error),
      ingestRecord: () => {},
      beginBatch: () => {},
      endBatch: () => {},
      close: () => {},
      stats: () => ({ entities: 0, triples: 0, currentFacts: 0, expiredFacts: 0 }),
    };
  }
}

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
  if (ageMs <= 24 * 60 * 60 * 1000) {
    return "hot";
  }
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
    return "warm";
  }
  return "cold";
}

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9\u4e00-\u9fff_./:-]{2,}/g) || []);
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
  return text.replace(/[#*`_~\[\]]/g, "").replace(/\s+/g, " ").trim();
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
    } catch (_error) {
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

// ---------------------------------------------------------------------------
// Entry parsers
// ---------------------------------------------------------------------------

function parseInboxEntries() {
  const records = [];
  if (!fs.existsSync(INBOX_ROOT)) {
    return records;
  }

  const linePattern = /^-\s+\[(?<timestamp>[^\]]+)\]\s+\[(?<project>[^\]]+)\]\s*(?<content>.+)$/;
  const files = fs
    .readdirSync(INBOX_ROOT)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort();

  for (const fileName of files) {
    const tool = path.basename(fileName, ".md");
    const filePath = path.join(INBOX_ROOT, fileName);
    const lines = readText(filePath).split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(linePattern);
      if (!match || !match.groups) {
        continue;
      }
      const timestamp = parseTimestamp(match.groups.timestamp);
      const project = normalizeSpaces(match.groups.project);
      const content = match.groups.content.trim();
      const classification = classifyScope(content, tool);
      const id = `inbox-${sha1(`${tool}|${project}|${match.groups.timestamp}|${content}`)}`;
      const contentHash = sha256(content);
      records.push(
        buildRecord({
          id,
          t: timestamp,
          tool,
          type: classification.type,
          project,
          title: content,
          content,
          source: "shared-inbox",
          scope: classification.scope,
          visibility: classification.visibility,
          source_kind: "writeback",
          memory_level: "durable",
          workspace: project,
          confidence: classification.confidence,
          metadata: {
            origin_path: filePath,
          },
          content_hash: contentHash,
        })
      );
    }
  }

  return records.sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function parseEventEntries() {
  const records = [];
  if (!fs.existsSync(EVENTS_ROOT)) {
    return records;
  }

  const files = fs
    .readdirSync(EVENTS_ROOT)
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort()
    .slice(-2);

  for (const fileName of files) {
    const filePath = path.join(EVENTS_ROOT, fileName);
    const lines = readText(filePath).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const tool = normalizeSpaces(payload.tool || "system") || "system";
      const project = normalizeSpaces(payload.project || "");
      const content = normalizeSpaces(payload.summary || "");
      if (!content) {
        continue;
      }
      const classification = classifyScope(content, tool);
      const id = `event-${sha1(`${tool}|${payload.timestamp}|${content}`)}`;
      records.push(
        buildRecord({
          id,
          t: payload.timestamp || null,
          tool,
          type: classification.type,
          project,
          title: content,
          content,
          source: "memory-bus-event",
          scope: classification.scope,
          visibility: "shared",
          source_kind: "hook",
          memory_level: "session",
          workspace: project,
          confidence: classification.confidence,
          metadata: {
            origin_path: filePath,
          },
        })
      );
    }
  }

  return records.sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

async function parseSessionMemoryEntries() {
  const records = [];

  const claudeSessionPath = path.join(CLAUDE_HOME, "session-memory", "session-memory.md");
  if (fs.existsSync(claudeSessionPath)) {
    const content = readText(claudeSessionPath).trim();
    if (content) {
      const stat = fs.statSync(claudeSessionPath);
      records.push(
        buildRecord({
          id: `session-${sha1(`claude|${stat.mtimeMs}|${content.slice(0, 256)}`)}`,
          t: stat.mtime.toISOString(),
          tool: "claude-code",
          type: "session-summary",
          project: "shared-session",
          title: "Claude session memory snapshot",
          content: content.slice(0, 6000),
          source: "claude-session-memory",
          scope: "summary",
          visibility: "shared",
          source_kind: "session",
          memory_level: "session",
          workspace: "claude-session",
          confidence: 0.78,
          metadata: {
            origin_path: claudeSessionPath,
          },
        })
      );
    }
  }

  const openclawMemoryDir = path.join(OPENCLAW_HOME, "workspace", "memory");
  if (fs.existsSync(openclawMemoryDir)) {
    const files = fs
      .readdirSync(openclawMemoryDir)
      .filter((fileName) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(fileName))
      .sort()
      .slice(-7);
    for (const fileName of files) {
      const filePath = path.join(openclawMemoryDir, fileName);
      const content = readText(filePath).trim();
      if (!content) {
        continue;
      }
      const stat = fs.statSync(filePath);
      records.push(
        buildRecord({
          id: `session-${sha1(`openclaw|${fileName}|${stat.mtimeMs}`)}`,
          t: stat.mtime.toISOString(),
          tool: "openclaw",
          type: "daily-summary",
          project: "workspace",
          title: `OpenClaw daily memory ${path.basename(fileName, ".md")}`,
          content: content.slice(0, 6000),
          source: "openclaw-daily-memory",
          scope: "summary",
          visibility: "shared",
          source_kind: "session",
          memory_level: "session",
          workspace: "openclaw-workspace",
          confidence: 0.72,
          metadata: {
            origin_path: filePath,
          },
        })
      );
    }
  }

  // Stream structured JSONL files — never load entire files into memory.
  // Uses createJsonlStream + coerceStructuredRecord (same coercion logic as
  // parseStructuredJsonl but in a memory-efficient streaming mode).
  const [claudeRecords, openclawRecords] = await Promise.all([
    loadStructuredRecords(CLAUDE_CODE_JSONL, {
      prefix: "claude-import",
      tool: "claude-code",
      source: "claude-mem",
      scope: "summary",
      visibility: "shared",
      source_kind: "session",
      memory_level: "session",
      workspace: "claude-session",
      confidence: 0.72,
    }),
    loadStructuredRecords(OPENCLAW_SESSIONS_JSONL, {
      prefix: "openclaw-session",
      tool: "openclaw",
      source: "openclaw-session",
      scope: "summary",
      visibility: "shared",
      source_kind: "session",
      memory_level: "session",
      workspace: "openclaw-workspace",
      confidence: 0.62,
    }),
  ]);

  const merged = new Map();
  for (const record of [...records, ...claudeRecords, ...openclawRecords]) {
    merged.set(record.id, record);
  }

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

/**
 * Async streaming version of parseTaskMemoryEntries.
 * Uses createJsonlStream to avoid loading large openclaw JSONL files into memory.
 * Parallel-loads all four source files for performance.
 */
async function parseTaskMemoryEntries() {
  const sources = [
    {
      filePath: OPENCLAW_BLACKBOARD_JSONL,
      defaults: {
        prefix: "task",
        source: "openclaw-blackboard",
        scope: "task",
        source_kind: "blackboard",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_RUNS_JSONL,
      defaults: {
        prefix: "run",
        source: "openclaw-run-ledger",
        scope: "run",
        source_kind: "run",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_JOBS_JSONL,
      defaults: {
        prefix: "job",
        source: "openclaw-cron-job",
        scope: "task",
        source_kind: "cron",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_JOURNAL_JSONL,
      defaults: {
        prefix: "journal",
        source: "openclaw-blackboard-journal",
        scope: "run",
        source_kind: "blackboard",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
  ];

  // Stream all four source files in parallel — each uses createJsonlStream
  // internally so no single file is fully buffered in memory.
  const sourceArrays = await Promise.all(
    sources.map((src) => loadStructuredRecords(src.filePath, src.defaults))
  );

  const merged = new Map();
  for (const records of sourceArrays) {
    for (const record of records) {
      merged.set(record.id, record);
    }
  }

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function preserveDreamRecords(existingRecords) {
  // Preserve records written by run-memory-dream.ps1 (source_kind=writeback)
  // so they are not wiped when build-memory-layers.js overwrites shared-inbox.jsonl
  return existingRecords.filter(
    (record) =>
      record &&
      (record.source_kind === "writeback" || (record.id && String(record.id).startsWith("dream-")))
  );
}

/**
 * Get the target JSONL file path for a record based on its memory_level/scope.
 * @param {object} record
 * @returns {string|null}
 */
function getTargetJsonl(record) {
  const scope = record.scope || "";
  const level = record.memory_level || record.memoryLevel || "";
  if (scope === "session" || level === "session") return SESSION_MEMORY_JSONL;
  if (scope === "task" || level === "task" || record.type === "task-note" || record.type === "task-job")
    return TASK_MEMORY_JSONL;
  if (record.type === "event" || scope === "event") return SHARED_EVENTS_JSONL;
  return SHARED_INBOX_JSONL;
}

export {
  // I/O
  readJsonl, readText, writeText, ensureDirectory, withFileLock,
  // Parsers
  parseInboxEntries, parseEventEntries, parseSessionMemoryEntries, parseTaskMemoryEntries,
  // Structured record
  parseStructuredJsonl, coerceStructuredRecord, repairStructuredRecord, preserveDreamRecords,
  // Async streaming
  loadStructuredRecords,
  // Helpers
  loadEntityExtractor, loadKnowledgeGraph,
  // Utility
  normalizeSpaces, sha1, sha256, parseTimestamp, tokenize,
  classifyScope, buildPromotionKey, buildPromotionMetadata, buildMemoryDescription,
  computeTier, buildRecord, getTargetJsonl,
  getFreshness, shouldSkipAsRecentDuplicate, resolveIncludes,
  // Constants
  USER_HOME, OPENCLAW_HOME, CLAUDE_HOME,
  INBOX_ROOT, EVENTS_ROOT, STRUCTURED_ROOT, GENERATED_ROOT, STORE_ROOT, AI_MEMORY_ROOT,
  SHARED_INBOX_JSONL, DREAM_INBOX_JSONL, SESSION_MEMORY_JSONL, SHARED_EVENTS_JSONL,
  TASK_MEMORY_JSONL, CLAUDE_CODE_JSONL, OPENCLAW_SESSIONS_JSONL,
  OPENCLAW_BLACKBOARD_JSONL, OPENCLAW_RUNS_JSONL, OPENCLAW_JOBS_JSONL, OPENCLAW_JOURNAL_JSONL,
  DAILY_LOG_DIR, PROJECTS_ROOT,
  MEMORY_LAYERS_MD, MEMORY_LAYERS_JSON, GLOBAL_CONTEXT_MD,
  GLOBAL_CONTEXT_META_JSON, GLOBAL_CONTEXT_BODY_MD,
  MIN_PROMOTION_CONFIDENCE, DURABLE_SCOPES,
  NON_PROMOTABLE_PROMOTION_TYPES,
  MEMORY_RECORD_SCHEMA_VERSION,
  buildGeneratedArtifactMetadata,
};
