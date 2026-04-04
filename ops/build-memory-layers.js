const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  buildGeneratedArtifactMetadata,
  MEMORY_RECORD_SCHEMA_VERSION,
} = require("./memory-contract.js");

function loadVaultRootHelper() {
  const candidates = [
    path.join(__dirname, "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
    path.join(__dirname, "bus", "vault-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`vault-root-helper-missing: tried ${candidates.join(", ")}`);
}

const { resolveVaultRoot } = loadVaultRootHelper();

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, ".openclaw");
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(USER_HOME, ".claude");

const VAULT_ROOT = resolveVaultRoot();
const AI_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
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
// Format: logs/YYYY/MM/YYYY-MM-DD.jsonl  (one file per day)
const MIN_PROMOTION_CONFIDENCE = 0.6;
const DURABLE_SCOPES = new Set(["user", "feedback", "project", "reference"]);

// Token-budget and progressive-rendering config for GLOBAL-CONTEXT.md generation
const CONTEXT_LIMITS = {
  user: 5,          // max user records to display
  feedback: 5,
  project: 8,
  reference: 8,
  event_task: 8,    // combined event + task
  estimated_chars_per_token: 4,
  max_file_size_chars: 8000, // warn if exceeded
};
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

function preserveDreamRecords(existingRecords) {
  // Preserve records written by run-memory-dream.ps1 (source_kind=writeback)
  // so they are not wiped when build-memory-layers.js overwrites shared-inbox.jsonl
  return existingRecords.filter(
    (record) =>
      record &&
      (record.source_kind === "writeback" || (record.id && String(record.id).startsWith("dream-")))
  );
}

function ensureDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
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

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function getFreshness(isoTimestamp) {
  if (!isoTimestamp) {
    return "unknown";
  }
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ageMs)) {
    return "unknown";
  }
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

function buildPromotionKey({ durableType = "", project = "", workspace = "", title = "", content = "" } = {}) {
  const normalizedProject = normalizeSpaces(project || workspace).toLowerCase();
  const text = normalizeSpaces([title, content].filter(Boolean).join(" ")).toLowerCase();
  const tokens = tokenize(text)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 18);

  if (!durableType || tokens.length === 0) {
    return "";
  }

  return sha1(`${durableType}|${normalizedProject}|${tokens.join(" ")}`);
}

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
} = {}) {
  const normalizedScope = normalizeSpaces(scope).toLowerCase();
  const normalizedType = normalizeSpaces(type).toLowerCase();
  const normalizedSourceKind = normalizeSpaces(sourceKind).toLowerCase();
  const normalizedMemoryLevel = normalizeSpaces(memoryLevel).toLowerCase();
  const normalizedText = normalizeSpaces([title, content].filter(Boolean).join(" "));
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
    project,
    workspace,
    title,
    content,
  });

  return {
    version: 1,
    durable_type: durableType,
    key,
    reason,
    source_type: normalizedType,
    source_confidence: numericConfidence || 0,
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
    }),
  };
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
  };
}

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

function parseSessionMemoryEntries() {
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

  const importedStructuredRecords = [
    ...parseStructuredJsonl(CLAUDE_CODE_JSONL, {
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
    ...parseStructuredJsonl(OPENCLAW_SESSIONS_JSONL, {
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
  ];

  const merged = new Map();
  [...records, ...importedStructuredRecords].forEach((record) => {
    merged.set(record.id, record);
  });

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

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
  };
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

function parseTaskMemoryEntries() {
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

  const merged = new Map();
  for (const source of sources) {
    for (const record of parseStructuredJsonl(source.filePath, source.defaults)) {
      merged.set(record.id, record);
    }
  }

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function writeJsonl(filePath, records) {
  ensureDirectory(path.dirname(filePath));
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeText(filePath, body ? `${body}\n` : "");
}

// ---------------------------------------------------------------------------
// Daily append-only logs  (immutable helpers + side-effecting append)
// ---------------------------------------------------------------------------

/**
 * Groups records by date (YYYY-MM-DD from field t).
 * Returns Map<dateString, record[]> sorted newest-first.
 * Pure function — does not mutate records.
 */
function getRecordsByDate(records) {
  const byDate = new Map();
  for (const rec of records) {
    const t = rec.t || rec.created_at || "";
    const dateMatch = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(rec);
  }
  return byDate;
}

/**
 * Converts a record to a compact daily-log entry (one JSON line).
 * Pure function — returns a new object, does not mutate rec.
 */
function buildDailyLogEntry(record) {
  const firstFact = Array.isArray(record.facts) ? record.facts[0] : null;
  const summary =
    (typeof firstFact === "string" && firstFact.trim()) ||
    (typeof record.description === "string" && record.description.trim()) ||
    (String(record.content || "").substring(0, 80).trim()) ||
    "";
  return {
    id: record.id || "",
    t: record.t || record.created_at || "",
    type: record.type || "",
    scope: record.scope || "",
    tool: record.tool || "",
    title: record.title || "",
    summary,
    promotion: (record.metadata && record.metadata.promotion && record.metadata.promotion.durable_type) || null,
    content_hash: record.content_hash || "",
  };
}

/**
 * Appends new records to daily log files (logs/YYYY/MM/YYYY-MM-DD.jsonl).
 * Only appends records from today and yesterday — never rewrites history.
 * Uses atomic write: write to .tmp, fsync, rename.
 *
 * @param {object[]} newRecords - All records to consider (all layers combined).
 * @param {boolean} dryRun - If true, only log what would be written.
 */
function appendDailyLogs(newRecords, dryRun = false) {
  const recordsByDate = getRecordsByDate(newRecords);
  const now = new Date();
  const today = now.toISOString().substring(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().substring(0, 10);
  const targetDates = new Set([today, yesterday]);

  for (const [date, recs] of recordsByDate.entries()) {
    if (!targetDates.has(date)) continue; // Only append recent days

    const [year, month] = date.split("-");
    const logDir = path.join(DAILY_LOG_DIR, year, month);
    const logFile = path.join(logDir, `${date}.jsonl`);
    const tmpFile = `${logFile}.tmp.${process.pid}`;

    // Read existing entry IDs for this date (to avoid duplicates by id)
    const existingIds = new Set();
    if (fs.existsSync(logFile)) {
      const existing = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
      for (const line of existing) {
        try {
          existingIds.add(JSON.parse(line).id);
        } catch {
          // skip malformed lines
        }
      }
    }

    // Filter out already-logged records
    const newEntries = recs.filter((r) => !existingIds.has(r.id)).map(buildDailyLogEntry);

    if (newEntries.length === 0) continue;

    if (dryRun) {
      process.stderr.write(`[daily-log] dry-run: would append ${newEntries.length} entries to ${logFile}\n`);
      continue;
    }

    // Ensure log directory exists before any file I/O
    ensureDirectory(logDir);

    // Atomic write: read existing, append to temp, fsync, rename
    const existingContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const newLines = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(tmpFile, existingContent + newLines, "utf8");
    fs.fsyncSync(fs.openSync(tmpFile, "r+"));
    fs.renameSync(tmpFile, logFile);
    process.stderr.write(`[daily-log] appended ${newEntries.length} entries to ${logFile}\n`);
  }
}

// ---------------------------------------------------------------------------
// Token-budget and progressive-rendering helpers (immutable)
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a record using char_count / chars_per_token.
 * Returns a new summary object — does not mutate the original record.
 */
function withTokenEstimate(record) {
  const charCount = String(record.content || "").length;
  const estimatedTokens = Math.ceil(charCount / CONTEXT_LIMITS.estimated_chars_per_token);
  // Return a new summary object with the extra field
  return {
    id: record.id,
    title: record.title,
    scope: record.scope,
    freshness: record.freshness,
    estimatedTokens,
    charCount,
  };
}

/**
 * Freshness score for sorting: higher = more important to show.
 * Returns a new value — does not mutate anything.
 */
function freshnessScore(record) {
  switch (record.freshness) {
    case "hot":   return 3;
    case "warm":  return 2;
    case "cold":  return 1;
    default:      return 0;
  }
}

/**
 * Sort records by freshness desc, then timestamp desc.
 * Returns a new sorted array — does not mutate the input.
 */
function sortByFreshnessDesc(records) {
  return [...records].sort((left, right) => {
    const scoreDiff = freshnessScore(right) - freshnessScore(left);
    if (scoreDiff !== 0) return scoreDiff;
    return String(right.t || "").localeCompare(String(left.t || ""));
  });
}

/**
 * Build per-segment summaries with token budgets from the memory layers.
 * Returns a new object — does not mutate the input layers.
 *
 * Segments:
 *   user       — durable records with scope === "user"
 *   feedback   — durable records with scope === "feedback"
 *   project    — durable records with scope === "project"
 *   reference  — durable records with scope === "reference"
 *   event_task — combined sharedEvents + taskMemory (scopes: event, task, run, job)
 */
function buildScopedSummaries(layers) {
  const allRecords = [
    ...(layers.sharedInbox || []),
    ...(layers.sessionMemory || []),
    ...(layers.sharedEvents || []),
    ...(layers.taskMemory || []),
  ];

  const segments = {
    user: {
      name: "用户偏好（user）",
      scope: ["user"],
      budget: CONTEXT_LIMITS.user,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "user")
      ),
    },
    feedback: {
      name: "反馈与规则（feedback）",
      scope: ["feedback"],
      budget: CONTEXT_LIMITS.feedback,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "feedback")
      ),
    },
    project: {
      name: "项目上下文（project）",
      scope: ["project"],
      budget: CONTEXT_LIMITS.project,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "project")
      ),
    },
    reference: {
      name: "参考与链接（reference）",
      scope: ["reference"],
      budget: CONTEXT_LIMITS.reference,
      records: sortByFreshnessDesc(
        allRecords.filter((r) => (r.scope || "") === "reference")
      ),
    },
    event_task: {
      name: "事件与任务（event/task）",
      scope: ["event", "task", "run", "job", "journal"],
      budget: CONTEXT_LIMITS.event_task,
      records: sortByFreshnessDesc(
        allRecords.filter((r) =>
          ["event", "task", "run", "job", "journal"].includes(r.scope || "")
        )
      ),
    },
  };

  // Compute token estimates for all records and detect truncation per segment
  let totalRecords = 0;
  let estimatedTotalTokens = 0;
  let anyTruncated = false;

  for (const segment of Object.values(segments)) {
    const estimated = segment.records.map(withTokenEstimate);
    estimatedTotalTokens += estimated.reduce((sum, r) => sum + r.estimatedTokens, 0);
    totalRecords += segment.records.length;

    if (estimated.length > segment.budget) {
      anyTruncated = true;
      segment.displayedRecords = estimated.slice(0, segment.budget);
      segment.truncatedCount = estimated.length - segment.budget;
    } else {
      segment.displayedRecords = estimated;
      segment.truncatedCount = 0;
    }
  }

  return { segments, totalRecords, estimatedTotalTokens, anyTruncated };
}

/**
 * Render one markdown segment section.
 * Pure function — returns new strings, mutates nothing.
 */
function renderSegmentMarkdown(segment) {
  const lines = [`## ${segment.name}`, ""];

  if (segment.displayedRecords.length === 0) {
    lines.push("（暂无记录）", "");
    return lines.join("\n");
  }

  for (const record of segment.displayedRecords) {
    lines.push(`- **${record.title}** _[~${record.estimatedTokens} tokens]_`);
  }

  if (segment.truncatedCount > 0) {
    const totalTokens = segment.displayedRecords.reduce((s, r) => s + r.estimatedTokens, 0);
    lines.push(`- _... 还有 ${segment.truncatedCount} 条记录，估算 ${totalTokens} tokens，超出显示预算_`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build GLOBAL-CONTEXT.md and GLOBAL-CONTEXT.meta.json from memory layers.
 * Returns a new object { markdown, meta } — does not mutate layers.
 */
function buildGlobalContext(layers) {
  const generatedAt = new Date().toISOString();
  const { segments, totalRecords, estimatedTotalTokens, anyTruncated } =
    buildScopedSummaries(layers);

  // Accumulate markdown sections
  const headerComment = [
    `<!-- GLOBAL-CONTEXT: generated at ${generatedAt} -->`,
    `<!-- total_records: ${totalRecords} | estimated_total_tokens: ${estimatedTotalTokens} | budgeted_display_tokens: ${CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token} -->`,
    "",
  ].join("\n");

  const lines = [
    "# Shared AI Memory — Global Context",
    "",
    `> Generated at: ${generatedAt}`,
    `> Token budget: ${CONTEXT_LIMITS.max_file_size_chars} chars / ~${Math.round(CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token)} tokens  ·  ${totalRecords} records in store · ~${estimatedTotalTokens} estimated tokens`,
    "",
  ];

  lines.push(renderSegmentMarkdown(segments.user));
  lines.push(renderSegmentMarkdown(segments.feedback));
  lines.push(renderSegmentMarkdown(segments.project));
  lines.push(renderSegmentMarkdown(segments.reference));
  lines.push(renderSegmentMarkdown(segments.event_task));

  // Long-term accumulation footer
  lines.push("## 长期积累", "");
  const remainingByScope = {};
  for (const [key, seg] of Object.entries(segments)) {
    if (seg.truncatedCount > 0) {
      remainingByScope[key] = seg.truncatedCount;
    }
  }
  const remainingTotal = Object.values(remainingByScope).reduce((s, n) => s + n, 0);
  if (remainingTotal > 0) {
    lines.push(
      `> 还有 ${remainingTotal} 条记录超出显示预算，保存在结构化存储中：`,
      Object.entries(remainingByScope)
        .map(([k, n]) => `- ${k}: ${n} 条`)
        .join("\n"),
      "",
      "完整记录请查看 `00-System/ai-memory/structured/` 下的 JSONL 文件。",
      ""
    );
  } else {
    lines.push("（所有记录均已在上面展示）", "");
  }

  const markdown = headerComment + lines.join("\n");

  // Size warning
  if (markdown.length > CONTEXT_LIMITS.max_file_size_chars) {
    process.stderr.write(
      `[build-global-context] WARNING: GLOBAL-CONTEXT.md (${markdown.length} chars) exceeds ` +
        `soft limit of ${CONTEXT_LIMITS.max_file_size_chars} chars.\n`
    );
  }

  // Build meta JSON (immutable — constructed from scratch)
  const metaSegments = Object.entries(segments).map(([key, seg]) => ({
    name: seg.name,
    scope: seg.scope,
    budget: seg.budget,
    totalCount: seg.records.length,
    displayedRecords: seg.displayedRecords.map((r) => ({
      id: r.id,
      title: r.title,
      scope: r.scope,
      freshness: r.freshness,
      estimatedTokens: r.estimatedTokens,
    })),
    truncated: seg.truncatedCount > 0,
    truncatedCount: seg.truncatedCount,
  }));

  const meta = {
    generatedAt,
    totalRecords,
    estimatedTotalTokens,
    budgetedDisplayTokens: Math.round(CONTEXT_LIMITS.max_file_size_chars / CONTEXT_LIMITS.estimated_chars_per_token),
    fileSizeChars: markdown.length,
    truncated: anyTruncated,
    segments: metaSegments,
  };

  return { markdown, meta, bodyMarkdown: markdown };
}

function buildScopeCounts(records) {
  const counts = {};
  for (const record of records) {
    const scope = normalizeSpaces(record.scope || "summary") || "summary";
    counts[scope] = (counts[scope] || 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
  );
}

function buildScopedHighlights(records, limitPerScope = 3) {
  const grouped = {};
  const ordered = [...records].sort((left, right) => String(right.t || "").localeCompare(String(left.t || "")));

  for (const record of ordered) {
    const scope = normalizeSpaces(record.scope || "summary") || "summary";
    if (!grouped[scope]) {
      grouped[scope] = [];
    }
    if (grouped[scope].length >= limitPerScope) {
      continue;
    }
    grouped[scope].push({
      tool: record.tool,
      scope: record.scope,
      title: record.title,
      t: record.t,
    });
  }

  return Object.fromEntries(
    Object.entries(grouped).sort((left, right) => {
      if (right[1].length !== left[1].length) {
        return right[1].length - left[1].length;
      }
      return left[0].localeCompare(right[0]);
    })
  );
}

// ---------------------------------------------------------------------------
// MEMORY-INDEX.md — rich navigation index
// ---------------------------------------------------------------------------

/**
 * Build MEMORY-INDEX.md — a human-navigable table of all durable memory files.
 * Inspired by restored-cli's MEMORY.md index format.
 *
 * @param {object} layers - the memory layers object
 * @returns {string} markdown content for MEMORY-INDEX.md
 */
function buildMemoryIndex(layers) {
  const durableRecords = [
    ...(layers.sharedInbox || []),
    ...(layers.sessionMemory || []),
    ...(layers.sharedEvents || []),
    ...(layers.taskMemory || []),
  ].filter((r) => r.scope !== "task" && r.scope !== "event");

  // Group by scope
  const byScope = {};
  for (const rec of durableRecords) {
    const scope = normalizeSpaces(rec.scope || "summary") || "summary";
    if (!byScope[scope]) byScope[scope] = [];
    byScope[scope].push(rec);
  }

  const lines = [
    "# Memory Index",
    "",
    `> Auto-generated at ${new Date().toISOString()}`,
    `> ${durableRecords.length} durable records across ${Object.keys(byScope).length} scopes`,
    "",
  ];

  const scopeLabels = {
    user: "用户偏好",
    feedback: "反馈与规则",
    project: "项目上下文",
    reference: "外部引用",
    summary: "会话摘要",
    run: "运行记录",
    job: "任务作业",
    journal: "日志记录",
  };

  for (const [scope, records] of Object.entries(byScope)) {
    const label = scopeLabels[scope] || scope;
    lines.push(`## ${label} (${scope})`);
    lines.push("");

    for (const rec of records.slice(0, 20)) {
      const title = normalizeSpaces(rec.title || rec.id || "(untitled)") || "(untitled)";
      const desc = normalizeSpaces(
        (rec.description || String(rec.content || "").substring(0, 60)).replace(/[#*`_~\[\]]/g, "")
      );
      const id = normalizeSpaces(rec.id || "") || "";
      const slug = id.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 20);
      lines.push(`- [${title}](#${slug}) — ${desc}...`);
    }

    if (records.length > 20) {
      lines.push(`- _... 还有 ${records.length - 20} 条记录_`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 生成文件导航");
  lines.push("");
  lines.push("- [GLOBAL-CONTEXT.body.md](./GLOBAL-CONTEXT.body.md) — 全局上下文主体");
  lines.push("- [AUTO-DREAM.md](./AUTO-DREAM.md) — 梦境整合摘要");
  lines.push("- [HANDOFF.md](./HANDOFF.md) — 交接包");
  lines.push("- [MEMORY-LAYERS.md](./MEMORY-LAYERS.md) — 层级概览");
  lines.push("");
  lines.push("> Memory hygiene stats: see `00-System/ai-memory/generated/memory_hygiene_report.json` if present");

  return lines.join("\n");
}

function buildLayerSummary(layers) {
  const generatedAt = new Date().toISOString();
  const artifactMetadata = buildGeneratedArtifactMetadata({
    structuredRoot: STRUCTURED_ROOT,
    generatedAt,
  });
  const durableByScope = buildScopeCounts(layers.sharedInbox);
  const durableHighlightsByScope = buildScopedHighlights(layers.sharedInbox, 3);
  const lines = [
    "# Memory Layers",
    "",
    `Generated at: ${generatedAt}`,
    "",
    "## Layer Counts",
    "",
    `- shared-inbox: ${layers.sharedInbox.length}`,
    `- session-memory: ${layers.sessionMemory.length}`,
    `- shared-events: ${layers.sharedEvents.length}`,
    `- task-memory: ${layers.taskMemory.length}`,
    "",
    "## Durable By Scope",
    "",
  ];

  const durableScopeEntries = Object.entries(durableByScope);
  if (durableScopeEntries.length === 0) {
    lines.push("- No durable scope coverage yet.");
  } else {
    for (const [scope, count] of durableScopeEntries) {
      lines.push(`- ${scope}: ${count}`);
    }
  }

  lines.push(
    "",
    "## Durable Highlights",
    ""
  );

  const durableHighlights = layers.sharedInbox.slice(-8).reverse();
  if (durableHighlights.length === 0) {
    lines.push("- No durable shared inbox signals yet.");
  } else {
    for (const record of durableHighlights) {
      lines.push(`- [${record.tool}] [${record.scope}] ${record.title}`);
    }
  }

  lines.push("", "## Durable Highlights By Scope", "");
  if (durableScopeEntries.length === 0) {
    lines.push("- No typed durable scope highlights yet.");
  } else {
    for (const [scope, items] of Object.entries(durableHighlightsByScope)) {
      lines.push(`- ${scope}: ${items.length} recent durable highlights`);
      for (const item of items) {
        lines.push(`- [${item.tool}] [${scope}] ${item.title}`);
      }
    }
  }

  lines.push("", "## Session Highlights", "");
  const sessionHighlights = layers.sessionMemory.slice(-6).reverse();
  if (sessionHighlights.length === 0) {
    lines.push("- No session-layer records yet.");
  } else {
    for (const record of sessionHighlights) {
      lines.push(`- [${record.tool}] ${record.title}`);
    }
  }

  lines.push("", "## Event Highlights", "");
  const eventHighlights = layers.sharedEvents.slice(-6).reverse();
  if (eventHighlights.length === 0) {
    lines.push("- No recent shared bus events yet.");
  } else {
    for (const record of eventHighlights) {
      lines.push(`- [${record.tool}] ${record.title}`);
    }
  }

  lines.push("", "## Task Highlights", "");
  const taskHighlights = layers.taskMemory.slice(-8).reverse();
  if (taskHighlights.length === 0) {
    lines.push("- No task-layer records yet.");
  } else {
    for (const record of taskHighlights) {
      const taskState = record.task_state ? ` {${record.task_state}}` : "";
      lines.push(`- [${record.tool}]${taskState} ${record.title}`);
    }
  }

  return {
    markdown: `${lines.join("\n").trim()}\n`,
    json: {
      ...artifactMetadata,
      counts: {
        sharedInbox: layers.sharedInbox.length,
        sessionMemory: layers.sessionMemory.length,
        sharedEvents: layers.sharedEvents.length,
        taskMemory: layers.taskMemory.length,
        durableByScope,
      },
      latest: {
        sharedInbox: durableHighlights.map((record) => ({
          tool: record.tool,
          scope: record.scope,
          title: record.title,
          t: record.t,
        })),
        sessionMemory: sessionHighlights.map((record) => ({
          tool: record.tool,
          title: record.title,
          t: record.t,
        })),
        sharedEvents: eventHighlights.map((record) => ({
          tool: record.tool,
          title: record.title,
          t: record.t,
        })),
        taskMemory: taskHighlights.map((record) => ({
          tool: record.tool,
          taskState: record.task_state,
          title: record.title,
          t: record.t,
        })),
        durableByScope: durableHighlightsByScope,
      },
    },
  };
}

function deduplicateSharedInbox(newInboxEntries, dreamRecords, existingRecordsByHash, nowMs) {
  // Build dedup map from inbox entries (inbox entries take priority:
  // they reflect latest inbox content; dream records are append-only)
  const byId = new Map();
  // Also index new inbox entries by content_hash for the 30s dedup window
  const newByHash = new Map();

  for (const rec of newInboxEntries) {
    if (!rec || !rec.id) continue;

    const hash = rec.content_hash || sha256(rec.content || "");

    // 30-second dedup: skip if a matching hash was written very recently
    if (shouldSkipAsRecentDuplicate(rec, existingRecordsByHash, nowMs)) {
      const existing = existingRecordsByHash.get(hash);
      const existingId = existing ? existing.id : "unknown";
      process.stderr.write(
        `skipping duplicate inbox entry (30s window): ${rec.id} matches ${existingId} ` +
        `(hash: ${hash.substring(0, 8)})\n`
      );
      continue;
    }

    byId.set(rec.id, rec);
    newByHash.set(hash, rec);
  }

  // Append dream records that have unique IDs (not already covered by inbox entries)
  for (const rec of dreamRecords) {
    if (rec && rec.id && !byId.has(rec.id)) byId.set(rec.id, rec);
  }
  return Array.from(byId.values());
}

function main() {
  ensureDirectory(STRUCTURED_ROOT);
  ensureDirectory(GENERATED_ROOT);

  // Read inbox entries from .md files
  const newInboxEntries = parseInboxEntries();

  // Read durable records: shared-inbox.jsonl (inbox entries) + dream-inbox.jsonl (dream writebacks)
  // dream-inbox.jsonl is written by run-memory-dream.ps1 and not regenerated by this script,
  // so dream records survive across build-memory-layers.js runs
  const existingSharedRecords = readJsonl(SHARED_INBOX_JSONL);
  const dreamRecords = readJsonl(DREAM_INBOX_JSONL);

  // Build content_hash -> record index from existing structured records.
  // This is used by the 30-second dedup window in deduplicateSharedInbox.
  const existingRecordsByHash = new Map();
  for (const rec of [...existingSharedRecords, ...dreamRecords]) {
    if (!rec || !rec.id) continue;
    const hash = rec.content_hash || sha256(rec.content || "");
    // Keep the most recent record per hash (by latest t)
    const existing = existingRecordsByHash.get(hash);
    if (!existing) {
      existingRecordsByHash.set(hash, rec);
    } else {
      const existingTs = new Date(existing.t || 0).getTime();
      const recTs = new Date(rec.t || 0).getTime();
      if (recTs > existingTs) {
        existingRecordsByHash.set(hash, rec);
      }
    }
  }

  const nowMs = Date.now();
  const layers = {
    sharedInbox: deduplicateSharedInbox(newInboxEntries, dreamRecords, existingRecordsByHash, nowMs),
    sessionMemory: parseSessionMemoryEntries(),
    sharedEvents: parseEventEntries(),
    taskMemory: parseTaskMemoryEntries(),
  };

  writeJsonl(SHARED_INBOX_JSONL, layers.sharedInbox);
  writeJsonl(SESSION_MEMORY_JSONL, layers.sessionMemory);
  writeJsonl(SHARED_EVENTS_JSONL, layers.sharedEvents);
  writeJsonl(TASK_MEMORY_JSONL, layers.taskMemory);

  // Daily append-only logs (only touches today/yesterday files — never rewrites history)
  const allRecords = [
    ...layers.sharedInbox,
    ...layers.sessionMemory,
    ...layers.sharedEvents,
    ...layers.taskMemory,
  ];
  appendDailyLogs(allRecords);

  const summary = buildLayerSummary(layers);
  writeText(MEMORY_LAYERS_MD, summary.markdown);
  writeText(MEMORY_LAYERS_JSON, `${JSON.stringify(summary.json, null, 2)}\n`);

  // Token-budgeted GLOBAL-CONTEXT body + meta (body is wrapped by memory-bus.ps1)
  const globalContext = buildGlobalContext(layers);

  // Append @include directives so tools that understand the directive can
  // lazily pull in AUTO-DREAM and HANDOFF without duplicating content.
  const bodyWithIncludes = [
    globalContext.bodyMarkdown.trimEnd(),
    "",
    "---",
    "## 更多详情",
    "",
    "@include AUTO-DREAM.md",
    "@include HANDOFF.md",
    "",
  ].join("\n");

  writeText(GLOBAL_CONTEXT_BODY_MD, bodyWithIncludes);
  writeText(GLOBAL_CONTEXT_META_JSON, `${JSON.stringify(globalContext.meta, null, 2)}\n`);

  // Rich navigable MEMORY-INDEX.md
  const memoryIndex = buildMemoryIndex(layers);
  const memoryIndexPath = path.join(GENERATED_ROOT, "MEMORY-INDEX.md");
  writeText(memoryIndexPath, memoryIndex);
  process.stderr.write(`[memory-index] wrote ${memoryIndexPath} (${memoryIndex.length} chars)\n`);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        generatedAt: summary.json.generatedAt,
        counts: summary.json.counts,
        files: {
          sharedInbox: SHARED_INBOX_JSONL,
          sessionMemory: SESSION_MEMORY_JSONL,
          sharedEvents: SHARED_EVENTS_JSONL,
          taskMemory: TASK_MEMORY_JSONL,
          layersMarkdown: MEMORY_LAYERS_MD,
          layersJson: MEMORY_LAYERS_JSON,
          globalContextMarkdown: GLOBAL_CONTEXT_MD,
          globalContextMetaJson: GLOBAL_CONTEXT_META_JSON,
          globalContextBodyMarkdown: GLOBAL_CONTEXT_BODY_MD,
          memoryIndexMarkdown: memoryIndexPath,
        },
      },
      null,
      2
    )
  );
}

main();
