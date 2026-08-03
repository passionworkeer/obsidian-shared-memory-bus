// ops/util/safe-realpath.js
// Path containment checks shared by memory readers and writers.

import fs from "node:fs";
import path from "node:path";

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(candidate, root) {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}

/**
 * Verify that filePath resolves within safeRoot.
 *
 * Existing targets are realpath-resolved all the way through the final path
 * component, so a file symlink cannot hide an external target. For a path that
 * does not exist yet, its real parent is checked and the basename is appended;
 * callers that create the file should still use O_NOFOLLOW/lstat protections
 * while opening it to close the final-component race.
 */
export function safeRealpathWithin(filePath, safeRoot) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(safeRoot);
  } catch {
    return null;
  }

  let candidate;
  try {
    candidate = fs.existsSync(filePath)
      ? fs.realpathSync(filePath)
      : path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  } catch {
    return null;
  }

  return isWithin(candidate, realRoot) ? candidate : null;
}

export function isPathWithin(candidate, root) {
  return isWithin(candidate, root);
}
