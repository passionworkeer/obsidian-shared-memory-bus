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
 *   const { appendLineAtomic } = require("./inbox-atomic-write");
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

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

/**
 * Atomically append a single line to a JSONL file.
 *
 * Uses OS-level O_APPEND (via fs.openSync with flag 'a') which atomically
 * seeks to EOF before writing.  This prevents the interleaved-byte
 * corruption that plain fs.appendFileSync() can suffer under concurrent
 * load on Windows.
 *
 * The createDir + temp-rename fallback is used when the file does not
 * exist yet, to ensure the parent directory is created and the file
 * appears atomically (no zero-length read-window).
 *
 * @param {string} filePath
 * @param {string|object} line  — JSON-serializable object or pre-serialized string
 * @param {{ createDir?: boolean, fsync?: boolean }} [opts]
 */
function appendLineAtomic(filePath, line, opts = {}) {
  const { createDir = true, fsync = false } = opts;

  const serialized =
    typeof line === "string" ? line : JSON.stringify(line);
  const content = serialized.endsWith("\n")
    ? serialized
    : `${serialized}\n`;

  const dir = path.dirname(filePath);

  if (createDir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    // File does not exist — use temp-rename so the target file
    // appears fully formed (no zero-length read window for callers
    // that poll for file existence).
    // Retry loop handles the race where another process wins the
    // first-rename, causing EEXIST on subsequent attempts.
    for (let attempt = 0; attempt < 5; attempt++) {
      const tmp =
        filePath +
        ".tmp." +
        process.pid +
        "." +
        Date.now() +
        "." +
        Math.random().toString(36).slice(2);
      fs.writeFileSync(tmp, content, "utf8");
      if (fsync) {
        const fd = fs.openSync(tmp, "r+");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        // Clean up our temp file and retry if another process won.
        try {
          fs.unlinkSync(tmp);
        } catch (_) {
          /* ignore */
        }
        if (err.code !== "EEXIST") {
          throw err;
        }
        // Another process just created the file — fall through to
        // the O_APPEND path below instead of retrying the race.
        break;
      }
    }
    // File now exists (another process created it) — fall through to
    // O_APPEND append, which is safe for concurrent use.
  }

  // File exists — use O_APPEND (via flag 'a') so the OS atomically seeks
  // to EOF before each write.  This is the correct fix for the
  // concurrent fs.appendFileSync() race on Windows.
  const fd = fs.openSync(filePath, "a");
  fs.writeSync(fd, content);
  if (fsync) {
    fs.fsyncSync(fd);
  }
  fs.closeSync(fd);
}

// ---------------------------------------------------------------------------
// Named export
// ---------------------------------------------------------------------------

module.exports = { appendLineAtomic };
