/**
 * bus/store-root.js
 * ================
 * Resolves the memory store root path — no Obsidian dependency.
 *
 * Priority:
 *   1. AI_MEMORY_STORE env var (user-specified absolute path)
 *   2. Auto-detect best drive: scan D:/E:/F:/... pick the one with most free space
 *   3. Fallback: AI_MEMORY_ROOT + "\\.ai-memory"
 *
 * Usage:
 *   const { resolveStoreRoot } = require('./store-root');
 *   const inboxDir = resolveStoreRoot() + '/inbox';
 */

"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// Drive detection (Windows only)
// ---------------------------------------------------------------------------

const MIN_FREE_SPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB minimum

/**
 * Get free space for a Windows drive letter in bytes.
 * Returns 0 if the drive doesn't exist or can't be accessed.
 * @param {string} driveLetter  e.g. "D"
 * @returns {number} bytes free, or 0
 */
function getDriveFreeSpace(driveLetter) {
  if (!IS_WINDOWS) return 0;
  try {
    const psScript = `[math]::Round((Get-PSDrive -Name '${driveLetter}' | Select-Object -ExpandProperty Free) / 1KB)`;
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`,
      { windowsHide: true, timeout: 5000, encoding: "utf8" }
    );
    // Output is in KB — convert to bytes
    const kb = parseFloat(out.trim());
    return isNaN(kb) ? 0 : Math.round(kb * 1024);
  } catch {
    return 0;
  }
}

/**
 * Scan available drive letters and return the one with the most free space.
 * Skips drives with less than MIN_FREE_SPACE_BYTES free.
 * @returns {{ drive: string, path: string, freeBytes: number } | null}
 */
function detectBestDrive() {
  const candidates = [];

  // Scan D through Z (A/B/C are usually system drives)
  // ASCII: 'D'=68, 'E'=69, ... 'Z'=90
  for (let i = 68; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      // Check if drive exists by trying to access its root
      fs.accessSync(root, fs.constants.R_OK);
      const freeBytes = getDriveFreeSpace(letter);
      if (freeBytes >= MIN_FREE_SPACE_BYTES) {
        candidates.push({ letter, freeBytes });
      }
    } catch {
      // Drive doesn't exist or not accessible — skip
    }
  }

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
 * Resolve the memory store root path.
 *
 * Resolution order:
 *   1. AI_MEMORY_STORE env var (user-specified)
 *   2. Auto-detect best drive via scan
 *   3. Fallback to AI_MEMORY_ROOT/.ai-memory or E:\.ai-memory
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {string}  Absolute path to the store root (e.g. "E:\\.ai-memory")
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

  // 2. Auto-detect best drive
  if (IS_WINDOWS) {
    const best = detectBestDrive();
    if (best) {
      cachedStoreRoot = best.path;
      return cachedStoreRoot;
    }
  }

  // 3. Fallback: AI_MEMORY_ROOT/.ai-memory or E:\.ai-memory
  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || "";
  const fallback = aiMemoryRoot
    ? path.join(aiMemoryRoot, STORE_NAME)
    : path.join(process.env.USERPROFILE || "C:\\Users\\wang", STORE_NAME);

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

module.exports = {
  resolveStoreRoot,
  ensureStoreRoot,
  getInboxRoot,
  getGeneratedRoot,
  getKgRoot,
  getKgDbPath,
  getStructuredRoot,
  detectBestDrive,
  MIN_FREE_SPACE_BYTES,
};
