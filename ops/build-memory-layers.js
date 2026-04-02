const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
const SESSION_MEMORY_JSONL = path.join(STRUCTURED_ROOT, "session-memory.jsonl");
const SHARED_EVENTS_JSONL = path.join(STRUCTURED_ROOT, "shared-events.jsonl");

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
  return {
    schemaVersion: 2,
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
    workspace,
    task_state,
    freshness: getFreshness(t),
    confidence,
    metadata,
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
          confidence: 0.55,
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

  return records.sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function writeJsonl(filePath, records) {
  ensureDirectory(path.dirname(filePath));
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeText(filePath, body ? `${body}\n` : "");
}

function buildLayerSummary(layers) {
  const generatedAt = new Date().toISOString();
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
    "",
    "## Durable Highlights",
    "",
  ];

  const durableHighlights = layers.sharedInbox.slice(-8).reverse();
  if (durableHighlights.length === 0) {
    lines.push("- No durable shared inbox signals yet.");
  } else {
    for (const record of durableHighlights) {
      lines.push(`- [${record.tool}] [${record.scope}] ${record.title}`);
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

  return {
    markdown: `${lines.join("\n").trim()}\n`,
    json: {
      generatedAt,
      counts: {
        sharedInbox: layers.sharedInbox.length,
        sessionMemory: layers.sessionMemory.length,
        sharedEvents: layers.sharedEvents.length,
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
      },
    },
  };
}

function main() {
  ensureDirectory(STRUCTURED_ROOT);
  ensureDirectory(GENERATED_ROOT);

  const layers = {
    sharedInbox: parseInboxEntries(),
    sessionMemory: parseSessionMemoryEntries(),
    sharedEvents: parseEventEntries(),
  };

  writeJsonl(SHARED_INBOX_JSONL, layers.sharedInbox);
  writeJsonl(SESSION_MEMORY_JSONL, layers.sessionMemory);
  writeJsonl(SHARED_EVENTS_JSONL, layers.sharedEvents);

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
