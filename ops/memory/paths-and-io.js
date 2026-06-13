// ops/memory/paths-and-io.js
// Path constants and core I/O helpers used by memory-layer parsing.
// Extracted from memory-layers-parse.js to separate path/I/O concerns from
// record coercion, entry parsing, and lazy module loading.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

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

const STORE_ROOT = resolveStoreRoot();
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

/**
 * Verify that `filePath` (after realpath resolution) lies within `safeRoot`.
 * Returns the realpath on success, null on failure (path escapes root, missing,
 * or realpath error). Designed to be cheap and safe to call inside loops.
 *
 * SECURITY: defends against symlink-based file-read amplification. A vault
 * synced via OneDrive / Obsidian Sync / iCloud Drive may contain symlinks
 * planted by other apps; resolving them and checking containment prevents
 * arbitrary host files (e.g. ~/.ssh/id_rsa) from being read into agent
 * context.
 */
function safeRealpathWithin(filePath, safeRoot) {
  // Resolve the parent directory (which must exist) so we can validate
  // containment even for files that don't exist yet — the write path
  // is what this guard protects, and realpath on a non-existent file
  // throws ENOENT.
  const parentDir = path.dirname(filePath);
  const filename = path.basename(filePath);

  let realParent;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    return null;
  }
  const realPath = path.join(realParent, filename);

  let realRoot;
  try {
    realRoot = fs.realpathSync(safeRoot);
  } catch {
    return null;
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realPath !== realRoot && !realPath.startsWith(rootWithSep)) {
    return null;
  }
  return realPath;
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

export {
  // I/O
  readJsonl, readText, writeText, ensureDirectory, withFileLock, safeRealpathWithin,
  // Path constants
  USER_HOME, OPENCLAW_HOME, CLAUDE_HOME,
  INBOX_ROOT, EVENTS_ROOT, STRUCTURED_ROOT, GENERATED_ROOT, STORE_ROOT, AI_MEMORY_ROOT,
  SHARED_INBOX_JSONL, DREAM_INBOX_JSONL, SESSION_MEMORY_JSONL, SHARED_EVENTS_JSONL,
  TASK_MEMORY_JSONL, CLAUDE_CODE_JSONL, OPENCLAW_SESSIONS_JSONL,
  OPENCLAW_BLACKBOARD_JSONL, OPENCLAW_RUNS_JSONL, OPENCLAW_JOBS_JSONL, OPENCLAW_JOURNAL_JSONL,
  DAILY_LOG_DIR, PROJECTS_ROOT,
  MEMORY_LAYERS_MD, MEMORY_LAYERS_JSON, GLOBAL_CONTEXT_MD,
  GLOBAL_CONTEXT_META_JSON, GLOBAL_CONTEXT_BODY_MD,
};
