/**
 * memory-promotion-scorer.js — Conflict-aware promotion scoring for Tier 2→3 and Tier 3→4.
 *
 * Score = weighted sum of:
 *   recency          (0.30) — based on last_access timestamp with exponential decay
 *   confidence       (0.35) — from source_confidence field (0–1)
 *   crossSessionHits (0.25) — from promotion metadata cross-session evidence
 *   sourceQuality    (0.10) — based on source_type: human=1.0, ai=0.7, heuristic=0.5
 *
 * Score range: 0.0 – 1.0
 * Auto-promote threshold: 0.65
 * Human-review range:     0.40 – 0.65  (marked needs_review: true)
 *
 * Usage:
 *   node ops/memory/memory-promotion-scorer.js [--store-root <path>] [--dry-run] [--verbose]
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

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

const STORE_ROOT = opt("--store-root", process.env.AI_MEMORY_STORE || null);
const DRY_RUN    = opt("--dry-run",    false);
const VERBOSE    = opt("--verbose",   false) || opt("-v", false);

if (!STORE_ROOT) {
  console.error("Error: --store-root or AI_MEMORY_STORE is required.");
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────────

const STRUCT_DIR      = path.join(STORE_ROOT, "structured");
const QUEUE_DIR       = path.join(STORE_ROOT, ".ai-memory/queue");
const PROMOTION_QUEUE = path.join(QUEUE_DIR,   "promotion-queue.jsonl");

// ── Scoring weights (can be overridden via env) ───────────────────────────────

const SCORING_WEIGHTS = {
  recency:          parseFloat(process.env.PROMOTION_WEIGHT_RECENCY          || "0.30"),
  confidence:       parseFloat(process.env.PROMOTION_WEIGHT_CONFIDENCE       || "0.35"),
  crossSessionHits: parseFloat(process.env.PROMOTION_WEIGHT_CROSS_SESSION     || "0.25"),
  sourceQuality:    parseFloat(process.env.PROMOTION_WEIGHT_SOURCE_QUALITY    || "0.10"),
};

const AUTO_PROMOTE_THRESHOLD   = parseFloat(process.env.PROMOTION_AUTO_THRESHOLD || "0.65");
const REVIEW_LOWER_BOUND       = 0.40;
const CONFLICT_OVERLAP_THRESHOLD = 0.70;

// ── Logging ───────────────────────────────────────────────────────────────────

const log = (...msg) => VERBOSE && console.log("[promotion-scorer]", new Date().toISOString(), ...msg);
const info = (...msg) => console.log("[promotion-scorer]", ...msg);
const warn = (...msg) => console.warn("[promotion-scorer] WARNING:", ...msg);
const err  = (...msg) => console.error("[promotion-scorer] ERROR:", ...msg);

// ── Helpers ────────────────────────────────────────────────────────────────────

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
}

function normalizeSpaces(str = "") {
  return String(str).replace(/\s+/g, " ").trim();
}

function tokenize(text = "") {
  return normalizeSpaces(text)
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}'"#@$%^&*+=|\\\/~`]+/)
    .filter(Boolean);
}

/**
 * Token-based fingerprint used for overlap/conflict detection.
 * Mirrors buildPromotionKey() from memory-layers-parse.js but returns
 * a sorted token array (not the SHA-1 hash) so we can compute overlap.
 */
function buildTokenFingerprint(record) {
  const text = normalizeSpaces([
    record.title   || "",
    record.content || "",
    record.key     || "",
  ].filter(Boolean).join(" ")).toLowerCase();

  return tokenize(text)
    .filter((t) => t.length >= 3)
    .slice(0, 18);
}

/**
 * Compute Jaccard overlap between two token sets.
 * Returns 0.0 – 1.0.
 */
function computeOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0.0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

// ── Scoring components ─────────────────────────────────────────────────────────

/**
 * Compute recency score (0–1) from last_access timestamp.
 * Exponential decay: score = 2^(-age_days / half_life_days)
 * half-life = 30 days → after 30 days score ≈ 0.5
 */
function scoreRecency(record) {
  const nowMs = Date.now();
  const lastAccessMs = record.lifecycle?.last_access_at
    ? new Date(record.lifecycle.last_access_at).getTime()
    : (record.t ? new Date(record.t).getTime() : nowMs);

  const ageMs   = Math.max(0, nowMs - lastAccessMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const HALF_LIFE_DAYS = 30;
  return Math.pow(2, -(ageDays / HALF_LIFE_DAYS));
}

/**
 * Compute confidence score from promotion metadata.
 * Falls back to record-level confidence if promotion metadata is absent.
 */
function scoreConfidence(record) {
  const promo = record.metadata?.promotion;
  if (promo && typeof promo.source_confidence === "number") {
    return Math.max(0, Math.min(1, promo.source_confidence));
  }
  if (typeof record.confidence === "number") {
    return Math.max(0, Math.min(1, record.confidence));
  }
  return 0.5; // default neutral
}

/**
 * Compute cross-session hit score.
 * More distinct session references = higher confidence of durability.
 * Capped at 5 sessions for scoring purposes.
 */
function scoreCrossSessionHits(record) {
  const promo = record.metadata?.promotion;
  if (!promo) return 0.0;

  // cross_session_refs is a list of distinct session IDs that referenced this record
  const refs = promo.cross_session_refs || [];
  const count = Array.isArray(refs) ? refs.length : 0;
  // Access count is also a strong signal
  const accessCount = record.lifecycle?.access_count || 0;
  const totalHits = count + accessCount;

  // Normalize: 0 hits = 0.0, 1 hit = 0.2, 2 = 0.4, 3 = 0.6, 5+ = 1.0
  return Math.min(1.0, totalHits / 5);
}

/**
 * Compute source quality score.
 * human > ai > heuristic
 */
function scoreSourceQuality(record) {
  const sourceType = (record.source_kind || record.sourceKind || record.source || "").toLowerCase();
  const sourceQualityMap = {
    writeback:   1.0,  // human-written writeback = highest quality
    session:     0.9,  // human session memory
    hook:        0.7,  // AI-assisted hook
    blackboard:  0.6,  // tool-generated
    run:         0.5,  // run/cron output
    cron:        0.5,  // scheduled job
    task:        0.7,  // task-related
    event:       0.5,  // event capture
    heuristic:   0.4,  // heuristic extraction
  };
  return sourceQualityMap[sourceType] ?? 0.5;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Score a single promotion candidate.
 * @param {object} record - structured memory record
 * @returns {{id: string, score: number, components: object, tier_from: number, tier_to: number}}
 */
function scorePromotionCandidate(record) {
  const recency       = scoreRecency(record);
  const confidence    = scoreConfidence(record);
  const crossSession  = scoreCrossSessionHits(record);
  const sourceQuality = scoreSourceQuality(record);

  const score = (
    recency       * SCORING_WEIGHTS.recency
    + confidence   * SCORING_WEIGHTS.confidence
    + crossSession * SCORING_WEIGHTS.crossSessionHits
    + sourceQuality* SCORING_WEIGHTS.sourceQuality
  );

  // Determine tier transition
  const tierFrom = record.lifecycle?.tier ?? record.tier ?? 2;
  let tierTo = tierFrom + 1;
  if (tierTo > 4) tierTo = 4; // cap at Tier 4

  return {
    id:        record.id || "unknown",
    score:     Math.round(score * 10000) / 10000,
    components: {
      recency:        Math.round(recency       * 10000) / 10000,
      confidence:     Math.round(confidence    * 10000) / 10000,
      crossSessionHits: Math.round(crossSession * 10000) / 10000,
      sourceQuality:  Math.round(sourceQuality* 10000) / 10000,
    },
    tier_from: tierFrom,
    tier_to:   tierTo,
    needs_review: score >= REVIEW_LOWER_BOUND && score < AUTO_PROMOTE_THRESHOLD,
  };
}

/**
 * Score all promotion candidate records.
 * @param {object[]} records
 * @returns {{id: string, score: number, components: object, tier_from: number, tier_to: number, needs_review: boolean, conflicts: object[]}[]}
 */
function scoreAllCandidates(records) {
  return records
    .filter((r) => {
      const tier = r.lifecycle?.tier ?? r.tier ?? 2;
      return tier >= 2 && tier < 4; // only Tier 2 and Tier 3
    })
    .map((record) => {
      const scored = scorePromotionCandidate(record);
      scored.record_summary = {
        id:      record.id,
        title:   normalizeSpaces(record.title || "").slice(0, 120),
        scope:   record.scope,
        type:    record.type,
        source:  record.source || record.source_kind || "",
      };
      scored.scored_at = new Date().toISOString();
      return scored;
    })
    .sort((a, b) => b.score - a.score); // highest score first
}

/**
 * Detect conflicts among scored candidates using token fingerprint overlap.
 * Two records with Jaccard overlap > CONFLICT_OVERLAP_THRESHOLD (0.70) = conflict.
 *
 * @param {{id: string, record_summary: object}[]} scoredCandidates
 * @param {object[]} originalRecords - full record objects for fingerprinting
 * @returns {{id: string, score: number, conflicts: {otherId: string, overlap_score: number}[], needs_review: boolean}[]}
 */
function detectConflicts(scoredCandidates, originalRecords) {
  const recordMap = new Map((originalRecords || []).map((r) => [r.id, r]));

  // Compute fingerprints for all candidates
  const fingerprints = new Map();
  for (const candidate of scoredCandidates) {
    const rec = recordMap.get(candidate.id);
    if (!rec) continue;
    fingerprints.set(candidate.id, buildTokenFingerprint(rec));
  }

  return scoredCandidates.map((candidate) => {
    const myFingerprint = fingerprints.get(candidate.id) || [];
    const conflicts = [];

    for (const other of scoredCandidates) {
      if (other.id === candidate.id) continue;

      const otherFingerprint = fingerprints.get(other.id) || [];
      const overlap = computeOverlap(myFingerprint, otherFingerprint);

      if (overlap >= CONFLICT_OVERLAP_THRESHOLD) {
        conflicts.push({
          otherId:       other.id,
          overlap_score: Math.round(overlap * 10000) / 10000,
        });
        log(`Conflict detected: ${candidate.id} <-> ${other.id} (overlap=${Math.round(overlap*100)}%)`);
      }
    }

    return {
      ...candidate,
      conflicts,
    };
  });
}

/**
 * Build the promotion queue under the resolved AI_MEMORY_STORE root.
 *
 * @param {{id: string, score: number, components: object, tier_from: number, tier_to: number, needs_review: boolean, conflicts: object[], record_summary: object, scored_at: string}[]} scoredCandidates
 * @returns {{written: number, auto_promote: number, needs_review: number, conflicts: number, path: string}}
 */
function buildPromotionQueue(scoredCandidates) {
  if (!fs.existsSync(QUEUE_DIR)) {
    if (DRY_RUN) {
      log(`[dry-run] Would create directory: ${QUEUE_DIR}`);
    } else {
      fs.mkdirSync(QUEUE_DIR, { recursive: true });
    }
  }

  let written       = 0;
  let autoPromote   = 0;
  let needsReview   = 0;
  let conflictCount = 0;

  const lines = scoredCandidates.map((entry) => {
    if (entry.score >= AUTO_PROMOTE_THRESHOLD) autoPromote++;
    if (entry.needs_review)                   needsReview++;
    if (entry.conflicts?.length > 0)          conflictCount++;
    written++;
    return JSON.stringify(entry);
  });

  if (DRY_RUN) {
    log(`[dry-run] Would write ${written} candidates to ${PROMOTION_QUEUE}`);
    log(`  auto_promote=${autoPromote}  needs_review=${needsReview}  conflicts=${conflictCount}`);
    return { written, auto_promote: autoPromote, needs_review: needsReview, conflicts: conflictCount, path: PROMOTION_QUEUE };
  }

  fs.writeFileSync(PROMOTION_QUEUE, lines.join("\n") + "\n", "utf8");
  info(`Promotion queue written: ${PROMOTION_QUEUE} (${written} entries, auto=${autoPromote}, review=${needsReview}, conflicts=${conflictCount})`);

  return { written, auto_promote: autoPromote, needs_review: needsReview, conflicts: conflictCount, path: PROMOTION_QUEUE };
}

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

function loadStructuredRecords() {
  if (!fs.existsSync(STRUCT_DIR)) return [];
  return fs.readdirSync(STRUCT_DIR)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("archive-"))
    .flatMap((f) => parseJsonl(path.join(STRUCT_DIR, f)));
}

// ── CLI dry-run ───────────────────────────────────────────────────────────────

function main() {
  info(`Starting promotion scorer (dry_run=${DRY_RUN}, store=${STORE_ROOT})`);
  info(`Weights: recency=${SCORING_WEIGHTS.recency} confidence=${SCORING_WEIGHTS.confidence} crossSession=${SCORING_WEIGHTS.crossSessionHits} sourceQuality=${SCORING_WEIGHTS.sourceQuality}`);
  info(`Thresholds: auto_promote>=${AUTO_PROMOTE_THRESHOLD}  review=${REVIEW_LOWER_BOUND}-${AUTO_PROMOTE_THRESHOLD}  conflict_overlap>=${CONFLICT_OVERLAP_THRESHOLD}`);

  const records = loadStructuredRecords();
  log(`Loaded ${records.length} structured records from ${STRUCT_DIR}`);

  if (records.length === 0) {
    info("No records found — nothing to score.");
    return;
  }

  const scored    = scoreAllCandidates(records);
  const withConflicts = detectConflicts(scored, records);

  info(`Scored ${withConflicts.length} promotion candidates`);

  const distribution = { high: 0, auto: 0, review: 0, low: 0 };
  for (const c of withConflicts) {
    if (c.score >= AUTO_PROMOTE_THRESHOLD) distribution.high++;
    else if (c.score >= REVIEW_LOWER_BOUND) distribution.auto++;
    else if (c.score >= 0.20)              distribution.review++;
    else                                   distribution.low++;
  }
  info(`Score distribution: high(>=${AUTO_PROMOTE_THRESHOLD})=${distribution.high}  auto(${REVIEW_LOWER_BOUND}-${AUTO_PROMOTE_THRESHOLD})=${distribution.auto}  review(0.2-${REVIEW_LOWER_BOUND})=${distribution.review}  low(<0.2)=${distribution.low}`);

  const result = buildPromotionQueue(withConflicts);

  if (DRY_RUN) {
    console.log("\n=== TOP 10 CANDIDATES (dry-run) ===");
    for (const c of withConflicts.slice(0, 10)) {
      const conflictNote = c.conflicts.length > 0
        ? ` [CONFLICTS: ${c.conflicts.map((x) => x.otherId).join(", ")}]`
        : "";
      console.log(
        `  [${c.tier_from}→${c.tier_to}] score=${c.score.toFixed(4)}  id=${c.id}  ` +
        `needs_review=${c.needs_review}${conflictNote}`
      );
    }
  }

  info(`Done. Queue written to: ${result.path}`);
}

main();
