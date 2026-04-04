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

function deduplicateSharedInbox(newInboxEntries, dreamRecords) {
  // Build dedup map from inbox entries (inbox entries take priority:
  // they reflect latest inbox content; dream records are append-only)
  const byId = new Map();
  for (const rec of newInboxEntries) {
    if (rec && rec.id) byId.set(rec.id, rec);
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

  const layers = {
    sharedInbox: deduplicateSharedInbox(newInboxEntries, dreamRecords),
    sessionMemory: parseSessionMemoryEntries(),
    sharedEvents: parseEventEntries(),
    taskMemory: parseTaskMemoryEntries(),
  };

  writeJsonl(SHARED_INBOX_JSONL, layers.sharedInbox);
  writeJsonl(SESSION_MEMORY_JSONL, layers.sessionMemory);
  writeJsonl(SHARED_EVENTS_JSONL, layers.sharedEvents);
  writeJsonl(TASK_MEMORY_JSONL, layers.taskMemory);

  const summary = buildLayerSummary(layers);
  writeText(MEMORY_LAYERS_MD, summary.markdown);
  writeText(MEMORY_LAYERS_JSON, `${JSON.stringify(summary.json, null, 2)}\n`);

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
        },
      },
      null,
      2
    )
  );
}

main();
