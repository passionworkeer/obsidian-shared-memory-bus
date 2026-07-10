// Path constants and project path resolution for the omni-memory-server.
//
// This module is intentionally side-effect-free at import time. It re-exports
// the store-root resolver from bus/store-root.js and provides the project-path
// resolution helper used to locate files in the project dir (e.g. ops/, bus/,
// retrieval/) versus the data dir (AI_MEMORY_ROOT).
//
// The actual STORE_ROOT / MEMORY_STORE_ROOT / STRUCTURED_ROOT / ... constants
// are computed in the entrypoint after resolveStoreRoot() runs, because they
// depend on the resolved store root path. Keep that single computation in one
// place (omni-memory-server.js) to avoid drift between callers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStoreRoot } from "../bus/store-root.js";

// --- ESM globals and constants (must be defined before any code that uses them) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is always the parent of shared-mcp/
// Use import.meta.url to reliably determine project root regardless of cwd
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

// --- Derived constants (must be before resolveProjectPath) ---
export const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
export const IS_WINDOWS = process.platform === "win32";
// Detect project root: if AI_MEMORY_ROOT is not set, default to the project root
// (parent of shared-mcp/), not a separate .ai-memory data dir
export const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..");

// --- resolveProjectPath (must be after AI_MEMORY_ROOT and PROJECT_ROOT) ---
// Used for files that live in the project dir (e.g. ops/), not the data dir
export function resolveProjectPath(relPath) {
  for (const base of [process.cwd(), PROJECT_ROOT]) {
    const candidate = path.join(base, relPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Last resort: use PROJECT_ROOT
  return path.join(PROJECT_ROOT, relPath);
}

// Re-export the store-root resolver so callers don't need a second import.
export { resolveStoreRoot };