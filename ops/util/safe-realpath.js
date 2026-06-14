// ops/util/safe-realpath.js
// Path containment check for file-read operations. Stateless, side-effect-free
// (does not import anything that resolves store roots), so it can be imported
// from both barrel modules (paths-and-io.js) and CLI tools that take an
// explicit --store-root argument without triggering module-init side effects.

import fs from "node:fs";
import path from "node:path";

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
export function safeRealpathWithin(filePath, safeRoot) {
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
