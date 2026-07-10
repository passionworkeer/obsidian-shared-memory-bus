// ops/memory/memory-contract/scoring.js
//
// Promotion scoring (recency/confidence/cross-session/source quality),
// token-based conflict detection, and schema-registry introspection helpers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_DURABLE_TYPES,
  ALLOWED_MEMORY_LEVELS,
  ALLOWED_SCOPES,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_TIERS,
  ALLOWED_VISIBILITY,
  MEMORY_INTEGRITY_CONTRACT_VERSION,
  MEMORY_RECORD_SCHEMA_VERSION,
  REQUIRED_RECORD_FIELDS,
} from "./schema.js";
import { normalizeString } from "./validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Scoring helpers (used by memory-promotion-scorer.js) ──────────────────────

/**
 * Token-based fingerprint for conflict/overlap detection.
 * Mirrors the tokenisation used in buildPromotionKey().
 * Returns a sorted array of lowercase tokens (length 3+, capped at 18).
 */
export function buildRecordFingerprint(record) {
  const text = normalizeString([
    record.title   || "",
    record.content || "",
    record.key     || "",
  ].filter(Boolean).join(" ")).toLowerCase();

  return text
    .split(/[\s\-_.,;:!?()[\]{}'"#@$%^&*+=|\\\\~`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 18);
}

/**
 * Compute Jaccard overlap between two token sets.
 * Returns 0.0 – 1.0.
 */
export function computeFingerprintOverlap(tokensA, tokensB) {
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

/**
 * Score a single promotion candidate.
 * Returns the weighted sum of recency, confidence, cross-session hits,
 * and source quality components.  This function lives in the contract
 * module so it can be unit-tested and used by validation tooling.
 *
 * @param {object} record - structured memory record
 * @param {object} [options]
 * @param {number} [options.recencyWeight=0.30]
 * @param {number} [options.confidenceWeight=0.35]
 * @param {number} [options.crossSessionWeight=0.25]
 * @param {number} [options.sourceQualityWeight=0.10]
 * @param {number} [options.halfLifeDays=30]
 * @returns {{score: number, components: object}}
 */
export function scorePromotionCandidate(record, options = {}) {
  const {
    recencyWeight       = 0.30,
    confidenceWeight    = 0.35,
    crossSessionWeight  = 0.25,
    sourceQualityWeight = 0.10,
    halfLifeDays        = 30,
  } = options;

  const nowMs       = Date.now();
  const lastAccessMs = record.lifecycle?.last_access_at
    ? new Date(record.lifecycle.last_access_at).getTime()
    : (record.t ? new Date(record.t).getTime() : nowMs);
  const ageDays     = Math.max(0, (nowMs - lastAccessMs)) / (24 * 60 * 60 * 1000);
  const recency     = Math.pow(2, -(ageDays / halfLifeDays));

  const promo       = record.metadata?.promotion;
  const confidence  = Math.max(0, Math.min(1,
    typeof promo?.source_confidence === "number"
      ? promo.source_confidence
      : (typeof record.confidence === "number" ? record.confidence : 0.5)
  ));

  const refs         = promo?.cross_session_refs || [];
  const accessCount  = record.lifecycle?.access_count || 0;
  const crossSession = Math.min(1.0, (Array.isArray(refs) ? refs.length : 0) + accessCount) / 5;

  const sourceQualityMap = {
    writeback: 1.0, session: 0.9, hook: 0.7, blackboard: 0.6,
    run: 0.5, cron: 0.5, task: 0.7, event: 0.5, heuristic: 0.4,
  };
  const sourceQuality = sourceQualityMap[
    (record.source_kind || record.sourceKind || record.source || "").toLowerCase()
  ] ?? 0.5;

  const score = (
    recency       * recencyWeight
    + confidence  * confidenceWeight
    + crossSession* crossSessionWeight
    + sourceQuality* sourceQualityWeight
  );

  return {
    score: Math.round(score * 10000) / 10000,
    components: {
      recency:         Math.round(recency        * 10000) / 10000,
      confidence:      Math.round(confidence     * 10000) / 10000,
      crossSessionHits: Math.round(crossSession * 10000) / 10000,
      sourceQuality:   Math.round(sourceQuality * 10000) / 10000,
    },
  };
}

/**
 * Detect conflicts among scored records using Jaccard token overlap.
 * Two records with overlap >= overlapThreshold (default 0.70) are flagged as conflicts.
 *
 * @param {{id: string}[]} records - records to check for conflicts
 * @param {object} [options]
 * @param {number} [options.overlapThreshold=0.70]
 * @returns {{id: string, conflicts: {otherId: string, overlap: number}[]}[]}
 */
export function detectConflicts(records, options = {}) {
  const { overlapThreshold = 0.70 } = options;

  // Build per-record fingerprints once.
  const fingerprints = new Map();
  for (const rec of records) {
    fingerprints.set(rec.id, buildRecordFingerprint(rec));
  }

  // Build inverted index: token → set of record ids containing that token.
  // A pair with Jaccard overlap ≥ threshold MUST share at least one token,
  // so this index lets us skip all non-candidates (O(n²) → O(n × avg_cand)).
  const invertedIndex = new Map();
  for (const [id, fp] of fingerprints) {
    for (const token of fp) {
      let bucket = invertedIndex.get(token);
      if (!bucket) {
        bucket = new Set();
        invertedIndex.set(token, bucket);
      }
      bucket.add(id);
    }
  }

  return records.map((rec) => {
    const myFp = fingerprints.get(rec.id) || [];
    if (myFp.length === 0) {
      return { id: rec.id, conflicts: [] };
    }

    // Collect candidate ids — every record that shares at least one
    // token with `rec`. Dedupe via Set; exclude self.
    const candidates = new Set();
    for (const token of myFp) {
      const bucket = invertedIndex.get(token);
      if (!bucket) continue;
      for (const id of bucket) {
        if (id !== rec.id) candidates.add(id);
      }
    }

    const conflicts = [];
    for (const otherId of candidates) {
      const otherFp = fingerprints.get(otherId) || [];
      const overlap = computeFingerprintOverlap(myFp, otherFp);
      if (overlap >= overlapThreshold) {
        conflicts.push({
          otherId,
          overlap: Math.round(overlap * 10000) / 10000,
        });
      }
    }

    return { id: rec.id, conflicts };
  });
}

// ── Schema export / drift detection ───────────────────────────────────────────

/**
 * Export current schema constants in the canonical registry JSON format.
 * This enables runtime schema introspection and CI-level drift detection.
 *
 * @returns {object} Schema manifest matching the structure of schema-registry.json
 */
export function exportSchemaAsJson() {
  return {
    schemas: {
      "memory-record-v2": {
        version: MEMORY_RECORD_SCHEMA_VERSION,
        description: "Standard memory record stored in structured/*.jsonl",
        required: Array.isArray(REQUIRED_RECORD_FIELDS) ? REQUIRED_RECORD_FIELDS : [],
        enums: {
          scope: { allowed: Array.from(ALLOWED_SCOPES) },
          visibility: { allowed: Array.from(ALLOWED_VISIBILITY) },
          sourceKind: { allowed: Array.from(ALLOWED_SOURCE_KINDS) },
          memory_level: { allowed: Array.from(ALLOWED_MEMORY_LEVELS) },
          tier: { allowed: Array.from(ALLOWED_TIERS) },
        },
      },
      "promotion-metadata-v1": {
        version: 1,
        description: "Promotion metadata for durable tier transitions",
        required: ["version", "key", "reason", "source_record_id"],
        enums: {
          durable_type: { allowed: Array.from(ALLOWED_DURABLE_TYPES) },
        },
      },
      "integrity-contract-v2": {
        version: MEMORY_INTEGRITY_CONTRACT_VERSION,
        description: "Integrity contract for generated artifacts",
      },
    },
    exportedAt: new Date().toISOString(),
    exportedFrom: "ops/memory/memory-contract.js",
  };
}

/**
 * Compare exported schema against schema-registry.json.
 * Returns {ok: boolean, issues: string[]}.
 * Exits with code 0 when in sync, code 1 when drift is detected.
 */
export function validateSchemaConsistency(registryPath) {
  const issues = [];

  // Load registry
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath || path.join(__dirname, "../../adapters/schema-registry.json"), "utf8"));
  } catch (err) {
    return { ok: false, issues: [`registry-unreadable: ${err.message}`] };
  }

  const exported = exportSchemaAsJson();

  // Check memory-record-v2 version
  const regRecordVersion = registry.schemas?.["memory-record-v2"]?.version;
  if (regRecordVersion !== exported.schemas["memory-record-v2"].version) {
    issues.push(`memory-record-v2 version mismatch: registry=${regRecordVersion}, current=${exported.schemas["memory-record-v2"].version}`);
  }

  // Check required fields
  const regRequired = registry.schemas?.["memory-record-v2"]?.required || [];
  const expRequired = exported.schemas["memory-record-v2"].required;
  if (JSON.stringify(regRequired.sort()) !== JSON.stringify(expRequired.sort())) {
    issues.push(`required fields drift: registry=${JSON.stringify(regRequired)}, current=${JSON.stringify(expRequired)}`);
  }

  // Check enums
  const regScopes = registry.schemas?.["memory-record-v2"]?.enums?.scope?.allowed || [];
  const expScopes = exported.schemas["memory-record-v2"].enums.scope.allowed;
  if (JSON.stringify(regScopes.sort()) !== JSON.stringify(expScopes.sort())) {
    issues.push(`scope enum drift: registry=${JSON.stringify(regScopes)}, current=${JSON.stringify(expScopes)}`);
  }

  // Check integrity contract version
  const regIntegrityVersion = registry.schemas?.["integrity-contract-v2"]?.version;
  if (regIntegrityVersion !== exported.schemas["integrity-contract-v2"].version) {
    issues.push(`integrity-contract-v2 version mismatch: registry=${regIntegrityVersion}, current=${exported.schemas["integrity-contract-v2"].version}`);
  }

  return { ok: issues.length === 0, issues };
}