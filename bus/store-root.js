/**
 * bus/store-root.js
 * ================
 * Resolves the memory store root path — no Obsidian dependency.
 *
 * Priority:
 *   1. AI_MEMORY_STORE env var (user-specified absolute path)
 *   2. Auto-detect best drive: scan D:/E:/F:/... pick the one with most free space
 *   3. Fallback: AI_MEMORY_ROOT + platform-specific path or platform.storeRootDefault
 *
 * Usage:
 *   const { resolveStoreRoot } = require('./store-root');
 *   const inboxDir = resolveStoreRoot() + '/inbox';
 */

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

// Lazily load platform adapter only when needed (avoids crashing if bus/platform/
// isn't in the require search path from here, e.g. in shared-mcp/bus/ context).
function getPlatformAdapter() {
  try {
    return require("./platform/index.js").platform;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Drive detection (Windows only)
// ---------------------------------------------------------------------------

const MIN_FREE_SPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB minimum

/**
 * Get free space for a Windows drive letter in bytes — async, short timeout.
 * Returns 0 if the drive doesn't exist or can't be accessed.
 * @param {string} driveLetter  e.g. "D"
 * @returns {Promise<number>} bytes free, or 0
 */
async function getDriveFreeSpaceAsync(driveLetter) {
  if (process.platform !== "win32") return 0;

  const { spawn } = await import("node:child_process");
  const psScript = `[math]::Round((Get-PSDrive -Name '${driveLetter}' | Select-Object -ExpandProperty Free) / 1KB)`;

  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { windowsHide: true }
    );
    let stdout = "";

    const timer = setTimeout(() => {
      try { process.kill && child.kill(); } catch { /* ignore */ }
      resolve(0);
    }, 400);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", () => {
      clearTimeout(timer);
      const kb = parseFloat(stdout.trim());
      resolve(isNaN(kb) ? 0 : Math.round(kb * 1024));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

/**
 * Scan available drive letters in parallel and return the one with the most free space.
 * Skips drives with less than MIN_FREE_SPACE_BYTES free.
 * Runs all drive checks concurrently with a 400ms timeout per drive.
 * @returns {Promise<{ drive: string, path: string, freeBytes: number } | null>}
 */
async function detectBestDriveAsync() {
  // Scan D through Z (A/B/C are usually system drives)
  // ASCII: 'D'=68, 'E'=69, ... 'Z'=90
  const letters = [];
  for (let i = 68; i <= 90; i++) {
    letters.push(String.fromCharCode(i));
  }

  // Check which drives are accessible in parallel (quick accessSync scan)
  const accessPromises = letters.map(async (letter) => {
    const root = `${letter}:\\`;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      return letter;
    } catch {
      return null;
    }
  });

  const accessibleLetters = (await Promise.all(accessPromises)).filter(Boolean);

  if (accessibleLetters.length === 0) return null;

  // Check free space for all accessible drives in parallel (400ms timeout each)
  const spacePromises = accessibleLetters.map(async (letter) => {
    const freeBytes = await getDriveFreeSpaceAsync(letter);
    return { letter, freeBytes };
  });

  const results = await Promise.all(spacePromises);
  const candidates = results.filter((r) => r.freeBytes >= MIN_FREE_SPACE_BYTES);

  if (candidates.length === 0) return null;

  // Sort by free space descending, pick the best
  candidates.sort((a, b) => b.freeBytes - a.freeBytes);
  const best = candidates[0];
  return {
    drive: best.letter + ":",
    path: path.join(best.letter + ":", ".ai-memory"),
    freeBytes: best.freeBytes,
  };
}

/**
 * Synchronous stub — runs detectBestDriveAsync and returns null.
 * Exported for backward compatibility; callers should migrate to detectBestDriveAsync().
 * @deprecated Use detectBestDriveAsync() for non-blocking behavior.
 * @returns {null}
 */
function detectBestDrive() {
  // Blocking stub — real work is async. Sync callers should migrate.
  return null;
}

// ---------------------------------------------------------------------------
// Default store root constant (cross-platform via platform.storeRootDefault)
// ---------------------------------------------------------------------------

/**
 * Default store root when all other resolution mechanisms are unavailable.
 * Exported so all sibling modules can import it as a consistent fallback
 * instead of each hardcoding their own path string.
 * @type {string}
 */
const DEFAULT_STORE_ROOT = (() => {
  try {
    const p = require("./platform/index.js").platform;
    return p?.storeRootDefault || "E:\\.ai-memory";
  } catch {
    return "E:\\.ai-memory";
  }
})();

// ---------------------------------------------------------------------------
// Store root resolution
// ---------------------------------------------------------------------------

let cachedStoreRoot = null;

/**
 * Check if a path exists and is a directory.
 * @param {string} p
 * @returns {boolean}
 */
function isDirectory(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the memory store root path — synchronous fast path.
 * Uses AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT env var or falls back to
 * AI_MEMORY_ROOT/.ai-memory / DEFAULT_STORE_ROOT.  Drive-scanning is deferred
 * to resolveStoreRootAsync() so this path never blocks.
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {string}  Absolute path to the store root
 */
function resolveStoreRoot(options = {}) {
  if (cachedStoreRoot && !options.refresh) {
    return cachedStoreRoot;
  }

  const STORE_NAME = ".ai-memory";

  // 1. User-specified via env var
  for (const envKey of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate) {
      const resolved = path.resolve(candidate);
      cachedStoreRoot = resolved;
      return resolved;
    }
  }

  // 2. Fast fallback (drive-scan is async — use resolveStoreRootAsync for that)
  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || "";
  const fallback = aiMemoryRoot
    ? path.join(aiMemoryRoot, STORE_NAME)
    : DEFAULT_STORE_ROOT;

  cachedStoreRoot = fallback;
  return fallback;
}

/**
 * Resolve the memory store root path — async version with parallel drive scanning.
 *
 * Resolution order:
 *   1. AI_MEMORY_STORE env var (user-specified)
 *   2. Auto-detect best drive via parallel scan (Windows only, ~400ms)
 *   3. Fallback to AI_MEMORY_ROOT/.ai-memory or DEFAULT_STORE_ROOT
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<string>} Absolute path to the store root
 */
async function resolveStoreRootAsync(options = {}) {
  if (cachedStoreRoot && !options.refresh) {
    return cachedStoreRoot;
  }

  const STORE_NAME = ".ai-memory";

  // 1. User-specified via env var
  for (const envKey of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate) {
      const resolved = path.resolve(candidate);
      cachedStoreRoot = resolved;
      return resolved;
    }
  }

  // 2. Auto-detect best drive in parallel (Windows only)
  if (process.platform === "win32") {
    const best = await detectBestDriveAsync();
    if (best) {
      cachedStoreRoot = best.path;
      return cachedStoreRoot;
    }
  }

  // 3. Fallback
  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || "";
  const fallback = aiMemoryRoot
    ? path.join(aiMemoryRoot, STORE_NAME)
    : DEFAULT_STORE_ROOT;

  cachedStoreRoot = fallback;
  return fallback;
}

/**
 * Ensure the store root directory exists (create if missing).
 * @param {{ refresh?: boolean }} [options]
 * @returns {string} store root path
 */
function ensureStoreRoot(options = {}) {
  const root = resolveStoreRoot(options);
  if (!isDirectory(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

// ---------------------------------------------------------------------------
// Derived path helpers
// ---------------------------------------------------------------------------

/** @returns {string} path/to/store/inbox */
function getInboxRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "inbox");
}

/** @returns {string} path/to/store/generated */
function getGeneratedRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "generated");
}

/** @returns {string} path/to/store/kg */
function getKgRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "kg");
}

/** @returns {string} path/to/store/kg/knowledge-graph.sqlite3 */
function getKgDbPath(storeRoot) {
  return path.join(getKgRoot(storeRoot), "knowledge-graph.sqlite3");
}

/** @returns {string} path/to/store/structured */
function getStructuredRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "structured");
}

/** @returns {string} path/to/store/projects — LLM-extracted facts per project */
function getProjectsRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "projects");
}

/** @returns {string} path/to/store/sessions — raw transcript archives */
function getSessionsRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "sessions");
}

/** @returns {string} path/to/store/CONTEXT.md — auto-generated, for passive agents */
function getContextPath(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "CONTEXT.md");
}

module.exports = {
  DEFAULT_STORE_ROOT,
  resolveStoreRoot,
  resolveStoreRootAsync,
  ensureStoreRoot,
  getInboxRoot,
  getGeneratedRoot,
  getKgRoot,
  getKgDbPath,
  getStructuredRoot,
  getProjectsRoot,
  getSessionsRoot,
  getContextPath,
  detectBestDrive,
  detectBestDriveAsync,
  MIN_FREE_SPACE_BYTES,
};
