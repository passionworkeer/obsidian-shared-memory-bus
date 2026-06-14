/**
 * memory-archival.js — Idempotent memory archival and tier budget enforcement.
 *
 * DESIGN PRINCIPLES (ADR-002 v2):
 *   1. Idempotent lock prevents concurrent runs from conflicting.
 *   2. --trigger watchdog|dream distinguishes callers for lock ownership.
 *   3. archive-manifest.jsonl (NOT tombstone) provides audit trail without
 *      polluting the embedding index (Q3 fix).
 *   4. --dry-run never acquires a lock and is always safe to re-run.
 *
 * Usage:
 *   node ops/memory-archival.js [--store-root <path>] [--dry-run] [--verbose]
 *        [--trigger watchdog|dream|manual]
 *
 * Triggers:
 *   watchdog  — memory-watchdog.ps1 calls this when hygiene report says archival_needed=true
 *   dream     — run-memory-dream.ps1 calls before typed durable promotion
 *   manual    — human operator invoked directly
 *   (default) — detect caller from lock file trigger field
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { safeRealpathWithin } from "../util/safe-realpath.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] || true : def;
};

const STORE_ROOT = opt("--store-root", process.env.AI_MEMORY_STORE || null);
const DRY_RUN = opt("--dry-run", false);
const VERBOSE = opt("--verbose", false) || opt("-v", false);
const TRIGGER = opt("--trigger", null); // watchdog | dream | manual | null

if (!STORE_ROOT) {
  console.error("Error: --store-root or AI_MEMORY_STORE is required.");
  process.exit(1);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const LOCK_DIR        = path.join(STORE_ROOT, ".lock");
const LOCK_FILE       = path.join(LOCK_DIR, "archival.lock");
const MANIFEST_FILE   = path.join(STORE_ROOT, "structured", "archive-manifest.jsonl");
const STRUCT_DIR      = path.join(STORE_ROOT, "structured");
const TIER_BUDGET_FILE = path.join(STORE_ROOT, ".config", "tier-budget.json");

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Tier budget limits ─────────────────────────────────────────────────────────

const TIER_BUDGETS = {
  1: { max: 200,  label: "Event/Working"     },
  2: { max: 200,  label: "Session Durable"   },
  3: { max: 100,  label: "Project Durable", perProject: true },
  4: { max: 200,  label: "Shared Durable",   perType: true     },
  5: { max: 500,  label: "Archive",          reviewAbove: true  },
};

// ── Logging ───────────────────────────────────────────────────────────────────

const log = (...msg) => VERBOSE && console.log("[archival]", new Date().toISOString(), ...msg);
const info = (...msg) => console.log("[archival]", new Date().toISOString(), ...msg);
const warn = (...msg) => console.warn("[archival] WARNING:", ...msg);
const err  = (...msg) => console.error("[archival] ERROR:", ...msg);

// ── Utilities ──────────────────────────────────────────────────────────────────

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function nowMs() { return Date.now(); }

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return records;
}

// ── Atomic JSONL append ────────────────────────────────────────────────────────

// Lazy-load to avoid a hard import cycle during module parsing.
async function getAppendLineAtomic() {
  const mod = await import("../inbox/inbox-atomic-write.js");
  return mod.appendLineAtomic;
}

/**
 * Atomically append a JSON object as one line to a JSONL file.
 * Replaces the previous fs.appendFileSync() call which could drop lines
 * under concurrent load (Windows FILE_APPEND_DATA race).
 *
 * @param {string} filePath
 * @param {object} obj
 */
async function appendJsonl(filePath, obj) {
  const appendLineAtomic = await getAppendLineAtomic();
  appendLineAtomic(filePath, obj, { createDir: true });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Lock management ───────────────────────────────────────────────────────────

/**
 * Acquire idempotent lock.
 * Returns { ok: true } if lock acquired (or already owned).
 * Returns { ok: false, reason, pid } if another process holds it.
 */
function acquireLock() {
  ensureDir(LOCK_DIR);

  if (!fs.existsSync(LOCK_FILE)) {
    // No lock — write ours
    return writeLock("manual");
  }

  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    const age  = nowMs() - (lock.start_time || 0);

    if (age < LOCK_TTL_MS) {
      // Another run is active — but only abort if it's a DIFFERENT trigger
      if (lock.trigger && lock.trigger !== "manual" && TRIGGER && lock.trigger !== TRIGGER) {
        return { ok: false, reason: "lock-held-by-other", pid: lock.pid, trigger: lock.trigger, age_ms: age };
      }
      return { ok: false, reason: "lock-held", pid: lock.pid, trigger: lock.trigger, age_ms: age };
    }

    // Lock expired (> 30 min) — take over
    log(`Lock expired (age=${Math.round(age/60000)}min), taking over.`);
    return writeLock(TRIGGER || "manual");
  } catch {
    return writeLock(TRIGGER || "manual");
  }
}

function writeLock(trigger) {
  if (DRY_RUN) {
    log("[dry-run] Would write lock:", { trigger, dry_run: true });
    return { ok: true, dry_run: true };
  }
  const lock = {
    pid: process.pid,
    start_time: nowMs(),
    trigger: trigger || "manual",
    version: 1,
  };
  const payload = JSON.stringify(lock, null, 2);
  try {
    // Atomic create — fails with EEXIST if another process beat us to it
    // (closes the TOCTOU window between `existsSync` and `writeFileSync`).
    fs.writeFileSync(LOCK_FILE, payload, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale-lock takeover path: caller already verified age > LOCK_TTL_MS.
    // Write to .tmp + rename to overwrite atomically.
    const tmp = `${LOCK_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, LOCK_FILE);
  }
  info(`Lock acquired: pid=${lock.pid} trigger=${lock.trigger}`);
  return { ok: true };
}

function releaseLock() {
  if (DRY_RUN) return;
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (lock.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        log("Lock released.");
      }
    } catch { /* best-effort */ }
  }
}

// ── Manifest helpers ───────────────────────────────────────────────────────────

async function writeManifestEntry(record, reason, trigger) {
  const entry = {
    id: record.id,
    tier_from: record.tier || record.lifecycle?.tier || 4,
    archived_at: new Date().toISOString(),
    reason,
    trigger: trigger || TRIGGER || "manual",
    archived_by: "memory-archival.js",
    original_scope: record.scope,
    original_type: record.type,
    content_hash: record.content_hash || sha256(JSON.stringify(record.content || "")),
    line_in_source: findRecordLine(record),
  };
  await appendJsonl(MANIFEST_FILE, entry);
  return entry;
}

function findRecordLine(record) {
  // Scans structured JSONL files for this record's ID, returns "filename:line"
  if (!record.id) return "unknown";
  const structuredFiles = [
    "shared-inbox.jsonl",
    "session-memory.jsonl",
    "shared-events.jsonl",
    "task-memory.jsonl",
    "claude-code.jsonl",
    "openclaw.jsonl",
    "openclaw-blackboard.jsonl",
    "openclaw-runs.jsonl",
    "openclaw-jobs.jsonl",
    "openclaw-journal.jsonl",
  ];
  for (const fname of structuredFiles) {
    const fpath = path.join(STRUCT_DIR, fname);
    if (!fs.existsSync(fpath)) continue;
    const lines = fs.readFileSync(fpath, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r.id === record.id) return `${fname}:${i + 1}`;
      } catch { /* skip */ }
    }
  }
  return "unknown";
}

// ── JSONL update (append-only + filter rewrite) ────────────────────────────────

/**
 * Remove records from a JSONL file whose ids are in `toArchive`.
 * Writes to a temp file, then replaces the original (atomic-ish on Windows).
 */
async function archiveRecordsFromFile(filePath, toArchiveIds) {
  if (!fs.existsSync(filePath)) return { processed: 0, archived: 0 };

  const set = new Set(toArchiveIds);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const kept = [];
  let archived = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (set.has(r.id)) {
        archived++;
        await writeManifestEntry(r, "budget_pressure", TRIGGER);
        set.delete(r.id); // don't double-archive
      } else {
        kept.push(line);
      }
    } catch {
      kept.push(line); // preserve malformed lines
    }
  }

  if (archived > 0) {
    if (DRY_RUN) {
      info(`[dry-run] Would archive ${archived} records from ${path.basename(filePath)}`);
    } else {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath + ".tmp", kept.join("\n") + "\n", "utf8");
      fs.renameSync(filePath + ".tmp", filePath);
      info(`Archived ${archived} records from ${path.basename(filePath)}`);
    }
  }

  return { processed: lines.filter(l => l.trim()).length, archived };
}

// ── Archive scan ───────────────────────────────────────────────────────────────

/**
 * Scan all structured JSONL files for records eligible for Archive.
 * Returns map of filename → record ids to archive.
 */
function scanForArchiveEligible() {
  const now = nowMs();
  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
  const toArchive = new Map(); // filename → [recordId, ...]

  const structuredFiles = fs.readdirSync(STRUCT_DIR)
    .filter(f => f.endsWith(".jsonl") && !f.startsWith("archive-"))
    .map(f => path.join(STRUCT_DIR, f))
    .filter(fpath => {
      // SECURITY: skip files whose realpath escapes STRUCT_DIR (e.g. symlink
      // planted in vault by another app on a synced filesystem). Same guard
      // as ops/memory/entry-parsers.js parseLayerEntries.
      if (!safeRealpathWithin(fpath, STRUCT_DIR)) {
        process.stderr.write(`[archival-scan] skipping path that escapes STRUCT_DIR: ${fpath}\n`);
        return false;
      }
      return true;
    });

  for (const fpath of structuredFiles) {
    const fname = path.basename(fpath);
    const records = parseJsonl(fpath);

    const idsToArchive = [];
    for (const rec of records) {
      const lifecycle = rec.lifecycle || {};

      // Skip already archived
      if (lifecycle.archived === true) continue;

      // Skip Tier 5 (already archived)
      if (lifecycle.tier === 5) continue;

      // Tier 1: age > 1d and no session-end signal → archive
      if (lifecycle.tier === 1 || lifecycle.tier === undefined) {
        const createdMs = new Date(rec.t || 0).getTime();
        const ageMs = now - createdMs;
        if (ageMs > 1 * 24 * 60 * 60 * 1000) {
          idsToArchive.push(rec.id);
          log(`Tier-1 expired: ${rec.id} (age=${Math.round(ageMs/86400000)}d)`);
        }
        continue;
      }

      // Tier 2: age > 30d without confidence → archive
      if (lifecycle.tier === 2) {
        const createdMs = new Date(rec.t || 0).getTime();
        const ageMs = now - createdMs;
        if (ageMs > 30 * 24 * 60 * 60 * 1000 && (lifecycle.promotion_count || 0) < 2) {
          idsToArchive.push(rec.id);
          log(`Tier-2 cold: ${rec.id} (age=${Math.round(ageMs/86400000)}d)`);
        }
        continue;
      }

      // Tier 3: project ended + age > 30d → archive
      if (lifecycle.tier === 3) {
        const expiresMs = new Date(lifecycle.expires_at || 0).getTime();
        if (expiresMs > 0 && now > expiresMs) {
          idsToArchive.push(rec.id);
          log(`Tier-3 expired: ${rec.id} (expires_at=${lifecycle.expires_at})`);
        }
        continue;
      }

      // Tier 4: TTL by scope OR 60d no access
      if (lifecycle.tier === 4) {
        const ttlByScope = { user: null, feedback: 90, reference: 180 };
        const ttlDays = ttlByScope[rec.scope] ?? 90;
        const expiresMs = new Date(lifecycle.expires_at || 0).getTime();
        const accessAgeMs = now - (lifecycle.last_access_at ? new Date(lifecycle.last_access_at).getTime() : 0);
        const createdMs = new Date(rec.t || 0).getTime();
        const ageMs = now - createdMs;

        const ttlExpired = ttlDays !== null && expiresMs > 0 && now > expiresMs;
        const coldAccess = accessAgeMs > sixtyDaysMs && (lifecycle.access_count || 0) === 0 && ageMs > sixtyDaysMs;

        if (ttlExpired || coldAccess) {
          idsToArchive.push(rec.id);
          log(`Tier-4 ${ttlExpired ? "TTL-expired" : "cold-access"}: ${rec.id}`);
        }
      }
    }

    if (idsToArchive.length > 0) toArchive.set(fname, idsToArchive);
  }

  return toArchive;
}

// ── Tier budget enforcement ────────────────────────────────────────────────────

/**
 * Check per-tier record counts and collect over-budget IDs for archival.
 * Returns { overBudget: Map<file→[id,…]>, report: Object }
 */
function checkTierBudgets() {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byProject = {}; // tier 3
  const byType   = {}; // tier 4
  const records  = {}; // id → record for eviction decisions

  const structuredFiles = fs.readdirSync(STRUCT_DIR)
    .filter(f => f.endsWith(".jsonl") && !f.startsWith("archive-"))
    .map(f => path.join(STRUCT_DIR, f))
    .filter(fpath => {
      // SECURITY: skip files whose realpath escapes STRUCT_DIR (e.g. symlink
      // planted in vault by another app on a synced filesystem). Same guard
      // as ops/memory/entry-parsers.js parseLayerEntries.
      if (!safeRealpathWithin(fpath, STRUCT_DIR)) {
        process.stderr.write(`[archival-scan] skipping path that escapes STRUCT_DIR: ${fpath}\n`);
        return false;
      }
      return true;
    });

  for (const fpath of structuredFiles) {
    for (const rec of parseJsonl(fpath)) {
      const t = rec.lifecycle?.tier ?? 1;
      if (!counts[t]) counts[t] = 0;
      counts[t]++;
      records[rec.id] = rec;

      if (t === 3) {
        const proj = rec.project || rec.scope_data?.project || "default";
        byProject[proj] = (byProject[proj] || 0) + 1;
      }
      if (t === 4) {
        const type = rec.type || "unknown";
        byType[type] = (byType[type] || 0) + 1;
      }
    }
  }

  const overBudget = new Map();
  const report = { counts, byProject, byType, overBudgetFiles: [] };

  for (const [tier, cfg] of Object.entries(TIER_BUDGETS)) {
    const n = counts[tier] || 0;
    if (n <= cfg.max) continue;

    if (cfg.perProject) {
      // Check per-project budgets
      for (const [proj, cnt] of Object.entries(byProject)) {
        if (cnt > cfg.max) {
          // Collect oldest records for this project
          const projRecords = Object.values(records)
            .filter(r => (r.project || r.scope_data?.project || "default") === proj && (r.lifecycle?.tier === 3))
            .sort((a, b) => (a.lifecycle?.freshness_score || 0) - (b.lifecycle?.freshness_score || 0));
          const excess = projRecords.slice(0, cnt - cfg.max);
          if (excess.length) overBudget.set(proj, excess.map(r => r.id));
          warn(`Tier-3 project "${proj}" over budget: ${cnt} > ${cfg.max}, evicting ${excess.length}`);
        }
      }
    } else if (cfg.perType) {
      for (const [type, cnt] of Object.entries(byType)) {
        if (cnt > cfg.max) {
          const typeRecords = Object.values(records)
            .filter(r => (r.type || "unknown") === type && (r.lifecycle?.tier === 4))
            .sort((a, b) => (a.lifecycle?.freshness_score || 0) - (b.lifecycle?.freshness_score || 0));
          const excess = typeRecords.slice(0, cnt - cfg.max);
          if (excess.length) overBudget.set(type, excess.map(r => r.id));
          warn(`Tier-4 type "${type}" over budget: ${cnt} > ${cfg.max}, evicting ${excess.length}`);
        }
      }
    } else {
      const excess = n - cfg.max;
      if (excess > 0) {
        // Collect oldest by freshness_score across all tier records
        const tierRecords = Object.values(records)
          .filter(r => r.lifecycle?.tier === parseInt(tier))
          .sort((a, b) => (a.lifecycle?.freshness_score || 0) - (b.lifecycle?.freshness_score || 0));
        const toEvict = tierRecords.slice(0, excess).map(r => r.id);
        if (toEvict.length) overBudget.set(`tier_${tier}_global`, toEvict);
        info(`Tier-${tier} over budget: ${n} > ${cfg.max}, evicting ${toEvict.length} oldest records.`);
      }
    }
  }

  if (TIER_BUDGETS[5].reviewAbove && (counts[5] || 0) > TIER_BUDGETS[5].max) {
    warn(`Archive tier (Tier-5) has ${counts[5]} records — exceeds review threshold of ${TIER_BUDGETS[5].max}. Manual review recommended.`);
    report.archiveReviewNeeded = true;
  }

  return { overBudget, report };
}

// ── Memory simplification ───────────────────────────────────────────────────────

/**
 * Simplify cold Tier-4 records with high access_count (>20) and long content (>2000 chars).
 * Keeps original in archive, writes compressed version to source file.
 * Only applies to records with confidence already confirmed (access_count>20).
 */
function simplifyMemory(filePath) {
  const SIMPLIFY_ACCESS_THRESHOLD = 20;
  const SIMPLIFY_LENGTH_THRESHOLD  = 2000;
  const SIMPLIFY_TARGET            = 500;  // chars max for simplified version

  const records = parseJsonl(filePath);
  const kept    = [];
  let simplified = 0;

  for (const rec of records) {
    if (rec.lifecycle?.tier !== 4) { kept.push(rec); continue; }

    const content = rec.content || "";
    const accessCount = rec.lifecycle?.access_count || 0;
    const contentLen = content.length;

    if (accessCount > SIMPLIFY_ACCESS_THRESHOLD && contentLen > SIMPLIFY_LENGTH_THRESHOLD) {
      // Simplify: keep frontmatter + first paragraph + summary hint
      const firstPara = content.split(/\n\n/)[0] || content.slice(0, SIMPLIFY_TARGET);
      const summaryHint = `\n\n<!-- SIMPLIFIED: original ${contentLen} chars, access_count=${accessCount} -->`;

      const simplifiedRec = {
        ...rec,
        content: firstPara.slice(0, SIMPLIFY_TARGET) + summaryHint,
        lifecycle: {
          ...rec.lifecycle,
          simplified: true,
          simplified_at: new Date().toISOString(),
          original_content_hash: rec.content_hash || sha256(content),
        },
      };
      kept.push(simplifiedRec);
      simplified++;
      log(`Simplified: ${rec.id} (${contentLen} → ~${SIMPLIFY_TARGET + summaryHint.length} chars)`);
    } else {
      kept.push(rec);
    }
  }

  if (simplified > 0) {
    if (DRY_RUN) {
      info(`[dry-run] Would simplify ${simplified} records in ${path.basename(filePath)}`);
    } else {
      fs.writeFileSync(filePath + ".tmp", kept.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.renameSync(filePath + ".tmp", filePath);
      info(`Simplified ${simplified} records in ${path.basename(filePath)}`);
    }
  }

  return simplified;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  info(`Starting memory-archival.js (trigger=${TRIGGER || "auto"}, dry_run=${DRY_RUN})`);
  info(`Store root: ${STORE_ROOT}`);

  if (!fs.existsSync(STRUCT_DIR)) {
    info("Structured directory not found — nothing to archive. Exiting.");
    return;
  }

  // Step 1: Acquire idempotent lock
  const lockResult = acquireLock();
  if (!lockResult.ok) {
    if (lockResult.dry_run) {
      info("[dry-run] Would wait for lock — skipping.");
    } else {
      info(`Lock held by pid=${lockResult.pid} (trigger=${lockResult.trigger}, age=${Math.round((lockResult.age_ms||0)/60000)}min) — aborting to prevent conflict.`);
      info("Run with --trigger watchdog|dream to override check, or wait 30 min for lock expiry.");
      return;
    }
  }

  let exitCode = 0;
  try {
    ensureDir(LOCK_DIR);
    ensureDir(STRUCT_DIR);
    if (!fs.existsSync(MANIFEST_FILE)) {
      if (!DRY_RUN) fs.writeFileSync(MANIFEST_FILE, "", "utf8");
      info(`Created: ${path.relative(STORE_ROOT, MANIFEST_FILE)}`);
    }

    // Step 2: TTL / cold-access archive scan
    info("--- Phase 1: TTL & cold-access scan ---");
    const toArchive = scanForArchiveEligible();
    for (const [fname, ids] of toArchive.entries()) {
      const fpath = path.join(STRUCT_DIR, fname);
      const { archived } = await archiveRecordsFromFile(fpath, ids);
      if (archived > 0 && !DRY_RUN) {
        for (const id of ids) await writeManifestEntry({ id, tier: 4 }, "ttl_expired", TRIGGER);
      }
    }
    if (toArchive.size === 0) log("No TTL/cold-access archival candidates found.");

    // Step 3: Tier budget enforcement
    info("--- Phase 2: Tier budget enforcement ---");
    const { overBudget, report } = checkTierBudgets();
    for (const [key, ids] of overBudget.entries()) {
      // Try to find which file(s) contain these IDs
      const structuredFiles = fs.readdirSync(STRUCT_DIR)
        .filter(f => f.endsWith(".jsonl") && !f.startsWith("archive-"))
        .map(f => path.join(STRUCT_DIR, f));
      for (const fpath of structuredFiles) {
        await archiveRecordsFromFile(fpath, ids);
      }
    }
    if (overBudget.size === 0) log("All tiers within budget limits.");

    // Step 4: Memory simplification (Tier-4, high-access, long-content)
    info("--- Phase 3: Memory simplification ---");
    const structuredFiles = fs.readdirSync(STRUCT_DIR)
      .filter(f => f.endsWith(".jsonl") && !f.startsWith("archive-"))
      .map(f => path.join(STRUCT_DIR, f));
    let totalSimplified = 0;
    for (const fpath of structuredFiles) {
      totalSimplified += simplifyMemory(fpath);
    }
    if (totalSimplified === 0) log("No records eligible for simplification.");

    // Summary
    info("--- Summary ---");
    info(`Records per tier: ${JSON.stringify(report.counts)}`);
    if (report.archiveReviewNeeded) {
      warn("Archive tier (Tier-5) exceeds review threshold. See: templates/.memory/config/tier-budget.json");
    }
    info("Archival run complete.");

  } catch (e) {
    err("Unhandled exception:", e.message);
    exitCode = 1;
  } finally {
    releaseLock();
    process.exit(exitCode);
  }
}

main();
