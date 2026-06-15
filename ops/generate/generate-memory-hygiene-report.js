"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MS_PER_DAY, MS_PER_WEEK } from "../../bus/time-constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fallbackStoreRootHelper() {
  return {
    resolveStoreRoot() {
      return (
        process.env.AI_MEMORY_STORE ||
        process.env.AI_MEMORY_STORE_ROOT ||
        process.env.AI_MEMORY_ROOT ||
        path.join(os.homedir(), ".ai-memory")
      );
    },
  };
}

function loadStoreRootHelper() {
  const candidates = [
    path.join(__dirname, "store-root.js"),
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    path.join(__dirname, "..", "bus", "store-root.js"),
    path.join(__dirname, "bus", "store-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }

  return fallbackStoreRootHelper();
}

const storeRootModule = await loadStoreRootHelper();
const { resolveStoreRoot } = storeRootModule.default || storeRootModule;

// Reuse the structured layer definitions from memory-contract so we stay in sync
let STRUCTURED_LAYER_DEFINITIONS;
let isExpectedDerivedDuplicate;
try {
  const memoryContractModule = await import("../memory/memory-contract.js");
  STRUCTURED_LAYER_DEFINITIONS = memoryContractModule.STRUCTURED_LAYER_DEFINITIONS;
  isExpectedDerivedDuplicate = memoryContractModule.isExpectedDerivedDuplicate;
} catch {
  // Inline fallback — used only when memory-contract.js is unavailable
  STRUCTURED_LAYER_DEFINITIONS = [
    { key: "sharedInbox",        fileName: "shared-inbox.jsonl" },
    { key: "sessionMemory",      fileName: "session-memory.jsonl" },
    { key: "sharedEvents",       fileName: "shared-events.jsonl" },
    { key: "taskMemory",         fileName: "task-memory.jsonl" },
    { key: "claudeCodeImported", fileName: "claude-code.jsonl" },
    { key: "openclawSessions",   fileName: "openclaw.jsonl" },
    { key: "openclawBlackboard", fileName: "openclaw-blackboard.jsonl" },
    { key: "openclawRuns",       fileName: "openclaw-runs.jsonl" },
    { key: "openclawJobs",      fileName: "openclaw-jobs.jsonl" },
    { key: "openclawJournal",   fileName: "openclaw-journal.jsonl" },
  ];
  isExpectedDerivedDuplicate = function fallbackExpectedDerivedDuplicate(firstFileName, secondFileName) {
    const pair = new Set([String(firstFileName || "").trim(), String(secondFileName || "").trim()]);
    if (pair.has("session-memory.jsonl")) {
      return pair.has("claude-code.jsonl") || pair.has("openclaw.jsonl");
    }
    if (!pair.has("task-memory.jsonl")) {
      return false;
    }
    return (
      pair.has("openclaw-blackboard.jsonl") ||
      pair.has("openclaw-runs.jsonl") ||
      pair.has("openclaw-jobs.jsonl") ||
      pair.has("openclaw-journal.jsonl")
    );
  };
}

if (typeof isExpectedDerivedDuplicate !== "function") {
  isExpectedDerivedDuplicate = function fallbackExpectedDerivedDuplicate(firstFileName, secondFileName) {
    const pair = new Set([String(firstFileName || "").trim(), String(secondFileName || "").trim()]);
    if (pair.has("session-memory.jsonl")) {
      return pair.has("claude-code.jsonl") || pair.has("openclaw.jsonl");
    }
    if (!pair.has("task-memory.jsonl")) {
      return false;
    }
    return (
      pair.has("openclaw-blackboard.jsonl") ||
      pair.has("openclaw-runs.jsonl") ||
      pair.has("openclaw-jobs.jsonl") ||
      pair.has("openclaw-journal.jsonl")
    );
  };
}

const ALLOWED_SCOPES = new Set(["user", "feedback", "project", "reference", "summary", "task", "run"]);

const REPORT_VERSION = 1;
const HYGIENE_REPORT_FILE = "memory_hygiene_report.json";
const TIME_SENSITIVE_KEYWORDS = [
  "deadline", "freeze", "release", "deploy", "launch",
  "milestone", "sprint", "roadmap", "v1", "v2", "v3",
];

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const parsed = Date.parse(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function getFreshnessFromRecord(record) {
  const freshness = record.freshness || "";
  if (freshness === "hot" || freshness === "warm" || freshness === "cold") {
    return freshness;
  }
  const t = record.t || record.created_at || "";
  const ageMs = Date.now() - parseTimestampMs(t);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (ageMs <= MS_PER_DAY)  return "hot";
  if (ageMs <= MS_PER_WEEK) return "warm";
  return "cold";
}

function ageDaysFromTimestamp(t) {
  const ms = parseTimestampMs(t);
  if (!ms) return null;
  return (Date.now() - ms) / 86_400_000;
}

function hasTimeSensitiveContent(title, content) {
  const text = ((title || "") + " " + (content || "")).toLowerCase();
  return TIME_SENSITIVE_KEYWORDS.some((kw) => text.includes(kw));
}

function isOrphanedRecord(record) {
  // Records with files_read / files_modified that no longer exist on disk
  const files = [
    ...(Array.isArray(record.files_read) ? record.files_read : []),
    ...(Array.isArray(record.files_modified) ? record.files_modified : []),
  ];
  if (files.length === 0) return false;
  return files.some((f) => {
    if (!f || typeof f !== "object") return false;
    const p = f.path || f;
    if (!p || typeof p !== "string") return false;
    return !fs.existsSync(p);
  });
}

function readJsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { if (!fs.statSync(filePath).isFile()) return []; } catch { return []; }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function deriveContentHash(record) {
  const stored = String((record && record.content_hash) || "").trim();
  if (stored) return stored;
  const basis = String((record && record.content) || (record && record.title) || "").trim();
  if (!basis) return "";
  return crypto.createHash("sha256").update(basis, "utf8").digest("hex");
}

function analyzeRecord(record, seenIds, stats) {
  const { byScope, byTool, byFreshness, byMemoryLevel, bySourceKind } = stats;

  // Basic counts
  stats.totalRecords += 1;

  const scope = String(record.scope || "summary").toLowerCase().trim();
  byScope[scope] = (byScope[scope] || 0) + 1;

  const tool = String(record.tool || "unknown").toLowerCase().trim();
  byTool[tool] = (byTool[tool] || 0) + 1;
  if (!stats.toolsWithRecords.includes(tool)) {
    stats.toolsWithRecords.push(tool);
  }

  const freshness = getFreshnessFromRecord(record);
  byFreshness[freshness] = (byFreshness[freshness] || 0) + 1;

  const memoryLevel = String(record.memory_level || record.memoryLevel || "unknown").toLowerCase().trim();
  byMemoryLevel[memoryLevel] = (byMemoryLevel[memoryLevel] || 0) + 1;

  const sourceKind = String(record.source_kind || record.sourceKind || "unknown").toLowerCase().trim();
  bySourceKind[sourceKind] = (bySourceKind[sourceKind] || 0) + 1;

  // ---- Hygiene issues ----
  if (!deriveContentHash(record)) {
    stats.missingContentHash += 1;
  }
  if (!record.title) {
    stats.missingTitle += 1;
  }
  if (!record.scope) {
    stats.missingScope += 1;
  }
  if (record.scope && !ALLOWED_SCOPES.has(scope)) {
    stats.invalidScopes.push({
      id: record.id || "?",
      scope: record.scope,
    });
  }

  // Duplicate ID
  const recordId = String(record.id || "").trim();
  if (recordId) {
    if (seenIds.has(recordId)) {
      const firstSeenIn = seenIds.get(recordId);
      if (isExpectedDerivedDuplicate(firstSeenIn, stats._currentFile || "?")) {
        return;
      }
      if (stats.duplicateIds.length < 12) {
        stats.duplicateIds.push({
          id: recordId,
          firstSeenIn,
        });
      }
    } else {
      seenIds.set(recordId, stats._currentFile || "?");
    }
  }

  // Promotion health
  const promotion = record.metadata && record.metadata.promotion;
  if (record.source_kind === "writeback" || sourceKind === "writeback") {
    stats.promotedRecords += 1;
  }
  if (promotion && promotion.is_refresh === true) {
    stats.refreshedRecords += 1;
  }

  // ---- Growth metrics ----
  const daysAgo = ageDaysFromTimestamp(record.t || record.created_at || "");
  if (daysAgo !== null) {
    if (daysAgo <= 7)   stats.recordsLast7Days += 1;
    else if (daysAgo <= 30) stats.recordsLast30Days += 1;
    if (daysAgo > 90)    stats.recordsOlderThan90Days += 1;
  }

  // ---- Stale record detection ----
  if (freshness === "cold" && hasTimeSensitiveContent(record.title, record.content)) {
    stats.potentialStaleRecords.push({
      id: recordId || "?",
      title: record.title || "",
      reason: "cold-record-with-time-sensitive-content",
      daysAgo: daysAgo !== null ? Math.round(daysAgo) : null,
    });
  }

  // ---- Orphaned record detection ----
  if (isOrphanedRecord(record)) {
    stats.orphanedRecords.push({
      id: recordId || "?",
      title: record.title || "",
      reason: "referenced-file-not-found",
    });
  }
}

// ---------------------------------------------------------------------------
// Embeddings index health
// ---------------------------------------------------------------------------

function readEmbeddingsStats(embeddingsIndexPath) {
  if (!fs.existsSync(embeddingsIndexPath)) {
    return { exists: false, count: 0, malformedLines: 0, indexedRecords: 0 };
  }
  const lines = fs.readFileSync(embeddingsIndexPath, "utf8").split(/\r?\n/);
  let count = 0;
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { JSON.parse(line); count += 1; } catch { malformed += 1; }
  }
  return { exists: true, count, malformedLines: malformed, indexedRecords: count };
}

// ---------------------------------------------------------------------------
// Health score computation
// ---------------------------------------------------------------------------

function computeHealthScore(stats, embeddingsOk) {
  let score = 100;

  // -5 per missing content_hash, max -20
  const hashPenalty = Math.min(stats.missingContentHash * 5, 20);
  score -= hashPenalty;

  // -5 per missing title, max -10
  const titlePenalty = Math.min(stats.missingTitle * 5, 10);
  score -= titlePenalty;

  // -5 per invalid scope, max -15
  const scopePenalty = Math.min(stats.invalidScopes.length * 5, 15);
  score -= scopePenalty;

  // -3 per duplicate ID, max -15
  const dupPenalty = Math.min(stats.duplicateIds.length * 3, 15);
  score -= dupPenalty;

  // -10 if >10% records older than 90 days
  if (stats.totalRecords > 0) {
    const oldRatio = stats.recordsOlderThan90Days / stats.totalRecords;
    if (oldRatio > 0.10) score -= 10;
  } else if (stats.totalRecords === 0) {
    // No records is a neutral condition — don't penalise
    score = 100;
  }

  // -5 if no records in last 7 days
  if (stats.recordsLast7Days === 0 && stats.totalRecords > 0) {
    score -= 5;
  }

  // +10 if embeddings index is aligned/up to date
  if (embeddingsOk) score += 10;

  return Math.max(0, Math.min(100, score));
}

function gradeFromScore(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(stats) {
  const recommendations = [];

  if (stats.missingContentHash > 0) {
    recommendations.push({
      severity: "medium",
      issue: `${stats.missingContentHash} records missing content_hash`,
      action: "rebuild embeddings to populate content_hash fields",
    });
  }

  if (stats.missingTitle > 0) {
    recommendations.push({
      severity: "low",
      issue: `${stats.missingTitle} records missing title`,
      action: "review and backfill titles for orphaned or malformed records",
    });
  }

  if (stats.missingScope > 0) {
    recommendations.push({
      severity: "medium",
      issue: `${stats.missingScope} records missing scope`,
      action: "run classification pass or manually tag unscoped records",
    });
  }

  if (stats.invalidScopes.length > 0) {
    recommendations.push({
      severity: "medium",
      issue: `${stats.invalidScopes.length} records with invalid scope values`,
      action: "correct scope values to one of: user, feedback, project, reference, summary, task, run",
    });
  }

  if (stats.duplicateIds.length > 0) {
    recommendations.push({
      severity: "high",
      issue: `${stats.duplicateIds.length} duplicate record IDs detected`,
      action: "investigate and deduplicate records with colliding IDs",
    });
  }

  if (stats.potentialStaleRecords.length > 0) {
    recommendations.push({
      severity: "low",
      issue: `${stats.potentialStaleRecords.length} cold records contain time-sensitive keywords`,
      action: "review and archive or refresh stale records with deadline/release/deploy content",
    });
  }

  if (stats.orphanedRecords.length > 0) {
    recommendations.push({
      severity: "medium",
      issue: `${stats.orphanedRecords.length} records reference files that no longer exist`,
      action: "clean up files_read/files_modified arrays for orphaned records",
    });
  }

  if (stats.totalRecords > 0 && stats.recordsOlderThan90Days / stats.totalRecords > 0.10) {
    recommendations.push({
      severity: "low",
      issue: `${stats.recordsOlderThan90Days} records older than 90 days (>10% of store)`,
      action: "consider archival or summarisation of aged records",
    });
  }

  if (stats.recordsLast7Days === 0 && stats.totalRecords > 0) {
    recommendations.push({
      severity: "medium",
      issue: "No new records in the last 7 days",
      action: "verify memory bus ingestion is functioning; check inbox and event sources",
    });
  }

  if (stats.malformedIndexLines > 0) {
    recommendations.push({
      severity: "high",
      issue: `${stats.malformedIndexLines} malformed lines in embeddings index`,
      action: "rebuild embeddings index: node generate-embeddings.js --force",
    });
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ── Tier budget status ───────────────────────────────────────────────────────────
// ADR-002 v2: 5-tier budget enforcement
const TIER_BUDGETS = { 1: 200, 2: 200, 3: 100, 4: 200, 5: 500 };

function computeTierBudgetStatus(allRecords) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rec of allRecords) {
    const t = rec.lifecycle?.tier ?? 1;
    if (counts[t] !== undefined) counts[t]++;
    else counts[1]++;
  }
  const status = {};
  let anyOverBudget = false;
  for (const [tier, max] of Object.entries(TIER_BUDGETS)) {
    const n = counts[tier] || 0;
    status[tier] = { count: n, max, over: n > max };
    if (n > max) anyOverBudget = true;
  }
  // Cold records (no access_count) in Tier 4 also flag archival_needed
  const coldTier4 = allRecords.filter(r =>
    (r.lifecycle?.tier === 4 || r.lifecycle?.tier === undefined) &&
    (r.lifecycle?.access_count || 0) === 0
  ).length;
  return { counts: counts, tiers: status, coldTier4Records: coldTier4, archival_needed: anyOverBudget || coldTier4 > 50 };
}

function main() {
  const storeRoot = resolveStoreRoot();
  const structuredRoot = path.join(storeRoot, "structured");
  const generatedRoot = path.join(storeRoot, "generated");
  const embeddingsIndexPath = path.join(storeRoot, "embeddings", "index.jsonl");

  // Ensure generated directory exists
  if (!fs.existsSync(generatedRoot)) {
    fs.mkdirSync(generatedRoot, { recursive: true });
  }

  // Build structured signature (hash of all structured layer files)
  function sha1(value) {
    return crypto.createHash("sha1").update(String(value || ""), "utf8").digest("hex");
  }
  function fileStamp(filePath) {
    if (!fs.existsSync(filePath)) return `${path.basename(filePath)}:__missing__:0`;
    // Skip directories (e.g. logs/)
    try { if (!fs.statSync(filePath).isFile()) return `${path.basename(filePath)}:__dir__:0`; } catch { return `${path.basename(filePath)}:__missing__:0`; }
    const body = fs.readFileSync(filePath, "utf8");
    return `${path.basename(filePath)}:${sha1(body)}:${Buffer.byteLength(body, "utf8")}`;
  }
  const structuredSignatureRaw = STRUCTURED_LAYER_DEFINITIONS
    .map((def) => fileStamp(path.join(structuredRoot, def.fileName)))
    .join("|") || "__empty__";
  const structuredSignature = sha1(structuredSignatureRaw).slice(0, 16);

  // Collect all records across all structured layers
  const allRecords = [];
  for (const definition of STRUCTURED_LAYER_DEFINITIONS) {
    const filePath = path.join(structuredRoot, definition.fileName);
    const records = readJsonlRecords(filePath);
    // Tag each record with its source file for duplicate tracking
    for (const rec of records) {
      rec._sourceFile = definition.fileName;
    }
    allRecords.push(...records);
  }

  // Embeddings health
  const embedStats = readEmbeddingsStats(embeddingsIndexPath);

  // Seed stats object
  const stats = {
    totalRecords: 0,
    byScope: {},
    byTool: {},
    byFreshness: {},
    byMemoryLevel: {},
    bySourceKind: {},
    missingContentHash: 0,
    missingTitle: 0,
    missingScope: 0,
    invalidScopes: [],
    duplicateIds: [],
    promotedRecords: 0,
    refreshedRecords: 0,
    potentialStaleRecords: [],
    orphanedRecords: [],
    recordsLast7Days: 0,
    recordsLast30Days: 0,
    recordsOlderThan90Days: 0,
    indexedRecords: embedStats.indexedRecords,
    unindexedRecords: Math.max(0, allRecords.length - embedStats.indexedRecords),
    malformedIndexLines: embedStats.malformedLines,
    toolsWithRecords: [],
    toolsWithZeroRecords: [],
    _currentFile: "", // temporary context during analysis
  };

  // Analyze all records
  const seenIds = new Map();
  for (const record of allRecords) {
    stats._currentFile = record._sourceFile || "?";
    analyzeRecord(record, seenIds, stats);
  }
  delete stats._currentFile;

  // Tools with zero records
  const allKnownTools = new Set([
    "claude-code", "openclaw", "system", "context7", "fetch",
    "codex", "opencode", "copilot", "trae", "todo",
  ]);
  for (const tool of allKnownTools) {
    if (!stats.toolsWithRecords.includes(tool)) {
      stats.toolsWithZeroRecords.push(tool);
    }
  }

  // Compute health
  const embeddingsOk = embedStats.exists && embedStats.malformedLines === 0;
  const healthScore = computeHealthScore(stats, embeddingsOk);
  const healthGrade = gradeFromScore(healthScore);

  // Build issues list
  const healthIssues = [];
  if (stats.missingContentHash > 0)     healthIssues.push("missing-content-hash");
  if (stats.missingTitle > 0)            healthIssues.push("missing-title");
  if (stats.missingScope > 0)            healthIssues.push("missing-scope");
  if (stats.invalidScopes.length > 0)    healthIssues.push("invalid-scope-values");
  if (stats.duplicateIds.length > 0)     healthIssues.push("duplicate-record-ids");
  if (stats.potentialStaleRecords.length > 0) healthIssues.push("potential-stale-records");
  if (stats.orphanedRecords.length > 0)  healthIssues.push("orphaned-records");
  if (embedStats.malformedLines > 0)    healthIssues.push("malformed-embeddings-index");
  if (stats.recordsOlderThan90Days / Math.max(1, stats.totalRecords) > 0.10) {
    healthIssues.push("more-than-10pct-records-older-than-90-days");
  }
  if (stats.recordsLast7Days === 0 && stats.totalRecords > 0) {
    healthIssues.push("no-new-records-in-last-7-days");
  }

  const health = {
    score: healthScore,
    grade: healthGrade,
    issues: healthIssues,
  };

  const recommendations = buildRecommendations(stats);

  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    reportVersion: REPORT_VERSION,
    structuredSignature,
    stats,
    recommendations,
    health,
    tier_budget_status: computeTierBudgetStatus(allRecords),
  };

  // Write report
  const reportPath = path.join(generatedRoot, HYGIENE_REPORT_FILE);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  // Console output
  const jsonFlag = process.argv.includes("--json");
  if (jsonFlag) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const lines = [];
    lines.push(`Hygiene report: ${reportPath}`);
    lines.push(`Generated at: ${generatedAt}`);
    lines.push(`Report version: ${REPORT_VERSION}`);
    lines.push(`Structured signature: ${structuredSignature}`);
    lines.push(`Total records: ${stats.totalRecords}`);
    lines.push(`Health score: ${healthScore}/100 (grade ${healthGrade})`);
    lines.push(`Missing content_hash: ${stats.missingContentHash}`);
    lines.push(`Missing title: ${stats.missingTitle}`);
    lines.push(`Missing scope: ${stats.missingScope}`);
    lines.push(`Invalid scopes: ${stats.invalidScopes.length}`);
    lines.push(`Duplicate IDs: ${stats.duplicateIds.length}`);
    lines.push(`Promoted records: ${stats.promotedRecords}`);
    lines.push(`Refreshed records: ${stats.refreshedRecords}`);
    lines.push(`Records last 7 days: ${stats.recordsLast7Days}`);
    lines.push(`Records last 30 days: ${stats.recordsLast30Days}`);
    lines.push(`Records older than 90 days: ${stats.recordsOlderThan90Days}`);
    lines.push(`Potential stale records: ${stats.potentialStaleRecords.length}`);
    lines.push(`Orphaned records: ${stats.orphanedRecords.length}`);
    lines.push(`Embeddings index: ${embedStats.count} entries, ${embedStats.malformedLines} malformed`);
    lines.push(`Recommendations: ${recommendations.length}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

main();
