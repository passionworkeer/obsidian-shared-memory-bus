/**
 * memory-promotion-resolver.js — Resolves conflicts in the promotion queue.
 *
 * Resolution strategy:
 *   1. Higher score wins
 *   2. If scores within 0.1 of each other → both flagged for human review
 *   3. Tiebreaker: later last_access timestamp wins
 *
 * Usage:
 *   node ops/memory/memory-promotion-resolver.js [--vault-root <path>] [--dry-run] [--verbose]
 *        [--queue <path>]   (default: E:\.ai-memory\queue\promotion-queue.jsonl)
 */

import fs from "fs";
import path from "path";

// ── CLI args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt  = (flag, def) => {
  const idx = args.indexOf(flag);
  if (idx < 0) return def;
  const next = args[idx + 1];
  // If next arg looks like a flag, return true; otherwise return the value
  if (next === undefined || next.startsWith("-")) return true;
  return next;
};

const VAULT_ROOT = opt("--vault-root", process.env.AI_MEMORY_OBSIDIAN_VAULT || process.env.OBSIDIAN_VAULT_ROOT || null);
const DRY_RUN    = opt("--dry-run",    false);
const VERBOSE    = opt("--verbose",   false) || opt("-v", false);
const QUEUE_PATH = opt("--queue",     null);

if (!VAULT_ROOT) {
  console.error("Error: --vault-root or AI_MEMORY_OBSIDIAN_VAULT is required.");
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────────

const QUEUE_DIR       = path.join(VAULT_ROOT, ".ai-memory/queue");
const STRUCT_DIR      = path.join(VAULT_ROOT, "00-System/ai-memory/structured");
const DEFAULT_QUEUE   = path.join(QUEUE_DIR,  "promotion-queue.jsonl");
const RESOLVED_QUEUE  = path.join(QUEUE_DIR,  "resolved-queue.jsonl");
const REVIEW_QUEUE    = path.join(QUEUE_DIR,  "human-review-queue.jsonl");

const SCORE_TIE_THRESHOLD = 0.10; // if scores within this range → human review

// ── Logging ───────────────────────────────────────────────────────────────────

const log  = (...msg) => VERBOSE && console.log("[promotion-resolver]", new Date().toISOString(), ...msg);
const info = (...msg) => console.log("[promotion-resolver]", ...msg);
const warn = (...msg) => console.warn("[promotion-resolver] WARNING:", ...msg);
const err  = (...msg) => console.error("[promotion-resolver] ERROR:", ...msg);

// ── JSONL helpers ─────────────────────────────────────────────────────────────

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeJsonl(filePath, records) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Record loading ────────────────────────────────────────────────────────────

function loadStructuredRecords() {
  if (!fs.existsSync(STRUCT_DIR)) return [];
  return fs.readdirSync(STRUCT_DIR)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("archive-"))
    .flatMap((f) => parseJsonl(path.join(STRUCT_DIR, f)));
}

// ── Resolution helpers ─────────────────────────────────────────────────────────

/**
 * Get last access timestamp from a queue entry.
 * Prefers the full record if available, otherwise falls back to metadata.
 */
function getLastAccess(entry, recordMap) {
  const rec = recordMap.get(entry.id);
  if (rec) {
    const ts = rec.lifecycle?.last_access_at || rec.t;
    return ts ? new Date(ts).getTime() : 0;
  }
  return entry.scored_at ? new Date(entry.scored_at).getTime() : 0;
}

/**
 * Compare two queue entries for sorting (highest score first, then latest access).
 */
function compareEntries(a, b, recordMap) {
  if (b.score !== a.score) return b.score - a.score;
  // Tiebreaker: later last_access wins
  return getLastAccess(b, recordMap) - getLastAccess(a, recordMap);
}

/**
 * Build a map of conflicting groups.
 * Returns Map<winnerId, Set<loserId>> for all conflicting pairs.
 */
function buildConflictGraph(entries) {
  const graph = new Map(); // id → Set of conflicting ids

  for (const entry of entries) {
    if (!graph.has(entry.id)) graph.set(entry.id, new Set());
    for (const conflict of (entry.conflicts || [])) {
      graph.get(entry.id).add(conflict.otherId);
      if (!graph.has(conflict.otherId)) graph.set(conflict.otherId, new Set());
      graph.get(conflict.otherId).add(entry.id);
    }
  }

  return graph;
}

/**
 * Resolve conflicts within the promotion queue.
 *
 * For each conflict group:
 *   - Sort by (score DESC, last_access DESC)
 *   - Winner (highest) gets auto-promote
 *   - Losers within 0.1 score of winner → flagged needs_review
 *   - Losers with > 0.1 gap → dropped from queue
 *
 * @param {{id: string, score: number, conflicts: object[], needs_review: boolean, tier_from: number, tier_to: number}[]} queueEntries
 * @param {Map<string, object>} recordMap
 * @returns {{resolved: object[], dropped: object[], human_review: object[], resolution_log: string[]}}
 */
function resolveConflicts(queueEntries, recordMap) {
  const resolved     = [];
  const dropped     = [];
  const humanReview = [];
  const logMessages = [];
  const graph       = buildConflictGraph(queueEntries);

  // Entries already resolved (no conflicts)
  const conflictingIds = new Set();
  for (const [, set] of graph) {
    for (const id of set) conflictingIds.add(id);
  }

  // Process non-conflicting entries first
  for (const entry of queueEntries) {
    if (!conflictingIds.has(entry.id)) {
      resolved.push({
        ...entry,
        resolution: "auto",
        resolution_note: "no conflicts",
      });
    }
  }

  // Process conflicting groups via connected components
  const visited = new Set();

  for (const entry of queueEntries) {
    if (visited.has(entry.id)) continue;
    const component = new Set([entry.id]);
    const stack = [entry.id];

    // BFS to collect connected component
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = graph.get(current) || new Set();
      for (const n of neighbors) {
        if (!visited.has(n)) {
          component.add(n);
          stack.push(n);
        }
      }
    }

    if (component.size === 1) continue; // already handled above

    // Sort component by score DESC, last_access DESC
    const componentEntries = queueEntries
      .filter((e) => component.has(e.id))
      .sort((a, b) => compareEntries(a, b, recordMap));

    const winner = componentEntries[0];
    const losers = componentEntries.slice(1);

    logMessages.push(
      `Conflict group (${component.size} members): winner=${winner.id} ` +
      `(score=${winner.score.toFixed(4)}), losers=${losers.map((l) => `${l.id}(${l.score.toFixed(4)})`).join(", ")}`
    );

    // Winner: auto-promote
    resolved.push({
      ...winner,
      resolution:     "auto",
      resolution_note: `conflict_winner (beats ${losers.length} conflicting entries)`,
      needs_review:   false,
    });

    // Losers
    for (const loser of losers) {
      const scoreGap = winner.score - loser.score;

      if (scoreGap <= SCORE_TIE_THRESHOLD) {
        // Within 0.1 → human review
        humanReview.push({
          ...loser,
          resolution:     "human_review",
          resolution_note: `conflict_tie: score_gap=${scoreGap.toFixed(4)} <= ${SCORE_TIE_THRESHOLD}`,
          needs_review:   true,
          winner_id:      winner.id,
          score_gap:      Math.round(scoreGap * 10000) / 10000,
        });
      } else {
        // Gap > 0.1 → dropped
        dropped.push({
          ...loser,
          resolution:     "dropped",
          resolution_note: `conflict_loser: score_gap=${scoreGap.toFixed(4)} > ${SCORE_TIE_THRESHOLD}`,
          needs_review:   false,
          winner_id:      winner.id,
          score_gap:      Math.round(scoreGap * 10000) / 10000,
        });
      }
    }
  }

  return { resolved, dropped, human_review: humanReview, resolution_log: logMessages };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Resolve the promotion queue.
 *
 * Reads from the promotion queue file, applies conflict resolution,
 * writes resolved-queue.jsonl and human-review-queue.jsonl.
 *
 * @param {string} queuePath - path to promotion-queue.jsonl
 * @returns {{resolved_count: number, dropped_count: number, review_count: number, resolved_path: string, review_path: string}}
 */
function resolveQueue(queuePath) {
  ensureDir(path.dirname(queuePath));

  if (!fs.existsSync(queuePath)) {
    err(`Queue file not found: ${queuePath}`);
    return { resolved_count: 0, dropped_count: 0, review_count: 0, resolved_path: "", review_path: "" };
  }

  const queueEntries = parseJsonl(queuePath);
  const recordMap    = new Map(loadStructuredRecords().map((r) => [r.id, r]));

  info(`Loaded ${queueEntries.length} queue entries from ${queuePath}`);
  info(`Loaded ${recordMap.size} structured records for tiebreaking`);

  const { resolved, dropped, human_review, resolution_log } = resolveConflicts(queueEntries, recordMap);

  // Sort resolved by score descending
  resolved.sort((a, b) => compareEntries(a, b, recordMap));

  info(`Resolution complete: resolved=${resolved.length}  dropped=${dropped.length}  human_review=${human_review.length}`);

  for (const msg of resolution_log) {
    log(`  ${msg}`);
  }

  const resolvedPath = queuePath.replace(/promotion-queue/, "resolved-queue");
  const reviewPath   = queuePath.replace(/promotion-queue/, "human-review-queue");

  if (DRY_RUN) {
    log(`[dry-run] Would write ${resolved.length} resolved entries to ${resolvedPath}`);
    log(`[dry-run] Would write ${human_review.length} human-review entries to ${reviewPath}`);
    log(`[dry-run] Would drop ${dropped.length} entries`);
    return {
      resolved_count: resolved.length,
      dropped_count: dropped.length,
      review_count: human_review.length,
      resolved_path: resolvedPath,
      review_path: reviewPath,
    };
  }

  ensureDir(path.dirname(resolvedPath));
  writeJsonl(resolvedPath, resolved);
  writeJsonl(reviewPath, human_review);

  info(`Resolved queue written: ${resolvedPath}`);
  info(`Human-review queue written: ${reviewPath}`);

  if (dropped.length > 0) {
    warn(`Dropped ${dropped.length} entries (score gap > ${SCORE_TIE_THRESHOLD} from winner): ${dropped.map((d) => d.id).join(", ")}`);
  }

  return {
    resolved_count: resolved.length,
    dropped_count: dropped.length,
    review_count: human_review.length,
    resolved_path: resolvedPath,
    review_path: reviewPath,
  };
}

/**
 * Return all queue entries flagged for human review.
 *
 * @param {{needs_review: boolean, score: number, id: string, tier_from: number, tier_to: number, conflicts: object[]}[]} records
 * @returns {{needs_review: boolean, score: number, id: string, tier_from: number, tier_to: number, conflicts: object[]}[]}
 */
function getHumanReviewQueue(records) {
  return records
    .filter((r) => r.needs_review === true)
    .sort((a, b) => b.score - a.score);
}

/**
 * Apply resolved promotions to the structured JSONL files.
 *
 * For each entry in resolvedQueue:
 *   1. Find the record in the appropriate structured JSONL file
 *   2. Update its tier field and lifecycle.promotion_count
 *   3. Rewrite the file with the updated record
 *
 * @param {{id: string, tier_from: number, tier_to: number, resolution: string}[]} resolvedQueue
 * @returns {{updated: number, errors: number, updated_files: string[]}}
 */
function applyResolvedPromotions(resolvedQueue) {
  const updatedFiles  = new Set();
  const recordMap     = new Map(loadStructuredRecords().map((r) => [r.id, r]));
  let updated         = 0;
  let errors          = 0;

  // Group updates by source file
  const filesToUpdate = new Map(); // filePath → [updatedRecords]

  for (const entry of resolvedQueue) {
    if (!recordMap.has(entry.id)) {
      err(`Record not found in structured files: ${entry.id}`);
      errors++;
      continue;
    }

    const original = recordMap.get(entry.id);
    const targetFile = findRecordSourceFile(original.id);
    if (!targetFile) {
      err(`Cannot determine source file for record: ${entry.id}`);
      errors++;
      continue;
    }

    if (!filesToUpdate.has(targetFile)) {
      filesToUpdate.set(targetFile, []);
    }
    filesToUpdate.get(targetFile).push({
      original,
      updated: {
        ...original,
        tier: entry.tier_to,
        lifecycle: {
          ...(original.lifecycle || {}),
          tier:                    entry.tier_to,
          promoted_at:             new Date().toISOString(),
          promotion_count:         (original.lifecycle?.promotion_count || 0) + 1,
          last_promotion_reason:   entry.resolution_note || entry.resolution || "resolved_queue",
        },
      },
    });
  }

  for (const [filePath, changes] of filesToUpdate) {
    if (DRY_RUN) {
      log(`[dry-run] Would update ${changes.length} records in ${filePath}`);
      updated += changes.length;
      updatedFiles.add(filePath);
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) { newLines.push(line); continue; }
      try {
        const rec = JSON.parse(line);
        const change = changes.find((c) => c.original.id === rec.id);
        if (change) {
          newLines.push(JSON.stringify(change.updated));
          updated++;
          updatedFiles.add(filePath);
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line); // preserve malformed
        err(`Failed to parse line in ${filePath}: ${line.slice(0, 80)}...`);
        errors++;
      }
    }

    fs.writeFileSync(filePath + ".tmp", newLines.join("\n") + "\n", "utf8");
    fs.renameSync(filePath + ".tmp", filePath);
    info(`Updated ${changes.length} records in ${filePath}`);
  }

  info(`Promotion application complete: updated=${updated}  errors=${errors}`);

  return {
    updated,
    errors,
    updated_files: Array.from(updatedFiles),
  };
}

// ── Source file lookup ─────────────────────────────────────────────────────────

function findRecordSourceFile(recordId) {
  if (!fs.existsSync(STRUCT_DIR)) return null;
  const files = fs.readdirSync(STRUCT_DIR)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("archive-"));

  for (const fname of files) {
    const fpath = path.join(STRUCT_DIR, fname);
    const lines = fs.readFileSync(fpath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.id === recordId) return fpath;
      } catch { /* skip */ }
    }
  }
  return null;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const queuePath = QUEUE_PATH || DEFAULT_QUEUE;

  info(`Starting promotion resolver (dry_run=${DRY_RUN})`);
  info(`Queue: ${queuePath}`);
  info(`Score tie threshold: ${SCORE_TIE_THRESHOLD}`);

  const result = resolveQueue(queuePath);

  // Also print human review queue summary
  if (fs.existsSync(result.review_path)) {
    const reviewEntries = parseJsonl(result.review_path);
    if (reviewEntries.length > 0) {
      warn(`\n=== HUMAN REVIEW REQUIRED (${reviewEntries.length} entries) ===`);
      for (const entry of reviewEntries) {
        console.log(
          `  id=${entry.id}  score=${entry.score.toFixed(4)}  ` +
          `gap=${entry.score_gap?.toFixed(4) ?? "n/a"}  ` +
          `winner=${entry.winner_id}  reason=${entry.resolution_note}`
        );
      }
    }
  }

  // Apply resolved promotions
  if (fs.existsSync(result.resolved_path) && !DRY_RUN) {
    const resolvedEntries = parseJsonl(result.resolved_path);
    const applyResult = applyResolvedPromotions(resolvedEntries);
    info(`Applied promotions: ${JSON.stringify(applyResult)}`);
  } else if (DRY_RUN && fs.existsSync(queuePath)) {
    const allEntries = parseJsonl(queuePath);
    info("[dry-run] Would apply resolved promotions next (skipping applyResolvedPromotions)");
    void applyResolvedPromotions.__dangerousDryRunPlaceholder; // suppress unused warning
  }

  info("Done.");
}

main();
