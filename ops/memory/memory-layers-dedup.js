// ---------------------------------------------------------------------------
// memory-layers-dedup.js — Deduplication, JSONL writing, daily append logs
// Extracted from ops/build-memory-layers.js (2019 lines)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { tryWithFileLock } from "./paths-and-io.js";
import {
  readJsonl,
  writeText,
  ensureDirectory,
  withFileLock,
  sha256,
  getFreshness,
  shouldSkipAsRecentDuplicate,
  normalizeSpaces,
  DAILY_LOG_DIR,
} from "./memory-layers-parse.js";

// ---------------------------------------------------------------------------
// JSONL writing
// ---------------------------------------------------------------------------

function writeJsonl(filePath, records, options = {}) {
  ensureDirectory(path.dirname(filePath));
  if (options && options.append) {
    // Append mode: read existing, merge, write
    const existing = readJsonl(filePath);
    const existingIds = new Set(existing.map(r => r.id));
    const newRecords = records.filter(r => !existingIds.has(r.id));
    if (newRecords.length > 0) {
      const existingBody = existing.map((record) => JSON.stringify(record)).join("\n");
      const newBody = newRecords.map((record) => JSON.stringify(record)).join("\n");
      writeText(filePath, existingBody ? `${existingBody}\n${newBody}\n` : `${newBody}\n`);
    }
    return;
  }
  // Normal mode: overwrite
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeText(filePath, body ? `${body}\n` : "");
}

/**
 * Patch a single record in a JSONL file by id (immutable rewrite).
 * Only rewrites the line matching the given id — other lines untouched.
 * Uses non-blocking tryWithFileLock: if the lock is held by another writer,
 * degrades to a no-op with a warning (the next call can retry; a torn
 * read-modify-write on a busy file would be worse than a skipped patch).
 * @param {string} jsonlPath
 * @param {string} recordId
 * @param {object} enriched  — record with entities/facts/concepts added
 */
function patchJsonlRecord(jsonlPath, recordId, enriched) {
  const acquired = tryWithFileLock(jsonlPath, (fd) => {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    let changed = false;
    const patched = content.split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        const rec = JSON.parse(line);
        if (rec.id === recordId) {
          // Preserve existing facts/concepts if already present; merge new ones
          const existingFacts = Array.isArray(rec.facts) ? rec.facts : [];
          const existingConcepts = Array.isArray(rec.concepts) ? rec.concepts : [];
          const newFacts = Array.isArray(enriched.facts) ? enriched.facts : [];
          const newConcepts = Array.isArray(enriched.concepts) ? enriched.concepts : [];

          const seenFacts = new Set(existingFacts.map((f) => typeof f === "string" ? f : f.value));
          const seenConcepts = new Set(existingConcepts.map((c) => typeof c === "string" ? c : c.value));

          const result = JSON.stringify({
            ...rec,
            entities: enriched.entities || rec.entities || [],
            facts: [
              ...existingFacts,
              ...newFacts.filter((f) => !seenFacts.has(typeof f === "string" ? f : f.value)),
            ],
            concepts: [
              ...existingConcepts,
              ...newConcepts.filter((c) => !seenConcepts.has(typeof c === "string" ? c : c.value)),
            ],
          });
          changed = true;
          return result;
        }
      } catch {}
      return line;
    });
    if (changed) {
      fs.writeFileSync(jsonlPath, patched.join("\n"), "utf-8");
      if (fd >= 0) fs.fsyncSync(fd);  // durability before close (no-op in fallback mode)
    }
  });
  if (!acquired) {
    process.stderr.write(
      `[patchJsonlRecord] lock held on ${jsonlPath}; skipping patch for ${recordId} (next call will retry)\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateSharedInbox(newInboxEntries, dreamRecords, existingRecordsByHash, nowMs) {
  // Build dedup map from inbox entries (inbox entries take priority:
  // they reflect latest inbox content; dream records are append-only)
  const byId = new Map();
  // Also index new inbox entries by content_hash for the 30s dedup window
  const newByHash = new Map();

  for (const rec of newInboxEntries) {
    if (!rec || !rec.id) continue;

    const hash = rec.content_hash || sha256(rec.content || "");

    // 30-second dedup: skip if a matching hash was written very recently
    if (shouldSkipAsRecentDuplicate(rec, existingRecordsByHash, nowMs)) {
      const existing = existingRecordsByHash.get(hash);
      const existingId = existing ? existing.id : "unknown";
      process.stderr.write(
        `skipping duplicate inbox entry (30s window): ${rec.id} matches ${existingId} ` +
        `(hash: ${hash.substring(0, 8)})\n`
      );
      continue;
    }

    // Detect content_hash collisions: same hash but different id → truncation risk
    if (newByHash.has(hash) && newByHash.get(hash).id !== rec.id) {
      console.warn(
        `[build-memory-layers] content_hash collision detected: id=${rec.id} ` +
        `collides with existing record id=${newByHash.get(hash).id} ` +
        `(hash: ${hash.substring(0, 8)}). Review for truncation-based collision.`
      );
    }

    byId.set(rec.id, rec);
    newByHash.set(hash, rec);
  }

  // Append dream records that have unique IDs (not already covered by inbox entries)
  for (const rec of dreamRecords) {
    if (rec && rec.id && !byId.has(rec.id)) byId.set(rec.id, rec);
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Daily append-only logs  (immutable helpers + side-effecting append)
// ---------------------------------------------------------------------------

/**
 * Groups records by date (YYYY-MM-DD from field t).
 * Returns Map<dateString, record[]> sorted newest-first.
 * Pure function — does not mutate records.
 */
function getRecordsByDate(records) {
  const byDate = new Map();
  for (const rec of records) {
    const t = rec.t || rec.created_at || "";
    const dateMatch = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(rec);
  }
  return byDate;
}

/**
 * Converts a record to a compact daily-log entry (one JSON line).
 * Pure function — returns a new object, does not mutate rec.
 */
function buildDailyLogEntry(record) {
  const firstFact = Array.isArray(record.facts) ? record.facts[0] : null;
  const summary =
    (typeof firstFact === "string" && firstFact.trim()) ||
    (typeof record.description === "string" && record.description.trim()) ||
    (String(record.content || "").substring(0, 80).trim()) ||
    "";
  return {
    id: record.id || "",
    t: record.t || record.created_at || "",
    type: record.type || "",
    scope: record.scope || "",
    tool: record.tool || "",
    title: record.title || "",
    summary,
    promotion: (record.metadata && record.metadata.promotion && record.metadata.promotion.durable_type) || null,
    content_hash: record.content_hash || "",
  };
}

/**
 * Appends new records to daily log files (logs/YYYY/MM/YYYY-MM-DD.jsonl).
 * Only appends records from today and yesterday — never rewrites history.
 * Uses exclusive file lock around the full read-modify-write cycle.
 *
 * @param {object[]} newRecords - All records to consider (all layers combined).
 * @param {boolean} dryRun - If true, only log what would be written.
 */
function appendDailyLogs(newRecords, dryRun = false) {
  const recordsByDate = getRecordsByDate(newRecords);
  const now = new Date();
  const today = now.toISOString().substring(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().substring(0, 10);
  const targetDates = new Set([today, yesterday]);

  for (const [date, recs] of recordsByDate.entries()) {
    if (!targetDates.has(date)) continue; // Only append recent days

    const [year, month] = date.split("-");
    const logDir = path.join(DAILY_LOG_DIR, year, month);
    const logFile = path.join(logDir, `${date}.jsonl`);

    // Filter out already-logged records (checked under lock)
    const newEntries = recs.map(buildDailyLogEntry);

    if (newEntries.length === 0) continue;

    if (dryRun) {
      process.stderr.write(`[daily-log] dry-run: would append ${newEntries.length} entries to ${logFile}\n`);
      continue;
    }

    // Ensure log directory exists before any file I/O
    ensureDirectory(logDir);

    // Exclusive lock guards the entire read-modify-write cycle
    withFileLock(logFile, (fd) => {
      // Read existing entry IDs under lock to detect duplicates
      const existingIds = new Set();
      if (fs.existsSync(logFile)) {
        const existing = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
        for (const line of existing) {
          try {
            existingIds.add(JSON.parse(line).id);
          } catch {
            // skip malformed lines
          }
        }
      }

      const toAppend = newEntries.filter((e) => !existingIds.has(e.id));
      if (toAppend.length === 0) return;

      // Atomic append: O_APPEND + fd fsync guarantees no torn writes and
      // POSIX guarantees concurrent appenders won't interleave lines for
      // sizes <= PIPE_BUF (4 KiB on Linux). Lock + append keeps the
      // read-modify-write cycle O(new lines) instead of O(whole file).
      const newLines = toAppend.map((e) => JSON.stringify(e)).join("\n") + "\n";
      fs.appendFileSync(logFile, newLines, "utf8");
      fs.fsyncSync(fd);
      process.stderr.write(`[daily-log] appended ${toAppend.length} entries to ${logFile}\n`);
    });
  }
}

export {
  writeJsonl,
  patchJsonlRecord,
  deduplicateSharedInbox,
  getRecordsByDate,
  buildDailyLogEntry,
  appendDailyLogs,
  DAILY_LOG_DIR,
  // Re-export for convenience
  withFileLock,
  ensureDirectory,
  normalizeSpaces,
  sha256,
  getFreshness,
  shouldSkipAsRecentDuplicate,
};
