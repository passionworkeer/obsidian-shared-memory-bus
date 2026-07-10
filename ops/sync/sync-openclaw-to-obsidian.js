import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

// ESM __dirname shim (I-HIGH-2 fix: this file uses `import` syntax but
// references __dirname; on Node ESM __dirname is undefined, so derive
// from import.meta.url).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadVaultRootHelper() {
  // I-HIGH-2 fix: candidates must resolve relative to project root.
  // File lives at ops/sync/, vault-root.js lives at bus/vault-root.js
  // (relative from project root). Try the most likely path first.
  const candidates = [
    path.join(__dirname, "..", "..", "bus", "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
    path.join(__dirname, "vault-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Windows: path.join gives "bus\vault-root.js" which is not a valid
      // ES module specifier. Convert to file URL for cross-platform import.
      return import(pathToFileURL(candidate).href);
    }
  }

  throw new Error(`vault-root-helper-missing: tried ${candidates.join(", ")}`);
}

const vaultRootModule = await loadVaultRootHelper();
const { resolveVaultRoot } = vaultRootModule;

const pythonRuntimePath = fs.existsSync(path.join(__dirname, "..", "..", "bus", "python-runtime.js"))
  ? path.join(__dirname, "..", "..", "bus", "python-runtime.js")
  : path.join(__dirname, "python-runtime.js");
const pythonRuntimeModule = await import(pathToFileURL(pythonRuntimePath).href);
const { resolvePythonRuntime, withPythonArgs } = pythonRuntimeModule;
const memoryContractModule = await import("../memory/memory-contract.js");
const { MEMORY_RECORD_SCHEMA_VERSION } = memoryContractModule;
const PYTHON = resolvePythonRuntime();

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, ".openclaw");
const VAULT_ROOT = resolveVaultRoot();
const VB = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_ROOT = path.join(VB, "structured");
const INBOX_FILE = path.join(VB, "inbox", "openclaw.md");
const SESSION_DIR = process.env.OPENCLAW_SESSION_DIR || path.join(OPENCLAW_HOME, "agents", "main", "sessions");
const RUNS_FILE = path.join(OPENCLAW_HOME, "subagents", "runs.json");
const JOBS_FILE = path.join(OPENCLAW_HOME, "cron", "jobs.json");
const BLACKBOARD_DB = process.env.OPENCLAW_BLACKBOARD_DB || path.join(OPENCLAW_HOME, "workspace", "ai-shrimp", "blackboard", "tasks.db");

const OUTPUTS = {
  sessions: path.join(STRUCTURED_ROOT, "openclaw.jsonl"),
  jobs: path.join(STRUCTURED_ROOT, "openclaw-jobs.jsonl"),
  runs: path.join(STRUCTURED_ROOT, "openclaw-runs.jsonl"),
  blackboard: path.join(STRUCTURED_ROOT, "openclaw-blackboard.jsonl"),
  journal: path.join(STRUCTURED_ROOT, "openclaw-journal.jsonl"),
};

const NOISE_PATTERNS = [
  /^Sender\s*\(/i,
  /^System:/i,
  /^Subagent Context/i,
  /^\[Subagent Context\]/i,
  /^Exec completed/i,
  /^Exec failed/i,
  /^A new session was started/i,
  /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i,
  /^Run your Session Startup/i,
];

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

function writeJsonl(filePath, records) {
  ensureDirectory(path.dirname(filePath));
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(filePath, body ? `${body}\n` : "", "utf8");
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function isNoise(text) {
  const normalized = normalizeSpaces(text);
  if (!normalized || normalized.length < 8) {
    return true;
  }
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractText(content) {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && item.type === "text") {
          return item.text || "";
        }
        if (item && item.type === "tool_use") {
          return `[tool:${item.name || "unknown"}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function buildRecord({
  id,
  t,
  tool = "openclaw",
  session = "",
  type,
  project = "",
  title,
  content,
  source,
  scope,
  source_kind,
  memory_level,
  workspace = "",
  task_state = "",
  confidence = 0.6,
  concepts = [],
  facts = [],
  metadata = {},
}) {
  const normalizedTitle = normalizeSpaces(title || content).slice(0, 140);
  const normalizedContent = String(content || "").trim().slice(0, 6000);
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
    files_read: [],
    files_modified: [],
    source,
    scope,
    visibility: "shared",
    source_kind,
    memory_level,
    workspace,
    task_state,
    freshness: "hot",
    confidence,
    content_hash: sha256(normalizedContent),
    metadata,
  };
}

function getRecentSessionFiles(limit = 25) {
  if (!fs.existsSync(SESSION_DIR)) {
    return [];
  }
  return fs
    .readdirSync(SESSION_DIR)
    .filter((fileName) => fileName.endsWith(".jsonl") && !fileName.includes(".deleted.") && !fileName.includes(".reset."))
    .map((fileName) => {
      const filePath = path.join(SESSION_DIR, fileName);
      return {
        fileName,
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

function parseJsonLines(filePath) {
  const events = [];
  for (const line of readText(filePath).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (_error) {
      continue;
    }
  }
  return events;
}

function extractAgentLabel(text, fallback) {
  const match = String(text || "").match(/\[cron:([^\]]+)\s+([^\]]+)\]/);
  if (match) {
    return normalizeSpaces(match[2]) || fallback;
  }
  return fallback;
}

function extractSessionRecords(fileInfo) {
  const events = parseJsonLines(fileInfo.filePath);
  if (events.length === 0) {
    return [];
  }

  const sessionMeta = events.find((event) => event.type === "session") || {};
  const sessionId = sessionMeta.id || path.basename(fileInfo.fileName, ".jsonl");
  const cwd = normalizeSpaces(sessionMeta.cwd || "");
  const project = cwd ? path.basename(cwd) : "workspace";
  const messages = events.filter((event) => event.type === "message");
  const records = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = normalizeSpaces(message.message?.role || "");
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractText(message.message?.content || "");
    const normalized = normalizeSpaces(text);
    if (isNoise(normalized) || normalized.length < 40) {
      continue;
    }
    const agent = extractAgentLabel(normalized, normalizeSpaces(sessionMeta.agentType || "main"));
    const scope = role === "user" && /\bcron\b/i.test(normalized) ? "task" : "summary";
    records.push(
      buildRecord({
        id: `openclaw-session-${sha1(`${sessionId}|${index}|${role}|${normalized.slice(0, 120)}`)}`,
        t: message.timestamp || new Date(fileInfo.mtimeMs).toISOString(),
        session: sessionId,
        type: role === "user" ? "session-prompt" : "session-response",
        project,
        title: normalized.split("\n")[0],
        content: normalized,
        source: "openclaw-session",
        scope,
        source_kind: "session",
        memory_level: "session",
        workspace: cwd || project,
        concepts: [agent].filter(Boolean),
        confidence: role === "assistant" ? 0.58 : 0.7,
        metadata: {
          role,
          agent,
          origin_path: fileInfo.filePath,
        },
      })
    );
  }

  return records.slice(-6);
}

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) {
    return [];
  }
  let payload;
  try {
    payload = JSON.parse(readText(JOBS_FILE));
  } catch (_error) {
    return [];
  }

  return (payload.jobs || []).map((job) =>
    buildRecord({
      id: `openclaw-job-${job.id}`,
      t: new Date(Number(job.updatedAtMs || job.createdAtMs || Date.now())).toISOString(),
      type: "task-job",
      project: "ai-shrimp",
      title: normalizeSpaces(job.name || job.id),
      content: normalizeSpaces(
        [
          `schedule=${job.schedule?.kind || "unknown"}:${job.schedule?.expr || ""}`,
          `sessionTarget=${job.sessionTarget || ""}`,
          `wakeMode=${job.wakeMode || ""}`,
          `timeout=${job.payload?.timeoutSeconds || ""}`,
          normalizeSpaces(job.payload?.message || "").slice(0, 1200),
        ].join(" | ")
      ),
      source: "openclaw-cron-job",
      scope: "task",
      source_kind: "cron",
      memory_level: "task",
      workspace: "ai-shrimp",
      task_state: normalizeSpaces(job.state?.lastStatus || job.state?.lastRunStatus || ""),
      confidence: 0.82,
      metadata: {
        enabled: Boolean(job.enabled),
        agentId: job.agentId || "",
        schedule: job.schedule || {},
        delivery: job.delivery || {},
      },
    })
  );
}

function loadRuns() {
  if (!fs.existsSync(RUNS_FILE)) {
    return [];
  }
  let payload;
  try {
    payload = JSON.parse(readText(RUNS_FILE));
  } catch (_error) {
    return [];
  }

  return Object.values(payload.runs || {})
    .map((run) =>
      buildRecord({
        id: `openclaw-run-${run.runId}`,
        t: new Date(Number(run.startedAt || run.createdAt || Date.now())).toISOString(),
        session: normalizeSpaces(run.childSessionKey || ""),
        type: "task-run",
        project: "ai-shrimp",
        title: normalizeSpaces(run.task || run.runId).slice(0, 140),
        content: normalizeSpaces(
          [
            `model=${run.model || ""}`,
            `status=${run.outcome?.status || run.endedReason || "unknown"}`,
            `cleanup=${run.cleanup || ""}`,
            normalizeSpaces(run.frozenResultText || "").slice(0, 900),
          ].join(" | ")
        ),
        source: "openclaw-run-ledger",
        scope: "run",
        source_kind: "run",
        memory_level: "task",
        workspace: normalizeSpaces(run.workspaceDir || "ai-shrimp"),
        task_state: normalizeSpaces(run.outcome?.status || run.endedReason || ""),
        confidence: 0.8,
        metadata: {
          requesterDisplayKey: run.requesterDisplayKey || "",
          controllerSessionKey: run.controllerSessionKey || "",
          requesterSessionKey: run.requesterSessionKey || "",
          spawnMode: run.spawnMode || "",
          runTimeoutSeconds: run.runTimeoutSeconds || 0,
        },
      })
    )
    .sort((left, right) => String(right.t || "").localeCompare(String(left.t || "")))
    .slice(0, 120);
}

function loadBlackboardSnapshot() {
  if (!fs.existsSync(BLACKBOARD_DB)) {
    return { tasks: [], journal: [], warning: "blackboard-db-missing" };
  }

  if (!PYTHON.available) {
    return {
      tasks: [],
      journal: [],
      warning: `python-runtime-unavailable:${PYTHON.error || "unknown-error"}`,
    };
  }

  const pythonScript = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "db.row_factory = sqlite3.Row",
    "tasks = [dict(row) for row in db.execute(\"SELECT id, repo, issue_number, issue_title, issue_url, priority, stars, state, assigned_agent, processor, error_log, pr_url, retry_count, created_at, updated_at, submitted_at FROM tasks ORDER BY updated_at DESC LIMIT 120\")]",
    "journal = [dict(row) for row in db.execute(\"SELECT id, agent, task_id, action, detail, ts FROM journal ORDER BY ts DESC LIMIT 200\")]",
    "db.close()",
    "print(json.dumps({'tasks': tasks, 'journal': journal}, ensure_ascii=False))",
  ].join(";");

  const result = spawnSync(PYTHON.command, withPythonArgs(PYTHON, ["-c", pythonScript, BLACKBOARD_DB]), {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (result.status !== 0) {
    return {
      tasks: [],
      journal: [],
      warning: `blackboard-query-failed:${String(result.stderr || result.error || "").trim() || `exit-${result.status}`}`,
    };
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch (_error) {
    return {
      tasks: [],
      journal: [],
      warning: "blackboard-json-parse-failed",
    };
  }
}

function loadBlackboardRecords() {
  const snapshot = loadBlackboardSnapshot();
  const tasks = (snapshot.tasks || []).map((task) =>
    buildRecord({
      id: `openclaw-task-${task.id}`,
      t: new Date(normalizeSpaces(task.updated_at || task.created_at || new Date().toISOString())).toISOString(),
      type: "task-state",
      project: normalizeSpaces(task.repo || "ai-shrimp"),
      title: `${normalizeSpaces(task.repo)} #${task.issue_number} ${normalizeSpaces(task.issue_title || "")}`.trim(),
      content: normalizeSpaces(
        [
          `state=${task.state || ""}`,
          `assigned=${task.assigned_agent || ""}`,
          `retry=${task.retry_count || 0}`,
          task.pr_url || "",
          normalizeSpaces(task.error_log || "").slice(0, 500),
        ].join(" | ")
      ),
      source: "openclaw-blackboard",
      scope: "task",
      source_kind: "blackboard",
      memory_level: "task",
      workspace: "ai-shrimp",
      task_state: normalizeSpaces(task.state || ""),
      confidence: 0.92,
      metadata: task,
    })
  );

  const journal = (snapshot.journal || []).map((entry) =>
    buildRecord({
      id: `openclaw-journal-${entry.id}`,
      t: new Date(normalizeSpaces(entry.ts || new Date().toISOString())).toISOString(),
      type: "task-journal",
      project: "ai-shrimp",
      title: `${normalizeSpaces(entry.agent || "agent")} ${normalizeSpaces(entry.action || "event")}`.trim(),
      content: normalizeSpaces(entry.detail || "").slice(0, 1200),
      source: "openclaw-blackboard-journal",
      scope: "run",
      source_kind: "blackboard",
      memory_level: "task",
      workspace: "ai-shrimp",
      task_state: normalizeSpaces(entry.action || ""),
      confidence: 0.7,
      metadata: entry,
    })
  );

  return { tasks, journal, warning: snapshot.warning || "" };
}

function updateInbox(highlights) {
  const lines = ["# OpenClaw Inbox", ""];
  if (highlights.length === 0) {
    lines.push("- No OpenClaw records found.");
  } else {
    for (const record of highlights.slice(0, 24)) {
      const stamp = String(record.t || "").replace("T", " ").replace("Z", "").slice(0, 19);
      const taskState = record.task_state ? ` {${record.task_state}}` : "";
      lines.push(`- ${stamp} [${record.source}]${taskState} ${record.title}`);
    }
  }
  ensureDirectory(path.dirname(INBOX_FILE));
  fs.writeFileSync(INBOX_FILE, `${lines.join("\n").trim()}\n`, "utf8");
}

function main() {
  ensureDirectory(STRUCTURED_ROOT);

  const sessionRecords = getRecentSessionFiles().flatMap((fileInfo) => extractSessionRecords(fileInfo));
  const jobRecords = loadJobs();
  const runRecords = loadRuns();
  const blackboard = loadBlackboardRecords();

  writeJsonl(OUTPUTS.sessions, sessionRecords);
  writeJsonl(OUTPUTS.jobs, jobRecords);
  writeJsonl(OUTPUTS.runs, runRecords);
  writeJsonl(OUTPUTS.blackboard, blackboard.tasks);
  writeJsonl(OUTPUTS.journal, blackboard.journal);

  const highlights = [...blackboard.tasks, ...runRecords, ...jobRecords, ...sessionRecords]
    .sort((left, right) => String(right.t || "").localeCompare(String(left.t || "")));
  updateInbox(highlights);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        pythonRuntime: {
          command: PYTHON.command,
          argsPrefix: PYTHON.argsPrefix,
          source: PYTHON.source,
          available: PYTHON.available,
          version: PYTHON.version,
          error: PYTHON.error,
        },
        warnings: blackboard.warning ? [blackboard.warning] : [],
        counts: {
          sessions: sessionRecords.length,
          jobs: jobRecords.length,
          runs: runRecords.length,
          blackboard: blackboard.tasks.length,
          journal: blackboard.journal.length,
        },
        files: OUTPUTS,
      },
      null,
      2
    )
  );
}

main();
