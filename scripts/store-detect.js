/**
 * scripts/store-detect.js
 * Cross-platform memory store detection.
 * Replaces the old Obsidian vault detection.
 *
 * Usage: node scripts/store-detect.js
 * Output: store path to stdout, or exits with code 1
 *
 * Resolution order:
 *   1. AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT env vars
 *   2. .ai-memory or ai-memory directory under user home
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE || '';

/**
 * Check if a path exists and is a directory.
 * @param {string} candidate
 * @returns {boolean}
 */
function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get store candidates for the current platform.
 * @returns {string[]}
 */
function getStoreCandidates() {
  if (process.platform === 'win32') {
    return [
      path.join(HOME, '.ai-memory'),
      path.join(HOME, 'ai-memory'),
      'E:\\.ai-memory',
      'E:\\ai-memory',
    ];
  }
  // macOS / Linux
  return [
    path.join(HOME, '.ai-memory'),
    path.join(HOME, 'ai-memory'),
  ];
}

/**
 * Resolve the store path using the full priority chain.
 * @returns {string|null}
 */
function resolveStorePath() {
  // Priority 1: environment variables
  for (const envKey of ['AI_MEMORY_STORE', 'AI_MEMORY_STORE_ROOT']) {
    const val = process.env[envKey];
    if (val && isDirectory(val)) {
      return path.resolve(val);
    }
  }

  // Priority 2: default candidates
  const fallback = getStoreCandidates().find((c) => isDirectory(c));
  if (fallback) return path.resolve(fallback);

  return null;
}

const storePath = resolveStorePath();
if (storePath) {
  console.log(storePath);
  process.exit(0);
} else {
  console.error('Error: No memory store found. Set AI_MEMORY_STORE environment variable.');
  process.exit(1);
}
