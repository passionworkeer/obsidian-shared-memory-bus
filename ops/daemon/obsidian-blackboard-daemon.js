import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadPythonRuntimeHelpers() {
  const candidates = [
    path.join(__dirname, "python-runtime.js"),
    path.join(__dirname, "..", "bus", "python-runtime.js"),
    path.join(__dirname, "bus", "python-runtime.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }

  throw new Error(`python-runtime-helper-missing: tried ${candidates.join(", ")}`);
}

async function loadVaultRootHelpers() {
  const candidates = [
    path.join(__dirname, "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
    path.join(__dirname, "bus", "vault-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }

  throw new Error(`vault-root-helper-missing: tried ${candidates.join(", ")}`);
}

const pythonHelpers = await loadPythonRuntimeHelpers();
const vaultHelpers = await loadVaultRootHelpers();
const { resolvePythonRuntime, withPythonArgs } = pythonHelpers;
const { resolveVaultRoot } = vaultHelpers;

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

let pendingMdTimer = null;
let lastMdSignature = getFileSignature(MD_PATH);

// --- Restart-on-crash policy ---
let restartCount = 0;
let firstRestartAt = 0;
let isRespawning = false;

function canRestart() {
  const now = Date.now();
  if (firstRestartAt === 0) {
    firstRestartAt = now;
  }
  // Reset window after 5 minutes with no restarts
  if (now - firstRestartAt > 5 * 60 * 1000) {
    restartCount = 0;
    firstRestartAt = now;
  }
  return restartCount < 3;
}

function onCrash(err, label) {
  console.error(`[blackboard-daemon] ${label}:`, err && err.message ? err.message : err);
  if (!canRestart()) {
    console.error(
      `[blackboard-daemon] FATAL: exceeded 3 restarts within 5 minutes (first at ${new Date(firstRestartAt).toISOString()}). Exiting with code 1.`
    );
    process.exit(1);
  }
  restartCount++;
  isRespawning = true;
  console.log(`[blackboard-daemon] Scheduling respawn (restart ${restartCount}/3, started at ${new Date(firstRestartAt).toISOString()})`);
  setTimeout(() => {
    if (!fs.existsSync(MD_PATH)) {
      console.error("[blackboard-daemon] FATAL: WORKING.md is not accessible before respawn. Exiting with code 1.");
      process.exit(1);
    }
    isRespawning = false;
    console.log("[blackboard-daemon] Resuming main loop after crash.");
    attachMdWatcher();
    syncDbToMd();
  }, 1000);
}

process.on("uncaughtException", (err) => {
  onCrash(err, "uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  onCrash(reason, "unhandledRejection");
});

process.on("exit", (code) => {
  if (code !== 0 && !isRespawning) {
    // Let the crash handler deal with it
  }
});

// --- File-based lock mechanism ---

// Try to load flock at module initialization, fall back gracefully
let flockModule = null;
try {
  flockModule = (await import("flock")).default;
} catch (_e) {
  // flock package not available; will use pid-file fallback
}

function acquireLock(lockPath) {
  const deadline = Date.now() + 5000;

  if (flockModule) {
    return new Promise((resolve) => {
      flockModule(lockPath, { exclusive: true, wait: 5000 }, (err, release) => {
        if (err || Date.now() > deadline) {
          console.warn(`[blackboard-daemon] flock lock timed out on ${lockPath}, skipping cycle`);
          resolve(null);
          return;
        }
        resolve(release);
      });
    });
  }

  // Fallback: pid-file lock with 5-second timeout
  const pidLockPath = lockPath + ".lock";
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(pidLockPath, String(process.pid), { mode: 0o600, flag: "wx" });
      return { fd: null, pidLockPath };
    } catch (err) {
      if (err.code === "EEXIST") {
        // Check if the lock owner is still alive
        let ownerPid = 0;
        try {
          const content = fs.readFileSync(pidLockPath, "utf8").trim();
          ownerPid = parseInt(content, 10);
        } catch (_e2) {
          // Corrupt lockfile; remove and retry
          try { fs.unlinkSync(pidLockPath); } catch (_e3) { /* ignore */ }
        }
        if (ownerPid > 0) {
          try {
            process.kill(ownerPid, 0); // throws if process is gone
          } catch (_e4) {
            // Owner is dead; remove stale lock and retry
            try { fs.unlinkSync(pidLockPath); } catch (_e5) { /* ignore */ }
          }
        }
        // Wait a bit before retrying
        const sleepMs = Math.min(50, deadline - Date.now());
        if (sleepMs <= 0) break;
        const start = Date.now();
        const end = start + sleepMs;
        while (Date.now() < end) { /* spin */ }
      } else {
        // Unexpected error
        console.warn(`[blackboard-daemon] acquireLock unexpected error: ${err.message}`);
        break;
      }
    }
  }

  console.warn(`[blackboard-daemon] acquireLock timed out after 5s on ${lockPath}, skipping cycle`);
  return null;
}

function releaseLock(releaseHandle, lockPath) {
  if (!releaseHandle) return;

  // Promise-based flock release
  if (typeof releaseHandle === "function") {
    try { releaseHandle(); } catch (_e) { /* ignore */ }
    return;
  }

  // Fallback pid-file release
  const pidLockPath = releaseHandle.pidLockPath;
  if (pidLockPath) {
    try { fs.unlinkSync(pidLockPath); } catch (_e) { /* ignore */ }
  }
}

// --- Atomic write ---

function atomicWrite(filePath, content) {
  const tmpPath = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.fsyncSync(fs.openSync(tmpPath, "r+"));
  fs.renameSync(tmpPath, filePath);
}

// --- Content hash (skip no-op writes) ---

function contentHash(content) {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) ^ content.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

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

async function syncDbToMd() {
  try {
    if (!fs.existsSync(MD_PATH)) {
      return;
    }

    const rows = readBlackboardRows();
    const nextBlock = renderBlackboard(rows);

    let rawContent;
    try {
      rawContent = fs.readFileSync(MD_PATH, "utf8");
    } catch (err) {
      console.error("[blackboard-daemon] syncDbToMd: cannot read WORKING.md:", err.message);
      return;
    }

    const blockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
    const nextContent = blockRegex.test(rawContent) ? rawContent.replace(blockRegex, nextBlock) : `${rawContent}\n\n${nextBlock}\n`;

    // Skip no-op write via content hash
    const nextHash = contentHash(nextContent);
    const currentHash = contentHash(rawContent);
    if (nextHash === currentHash) {
      return;
    }

    const lockPath = MD_PATH + ".lock";
    const lockHandle = await acquireLock(lockPath);
    if (!lockHandle) {
      console.warn("[blackboard-daemon] syncDbToMd: could not acquire lock, skipping cycle");
      return;
    }

    try {
      // Re-read inside the lock to confirm the file hasn't changed underneath us
      let lockedContent;
      try {
        lockedContent = fs.readFileSync(MD_PATH, "utf8");
      } catch (err) {
        console.error("[blackboard-daemon] syncDbToMd: cannot read WORKING.md inside lock:", err.message);
        return;
      }

      const lockedBlockRegex = new RegExp(`${START_TAG}[\\s\\S]*?${END_TAG}`, "m");
      const lockedNextContent = lockedBlockRegex.test(lockedContent)
        ? lockedContent.replace(lockedBlockRegex, nextBlock)
        : `${lockedContent}\n\n${nextBlock}\n`;

      if (contentHash(lockedNextContent) === contentHash(lockedContent)) {
        return; // no-op inside lock
      }

      atomicWrite(MD_PATH, lockedNextContent);
      lastMdSignature = getFileSignature(MD_PATH);
      console.log(`[blackboard-daemon] Synced ${rows.length} tasks into WORKING.md`);
    } finally {
      releaseLock(lockHandle, lockPath);
    }
  } catch (error) {
    console.error("[blackboard-daemon] syncDbToMd error:", error && error.message ? error.message : error);
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

async function handleMdChange() {
  if (!fs.existsSync(MD_PATH)) {
    return;
  }

  const currentSignature = getFileSignature(MD_PATH);
  if (currentSignature === lastMdSignature) {
    return;
  }
  lastMdSignature = currentSignature;

  const lockPath = MD_PATH + ".lock";
  const lockHandle = await acquireLock(lockPath);
  if (!lockHandle) {
    console.warn("[blackboard-daemon] handleMdChange: could not acquire lock, skipping cycle");
    return;
  }

  try {
    let content;
    try {
      content = fs.readFileSync(MD_PATH, "utf8");
    } catch (err) {
      console.error("[blackboard-daemon] handleMdChange: cannot read WORKING.md:", err.message);
      return;
    }

    const blockRegex = new RegExp(`${START_TAG}([\\s\\S]*?)${END_TAG}`, "m");
    const match = content.match(blockRegex);
    if (!match) {
      return;
    }

    const taskIds = extractCheckedTaskIds(match[1]);
    if (taskIds.length === 0) {
      return;
    }

    const changes = markTasksComplete(taskIds);
    if (changes > 0) {
      console.log(`[blackboard-daemon] Marked ${changes} tasks as PR_SUBMITTED from WORKING.md`);
      syncDbToMd();
    }
  } catch (error) {
    console.error("[blackboard-daemon] handleMdChange error:", error && error.message ? error.message : error);
  } finally {
    releaseLock(lockHandle, lockPath);
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
      scheduleMdCheck();
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
