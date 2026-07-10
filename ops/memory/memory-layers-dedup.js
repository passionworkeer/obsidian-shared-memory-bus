// ---------------------------------------------------------------------------
// memory-layers-dedup.js — Deduplication, JSONL writing, daily append logs
// Extracted from ops/build-memory-layers.js (2019 lines)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeText, appendText, ensureDirectory, withFileLock, tryWithFileLock } from "./paths-and-io.js";
import { sha256, getFreshness, shouldSkipAsRecentDuplicate, normalizeSpaces, DAILY_LOG_DIR } from "./memory-layers-parse.js";

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
 * Patch a single record in a JSONL file by id (append-only).
 *
 * Old behaviour was O(whole file): read file, splice the line matching the
 * given id, write the entire file back. This was both slow and unsafe under
 * concurrent writers (torn read-modify-write on a busy file).
 *
 * New behaviour is O(1): append a `__patch` envelope to a companion file
 * `<jsonlPath>.patches.jsonl`. The main JSONL is never rewritten. Consumers
 * that need the latest state of every record should call `readJsonlWithPatches`
 * (see memory-layers-parse.js), which merges the patch log onto the base
 * file with last-wins semantics.
 *
 * `tryWithFileLock` is used so the side-file append is atomic even on
 * filesystems without O_APPEND atomicity guarantees for partial lines.
 *
 * @param {string} jsonlPath
 * @param {string} recordId
 * @param {object} enriched  — record with entities/facts/concepts added
 * @returns {boolean} true if patch was written; false if the lock was held
 *                   and the patch was deferred to the next call
 */
function patchJsonlRecord(jsonlPath, recordId, enriched) {
  const patchPath = `${jsonlPath}.patches.jsonl`;
  const enrichedFacts = Array.isArray(enriched.facts) ? enriched.facts : [];
  const enrichedConcepts = Array.isArray(enriched.concepts) ? enriched.concepts : [];
  const enrichedEntities = Array.isArray(enriched.entities) ? enriched.entities : [];

  // We still need the existing facts/concepts/entities to merge with new ones
  // (dedup by string value). A read of the patch log (small, O(patches only))
  // is dramatically cheaper than a read of the base file.
  const existingMerged = { facts: new Set(), concepts: new Set() };
  if (fs.existsSync(patchPath)) {
    for (const patch of readJsonl(patchPath)) {
      if (patch.__patch !== recordId) continue;
      for (const f of patch.facts || []) existingMerged.facts.add(typeof f === "string" ? f : f.value);
      for (const c of patch.concepts || []) existingMerged.concepts.add(typeof c === "string" ? c : c.value);
    }
  }

  const seenFacts = existingMerged.facts;
  const seenConcepts = existingMerged.concepts;
  const mergedFacts = [
    ...seenFacts,
    ...enrichedFacts.filter((f) => !seenFacts.has(typeof f === "string" ? f : f.value)),
  ];
  const mergedConcepts = [
    ...seenConcepts,
    ...enrichedConcepts.filter((c) => !seenConcepts.has(typeof c === "string" ? c : c.value)),
  ];

  const payload = JSON.stringify({
    __patch: recordId,
    _patchedAt: new Date().toISOString(),
    entities: enrichedEntities,
    facts: mergedFacts,
    concepts: mergedConcepts,
  }) + "\n";

  const acquired = tryWithFileLock(patchPath, () => {
    appendText(patchPath, payload);
  });
  if (!acquired) {
    process.stderr.write(
      `[patchJsonlRecord] lock held on ${patchPath}; skipping patch for ${recordId} (next call will retry)\n`
    );
  }
  return acquired;
}

/**
 * Read a JSONL file merged with its companion `.patches.jsonl` log.
 * Last-wins by record id. facts/concepts/entities arrays are merged
 * with dedup (base then patch) so the patch layer does not need to
 * repeat facts that were already on the base record.
 *
 * @param {string} jsonlPath
 * @returns {object[]}
 */
function readJsonlWithPatches(jsonlPath) {
  const base = readJsonl(jsonlPath);
  const patchPath = `${jsonlPath}.patches.jsonl`;
  if (!fs.existsSync(patchPath)) return base;

  const byId = new Map();
  for (const rec of base) {
    if (rec && rec.id) byId.set(rec.id, rec);
  }
  for (const patch of readJsonl(patchPath)) {
    if (!patch || !patch.__patch) continue;
    const id = patch.__patch;
    const existing = byId.get(id) || { id };
    byId.set(id, mergePatch(existing, patch));
  }
  return Array.from(byId.values());
}

function mergeRecordValues(base, patch, key) {
  const baseArr = Array.isArray(base[key]) ? base[key] : [];
  const patchArr = Array.isArray(patch[key]) ? patch[key] : [];
  if (patchArr.length === 0) return baseArr;
  const seen = new Set(baseArr.map((v) => typeof v === "string" ? v : v.value));
  const result = [...baseArr];
  for (const item of patchArr) {
    const key2 = typeof item === "string" ? item : item.value;
    if (!seen.has(key2)) {
      result.push(item);
      seen.add(key2);
    }
  }
  return result;
}

function mergePatch(base, patch) {
  return {
    ...base,
    entities: mergeRecordValues(base, patch, "entities"),
    facts: mergeRecordValues(base, patch, "facts"),
    concepts: mergeRecordValues(base, patch, "concepts"),
  };
}

/**
 * Compact a JSONL file's companion patch log into the base file.
 * Rewrites the base file in last-wins order; clears the patch log.
 * Intended to run periodically (e.g. nightly) so the patch log does not
 * grow unbounded. Safe to run while readers are active — they will see
 * the pre-compaction state until they re-read.
 *
 * @param {string} jsonlPath
 * @returns {{merged: number, removedPatches: number}}
 */
function compactPatches(jsonlPath) {
  const patchPath = `${jsonlPath}.patches.jsonl`;
  if (!fs.existsSync(patchPath)) return { merged: 0, removedPatches: 0 };

  const merged = readJsonlWithPatches(jsonlPath);
  const removedPatches = readJsonl(patchPath).length;
  const body = merged.length
    ? merged.map((rec) => JSON.stringify(rec)).join("\n") + "\n"
    : "";
  writeText(jsonlPath, body);
  try { fs.unlinkSync(patchPath); } catch {}
  return { merged: merged.length, removedPatches };
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
 * Stream-extracts the set of `id` values from a daily JSONL log without
 * materialising a split array or JSON.parsing every line. Returns Set<id>.
 * Pure reader — does not mutate the file. Returns empty Set if absent.
 *
 * WHY regex over JSON.parse-per-line: dedup only needs the `id` field, so a
 * single stateless scan avoids constructing per-line objects and a temporary
 * line array, lowering the constant factor of the unavoidable O(file) pass.
 */
function scanExistingIds(logFile) {
  if (!fs.existsSync(logFile)) return new Set();
  const buf = fs.readFileSync(logFile, "utf8");
  const ids = new Set();
  // Match "id":"<value>" — value is any char not a double-quote or backslash.
  // buildDailyLogEntry always serialises id as a JSON string, so this is safe.
  const re = /"id"\s*:\s*"([^"\\]*)"/g;
  let m;
  while ((m = re.exec(buf)) !== null) ids.add(m[1]);
  return ids;
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

    // Exclusive lock guards the read-dedup-append cycle.
    // WHY scan-and-append (not pure append-only): dedup contract requires
    // detecting ids already written by prior calls in this same daily file.
    // Pure append-only would emit duplicate lines on repeated builds; we keep
    // O(file) id scan but avoid readFileSync+split+JSON.parse double-buffering
    // by streaming the buffer once with a single id-extracting regex.
    withFileLock(logFile, (fd) => {
      const existingIds = scanExistingIds(logFile);

      // In-memory dedup of the incoming batch first — pure O(new entries),
      // no file I/O — so only genuinely new ids trigger the file scan filter.
      const seenNow = new Set();
      const toAppend = [];
      for (const entry of newEntries) {
        if (seenNow.has(entry.id) || existingIds.has(entry.id)) continue;
        seenNow.add(entry.id);
        toAppend.push(entry);
      }
      if (toAppend.length === 0) return;

      // Atomic append: O_APPEND + fd fsync guarantees no torn writes and
      // POSIX guarantees concurrent appenders won't interleave lines for
      // sizes <= PIPE_BUF (4 KiB on Linux). Lock + append keeps the write
      // phase O(new lines) regardless of file size.
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
  readJsonlWithPatches,
  compactPatches,
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
