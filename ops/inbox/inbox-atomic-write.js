/**
 * ops/inbox-atomic-write.js
 * =========================
 * Atomic single-line append for JSONL inbox files.
 *
 * Uses the rename-over-target POSIX atomic guarantee:
 *   1. Read current file content (empty if absent).
 *   2. Write content + new line to a temp file in the same directory.
 *   3. Rename temp file over the target.
 *
 * The rename is atomic on both POSIX and Windows (when the source and
 * destination are on the same volume), eliminating the race-condition
 * window that causes `fs.appendFileSync()` to drop lines under concurrent
 * load.
 *
 * API
 * ---
 *   import { appendLineAtomic } from "./inbox-atomic-write.js";
 *
 *   appendLineAtomic(filePath, line, opts?);
 *
 *   line  — string or any JSON-serializable value.
 *            Strings already ending in "\n" are accepted as-is.
 *
 *   opts.createDir  (default: true) — create parent directories recursively.
 *   opts.fsync      (default: false) — fsync the temp file before rename.
 *                                      Enable when durability matters more
 *                                      than throughput.
 *
 * RATIONALE
 * ---------
 * `fs.appendFileSync()` maps to WriteFile with FILE_APPEND_DATA on Windows.
 * When two processes call it simultaneously the OS may interleave the
 * buffers, causing partial lines or silently dropped records.
 * The rename-over-target pattern is the canonical cross-platform fix.
 */

import fs from "node:fs";
import path from "node:path";
import { safeRealpathWithin } from "../memory/paths-and-io.js";

/**
 * Atomically append a single line to a JSONL file.
 *
 * Uses O_APPEND (fs.openSync flag 'a') which atomically creates the file
 * if it does not exist and seeks to EOF before each write. This is the
 * correct cross-platform primitive for concurrent appends: the OS
 * guarantees the write happens at EOF under the kernel file lock, so no
 * lines are dropped or interleaved.
 *
 * The previous temp-rename strategy for first-write was unsound under
 * concurrency: fs.renameSync() silently overwrites the destination (it
 * does NOT throw EEXIST), so concurrent first-writers clobber each other,
 * and on Windows rename fails with EPERM when the target is open in
 * another process. O_APPEND avoids both issues.
 *
 * @param {string} filePath
 * @param {string|object} line  — JSON-serializable object or pre-serialized string
 * @param {{ createDir?: boolean, fsync?: boolean, safeRoot?: string }} [opts]
 *   - safeRoot: when set, the resolved (realpath) filePath must lie
 *     within this directory. Refuses writes that would follow a symlink
 *     out of the safe root. Backward compatible — omit to skip the check.
 */
function appendLineAtomic(filePath, line, opts = {}) {
  const { createDir = true, fsync = false, safeRoot = "" } = opts;

  const serialized =
    typeof line === "string" ? line : JSON.stringify(line);
  const content = serialized.endsWith("\n")
    ? serialized
    : `${serialized}\n`;

  const dir = path.dirname(filePath);

  if (createDir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (safeRoot) {
    // Re-check after createDir so the parent directory exists for
    // realpath. The check is cheap; safeRealpathWithin handles missing
    // parents gracefully by returning null.
    const validated = safeRealpathWithin(filePath, safeRoot);
    if (!validated) {
      throw new Error(
        `appendLineAtomic: refusing write to ${filePath} (escapes safeRoot ${safeRoot})`
      );
    }
  }

  // O_APPEND (flag 'a') atomically creates the file if absent and seeks
  // to EOF before each write. This is safe for concurrent use on both
  // POSIX (O_APPEND is atomic for writes under PIPE_BUF) and Windows
  // (FILE_APPEND_DATA). No temp-rename race, no EPERM on locked target.
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, content);
    if (fsync) {
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Named export
// ---------------------------------------------------------------------------

export { appendLineAtomic };
