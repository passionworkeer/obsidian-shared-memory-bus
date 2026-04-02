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

const VAULT_ROOT = resolveVaultRoot();
const AI_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_ROOT = path.join(AI_MEMORY_ROOT, "structured");
const GENERATED_ROOT = path.join(AI_MEMORY_ROOT, "generated");
const HANDOFF_JSON_PATH = path.join(GENERATED_ROOT, "HANDOFF.json");
const HANDOFF_MD_PATH = path.join(GENERATED_ROOT, "HANDOFF.md");

function ensureDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch (_error) {
    }
  }
  return records;
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toTimestamp(value) {
  const parsed = new Date(String(value || "").trim());
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function trimText(value, maxLength = 220) {
  const normalized = normalizeSpaces(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function formatRecordLine(record) {
  const tool = normalizeSpaces(record.tool || "unknown");
  const title = trimText(record.title || record.content || record.id || "untitled", 180);
  return `[${tool}] ${title}`;
}

function isInteresting(record) {
  return Boolean(normalizeSpaces(record.title || record.content));
}

function collectRecords() {
  const files = [
    "shared-inbox.jsonl",
    "session-memory.jsonl",
    "shared-events.jsonl",
    "openclaw-blackboard.jsonl",
    "openclaw-runs.jsonl",
    "openclaw-jobs.jsonl",
    "openclaw-journal.jsonl",
  ];

  return files
    .flatMap((fileName) => readJsonl(path.join(STRUCTURED_ROOT, fileName)))
    .filter(isInteresting)
    .sort((left, right) => toTimestamp(right.t) - toTimestamp(left.t));
}

function selectUnique(records, predicate, limit) {
  const seen = new Set();
  const results = [];

  for (const record of records) {
    if (!predicate(record)) {
      continue;
    }

    const key = `${record.tool || ""}|${normalizeSpaces(record.title || record.content || record.id || "")}`.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(record);
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function matchesAny(record, patterns) {
  const haystack = `${record.title || ""} ${record.content || ""}`.toLowerCase();
  return patterns.some((pattern) => pattern.test(haystack));
}

function buildPack(records) {
  const recent = records.slice(0, 300);

  const toolInvariants = selectUnique(
    recent,
    (record) =>
      ["feedback", "user"].includes(String(record.scope || "").toLowerCase()) ||
      ["workflow-rule"].includes(String(record.type || "").toLowerCase()) ||
      (String(record.source || "").toLowerCase() === "shared-inbox" &&
        matchesAny(record, [/\bmust\b/i, /\balways\b/i, /\bshould\b/i, /不要/, /必须/, /避免/])),
    8
  );

  const goalRecord =
    selectUnique(
      recent,
      (record) =>
        !["openclaw"].includes(String(record.tool || "").toLowerCase()) &&
        ["summary", "project", "reference"].includes(String(record.scope || "").toLowerCase()) &&
        !["workflow-rule"].includes(String(record.type || "").toLowerCase()),
      1
    )[0] ||
    recent[0] ||
    null;

  const done = selectUnique(
    recent,
    (record) =>
      ["ok", "pr_submitted", "done", "completed"].includes(String(record.task_state || "").toLowerCase()) ||
      matchesAny(record, [/\bcompleted\b/i, /\bvalidated\b/i, /\bpassed\b/i, /\bfinished\b/i, /完成/, /已验证/]),
    6
  );

  const next = selectUnique(
    recent,
    (record) =>
      (
        ["pending", "processing", "active", "queued"].includes(String(record.task_state || "").toLowerCase()) ||
        matchesAny(record, [/\bnext\b/i, /\btodo\b/i, /\bfollow[- ]?up\b/i, /\bcontinue\b/i, /待办/, /下一步/, /继续/])
      ) &&
      !["feedback", "user"].includes(String(record.scope || "").toLowerCase()),
    6
  );

  const blocked = selectUnique(
    recent,
    (record) =>
      ["failed", "error", "timeout", "blocked"].includes(String(record.task_state || "").toLowerCase()) ||
      matchesAny(record, [/\bblocked\b/i, /\bfailed\b/i, /\berror\b/i, /\btimeout\b/i, /阻塞/, /失败/, /报错/]),
    5
  );

  const openThreads = selectUnique(
    [...next, ...blocked, ...recent],
    (record) =>
      ["task", "run"].includes(String(record.scope || "").toLowerCase()) ||
      ["task-state", "task-run"].includes(String(record.type || "").toLowerCase()),
    8
  );

  const fileSet = new Set();
  for (const record of recent.slice(0, 80)) {
    for (const filePath of [...(record.files_modified || []), ...(record.files_read || [])]) {
      const normalized = normalizeSpaces(filePath);
      if (normalized) {
        fileSet.add(normalized);
      }
    }
  }

  const sources = recent.slice(0, 20).map((record) => ({
    id: record.id,
    tool: record.tool,
    t: record.t,
    scope: record.scope,
    type: record.type,
    task_state: record.task_state,
    title: trimText(record.title || record.content || record.id || "untitled", 180),
  }));

  return {
    generatedAt: new Date().toISOString(),
    goal: goalRecord ? trimText(goalRecord.title || goalRecord.content || "", 220) : "",
    done: done.map((record) => formatRecordLine(record)),
    next: next.map((record) => formatRecordLine(record)),
    blocked: blocked.map((record) => formatRecordLine(record)),
    files: [...fileSet].slice(0, 12),
    open_threads: openThreads.map((record) => formatRecordLine(record)),
    tool_invariants: toolInvariants.map((record) => formatRecordLine(record)),
    sources,
  };
}

function renderMarkdown(pack) {
  const lines = [
    "# Handoff Pack",
    "",
    `Generated at: ${pack.generatedAt}`,
    "",
    "## Goal",
    pack.goal || "-",
    "",
    "## Done",
    ...(pack.done.length > 0 ? pack.done.map((line) => `- ${line}`) : ["-"]),
    "",
    "## Next",
    ...(pack.next.length > 0 ? pack.next.map((line) => `- ${line}`) : ["-"]),
    "",
    "## Blocked",
    ...(pack.blocked.length > 0 ? pack.blocked.map((line) => `- ${line}`) : ["-"]),
    "",
    "## Files",
    ...(pack.files.length > 0 ? pack.files.map((line) => `- ${line}`) : ["-"]),
    "",
    "## Open Threads",
    ...(pack.open_threads.length > 0 ? pack.open_threads.map((line) => `- ${line}`) : ["-"]),
    "",
    "## Tool Invariants",
    ...(pack.tool_invariants.length > 0 ? pack.tool_invariants.map((line) => `- ${line}`) : ["-"]),
  ];

  return `${lines.join("\n")}\n`;
}

function main() {
  const pack = buildPack(collectRecords());
  ensureDirectory(GENERATED_ROOT);
  fs.writeFileSync(HANDOFF_JSON_PATH, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  fs.writeFileSync(HANDOFF_MD_PATH, renderMarkdown(pack), "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        generatedAt: pack.generatedAt,
        files: {
          json: HANDOFF_JSON_PATH,
          markdown: HANDOFF_MD_PATH,
        },
        counts: {
          done: pack.done.length,
          next: pack.next.length,
          blocked: pack.blocked.length,
          files: pack.files.length,
          toolInvariants: pack.tool_invariants.length,
        },
      },
      null,
      2
    )
  );
}

main();
