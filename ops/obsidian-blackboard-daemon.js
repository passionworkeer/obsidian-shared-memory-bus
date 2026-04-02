const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function loadPythonRuntimeHelpers() {
  const candidates = [
    path.join(__dirname, "python-runtime.js"),
    path.join(__dirname, "..", "bus", "python-runtime.js"),
    path.join(__dirname, "bus", "python-runtime.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`python-runtime-helper-missing: tried ${candidates.join(", ")}`);
}

function loadVaultRootHelpers() {
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

const { resolvePythonRuntime, withPythonArgs } = loadPythonRuntimeHelpers();
const { resolveVaultRoot } = loadVaultRootHelpers();

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, ".openclaw");
const VAULT_ROOT = resolveVaultRoot();
const DB_PATH =
  process.env.OPENCLAW_BLACKBOARD_DB || path.join(OPENCLAW_HOME, "workspace", "ai-shrimp", "blackboard", "tasks.db");
const MD_PATH = path.join(VAULT_ROOT, "02-KB", "WORKING.md");
const START_TAG = "<!-- OPENCLAW-BLACKBOARD:START -->";
const END_TAG = "<!-- OPENCLAW-BLACKBOARD:END -->";
const DB_SYNC_INTERVAL_MS = Number(process.env.AI_MEMORY_BLACKBOARD_POLL_MS || 15000);
const MD_POLL_INTERVAL_MS = Number(process.env.AI_MEMORY_BLACKBOARD_MD_POLL_MS || 2000);
const LOCAL_WRITE_SUPPRESS_MS = Number(process.env.AI_MEMORY_BLACKBOARD_SUPPRESS_MS || 1000);
const PYTHON = resolvePythonRuntime();
const PYTHON_ENV = {
  ...process.env,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

let isUpdating = false;
let ignoreMdUntil = 0;
let pendingMdTimer = null;
let lastMdSignature = getFileSignature(MD_PATH);

process.on("uncaughtException", (err) => {
  console.error("[blackboard-daemon] uncaughtException:", err && err.message ? err.message : err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[blackboard-daemon] unhandledRejection:", reason);
});

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (_error) {
    return "__missing__";
  }
}

function runPythonJson(script, args = []) {
  if (!PYTHON.available) {
    throw new Error(PYTHON.error || "python-runtime-not-found");
  }

  const result = spawnSync(PYTHON.command, withPythonArgs(PYTHON, ["-c", script, ...args]), {
    encoding: "utf8",
    windowsHide: true,
    env: PYTHON_ENV,
  });

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    throw new Error(stderr || stdout || (result.error && result.error.message) || `python-exit-${result.status}`);
  }

  if (!stdout) {
    return {};
  }

  return JSON.parse(stdout);
}

function readBlackboardRows() {
  const queryScript = [
    "import json, os, sqlite3, sys",
    "db_path = sys.argv[1]",
    "if not os.path.exists(db_path):",
    "    print(json.dumps({'ok': True, 'rows': []}))",
    "    raise SystemExit(0)",
    "try:",
    "    db = sqlite3.connect(db_path)",
    "    db.row_factory = sqlite3.Row",
    "    rows = db.execute(\"SELECT id, repo, issue_number, state, assigned_agent FROM tasks WHERE state != 'ABORTED' ORDER BY id DESC LIMIT 15\").fetchall()",
    "    payload = {'ok': True, 'rows': [dict(row) for row in rows]}",
    "    print(json.dumps(payload, ensure_ascii=False))",
    "except sqlite3.Error as exc:",
    "    message = str(exc)",
    "    if 'no such table' in message.lower():",
    "        print(json.dumps({'ok': True, 'rows': []}))",
    "    else:",
    "        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))",
    "        raise SystemExit(1)",
  ].join("\n");

  const payload = runPythonJson(queryScript, [DB_PATH]);
  if (!payload.ok) {
    throw new Error(payload.error || "blackboard-query-failed");
  }
  return Array.isArray(payload.rows) ? payload.rows : [];
}

function markTasksComplete(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return 0;
  }

  const uniqueIds = [...new Set(taskIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  if (uniqueIds.length === 0) {
    return 0;
  }

  const updateScript = [
    "import json, os, sqlite3, sys",
    "db_path = sys.argv[1]",
    "task_ids = json.loads(sys.argv[2])",
    "if not os.path.exists(db_path) or not task_ids:",
    "    print(json.dumps({'ok': True, 'changes': 0}))",
    "    raise SystemExit(0)",
    "try:",
    "    db = sqlite3.connect(db_path)",
    "    placeholders = ','.join('?' for _ in task_ids)",
    "    query = f\"UPDATE tasks SET state='PR_SUBMITTED' WHERE id IN ({placeholders}) AND state NOT IN ('PR_SUBMITTED', 'FAILED', 'ABORTED')\"",
    "    cursor = db.execute(query, task_ids)",
    "    db.commit()",
    "    print(json.dumps({'ok': True, 'changes': cursor.rowcount}))",
    "except sqlite3.Error as exc:",
    "    message = str(exc)",
    "    if 'no such table' in message.lower():",
    "        print(json.dumps({'ok': True, 'changes': 0}))",
    "    else:",
    "        print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))",
    "        raise SystemExit(1)",
  ].join("\n");

  const payload = runPythonJson(updateScript, [DB_PATH, JSON.stringify(uniqueIds)]);
  if (!payload.ok) {
    throw new Error(payload.error || "blackboard-update-failed");
  }
  return Number(payload.changes || 0);
}

function renderBlackboard(rows) {
  const lines = [
    START_TAG,
    "### OpenClaw Tasks Blackboard",
    "*Auto-synced with OpenClaw SQLite*",
    "",
  ];

  for (const row of rows) {
    const state = String(row.state || "UNKNOWN").trim() || "UNKNOWN";
    const checked = ["PR_SUBMITTED", "FAILED"].includes(state) ? "x" : " ";
    const repo = String(row.repo || "unknown");
    const issueNumber = String(row.issue_number || "?");
    const assignee = String(row.assigned_agent || "unassigned");
    lines.push(`- [${checked}] [${state}] repo: ${repo} #${issueNumber} (assignee: ${assignee}) <!--#OC-TASK-${row.id}-->`);
  }

  lines.push(END_TAG);
  return lines.join("\n");
}

function syncDbToMd() {
  if (isUpdating) {
    return;
  }

  try {
    if (!fs.existsSync(MD_PATH)) {
      return;
    }

    const rows = readBlackboardRows();
    const nextBlock = renderBlackboard(rows);
    const content = fs.readFileSync(MD_PATH, "utf8");
    const blockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
    const nextContent = blockRegex.test(content) ? content.replace(blockRegex, nextBlock) : `${content}\n\n${nextBlock}\n`;

    if (nextContent === content) {
      return;
    }

    isUpdating = true;
    ignoreMdUntil = Date.now() + LOCAL_WRITE_SUPPRESS_MS;
    fs.writeFileSync(MD_PATH, nextContent, "utf8");
    lastMdSignature = getFileSignature(MD_PATH);
    console.log(`[blackboard-daemon] Synced ${rows.length} tasks into WORKING.md`);
  } catch (error) {
    console.error("[blackboard-daemon] syncDbToMd error:", error && error.message ? error.message : error);
  } finally {
    setTimeout(() => {
      isUpdating = false;
      lastMdSignature = getFileSignature(MD_PATH);
    }, LOCAL_WRITE_SUPPRESS_MS);
  }
}

function extractCheckedTaskIds(content) {
  const matches = String(content || "").matchAll(/- \[(x|X)\] .*<!--#OC-TASK-(\d+)-->/g);
  const taskIds = [];
  for (const match of matches) {
    const taskId = Number(match[2]);
    if (Number.isInteger(taskId) && taskId > 0) {
      taskIds.push(taskId);
    }
  }
  return [...new Set(taskIds)];
}

function handleMdChange() {
  if (isUpdating || Date.now() < ignoreMdUntil || !fs.existsSync(MD_PATH)) {
    return;
  }

  const currentSignature = getFileSignature(MD_PATH);
  if (currentSignature === lastMdSignature) {
    return;
  }
  lastMdSignature = currentSignature;

  try {
    const content = fs.readFileSync(MD_PATH, "utf8");
    const blockRegex = new RegExp(`${START_TAG}([\\s\\S]*?)${END_TAG}`, "m");
    const match = content.match(blockRegex);
    if (!match) {
      return;
    }

    const taskIds = extractCheckedTaskIds(match[1]);
    const changes = markTasksComplete(taskIds);
    if (changes > 0) {
      console.log(`[blackboard-daemon] Marked ${changes} tasks as PR_SUBMITTED from WORKING.md`);
      syncDbToMd();
    }
  } catch (error) {
    console.error("[blackboard-daemon] handleMdChange error:", error && error.message ? error.message : error);
  }
}

function scheduleMdCheck() {
  if (pendingMdTimer) {
    clearTimeout(pendingMdTimer);
  }
  pendingMdTimer = setTimeout(() => {
    pendingMdTimer = null;
    handleMdChange();
  }, 500);
}

function attachMdWatcher() {
  if (!fs.existsSync(MD_PATH)) {
    return;
  }

  try {
    fs.watch(MD_PATH, { persistent: true }, () => {
      if (Date.now() >= ignoreMdUntil) {
        scheduleMdCheck();
      }
    });
  } catch (error) {
    console.warn("[blackboard-daemon] fs.watch unavailable:", error && error.message ? error.message : error);
  }
}

console.log("==================================================");
console.log("Omni-Memory Mesh: Blackboard <-> Obsidian Daemon");
console.log("==================================================");
console.log(`[blackboard-daemon] Vault: ${VAULT_ROOT}`);
console.log(`[blackboard-daemon] DB: ${DB_PATH}`);
console.log(
  `[blackboard-daemon] Python: ${PYTHON.available ? `${PYTHON.command} (${PYTHON.source})` : `missing (${PYTHON.error})`}`
);

attachMdWatcher();
syncDbToMd();
setInterval(syncDbToMd, DB_SYNC_INTERVAL_MS);
setInterval(handleMdChange, MD_POLL_INTERVAL_MS);
