// shared-mcp/metrics/source.js
//
// Disk/state readers that feed the metrics pipeline. Pure read helpers —
// no HTTP, no IPC, no long-lived state. Functions here are the data
// acquisition layer for the metrics surface (compute.js + server.js).
//
// Public surface (re-exported by shared-mcp/omni-metrics.js):
//   - readWatchdogState
//   - readEmbeddingsSummary
//   - readEmbeddingRuntimeSummary
//   - readMemoryIntegritySummary
//   - readMemoryHygieneReport
//   - readEmbeddingRuntimeCatalog
//   - buildEmbeddingIndexState
//   - refreshEmbeddingMetricsFromSummary
//   - refreshMetricsFromFiles
//   - buildEmbeddingRuntimeRestartSignature
//   - log
//
// The METRICS counter object intentionally lives here (next to its
// primary writers — the source refresh helpers) and is re-imported by
// compute.js. External callers should go through the re-export shell.

import fs from "node:fs";
import path from "node:path";

import { createStructuredLogger } from "./structured-logger.js";
import { isProcessAlive } from "../health-check.js";
import { AI_MEMORY_ROOT } from "../omni-store.js";
import { firstNonEmptyEnv, isWatchdogSupervisorAlive } from "../omni-platform-helpers.js";

// Structured logger for the metrics/server component
const log = createStructuredLogger("omni-memory-server");

// ---------------------------------------------------------------------------
// Observability / metrics counters (Prometheus-compatible, mutated in place)
// ---------------------------------------------------------------------------
const METRICS = {
  searches_total: {},          // {route: {ok: N, error: N}}
  search_latency_seconds: [],  // circular buffer, last 100 values in seconds
  embeddings_index_age_seconds: 0,
  embeddings_index_size: 0,
  structured_files_total: {},   // {filename: count}
  promotion_queue_size: { promotion: 0, refresh: 0 },
  search_worker_restarts_total: 0,
  search_worker_backpressure_rejected: 0,
  dream_lock_held_seconds: [],   // circular buffer, last 20 values
  mcp_requests_total: {},       // {tool: count}
  // Phase 1A new metrics
  cache_hits_total: 0,
  cache_misses_total: 0,
};

// ---------------------------------------------------------------------------
// Watchdog / process helpers
// ---------------------------------------------------------------------------

function readWatchdogState() {
  const WATCHDOG_STATE_PATH = path.join(AI_MEMORY_ROOT, "watchdog-state.json");
  if (!fs.existsSync(WATCHDOG_STATE_PATH)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(WATCHDOG_STATE_PATH, "utf8"));
    const pid = Number(payload?.pid || 0);
    const pidAlive = isProcessAlive(pid);
    const reportedRunning = Boolean(payload?.running);
    const updatedAtMs = Date.parse(String(payload?.updatedAt || ""));
    const stateAgeSeconds = Number.isFinite(updatedAtMs)
      ? Math.max(0, Math.round((Date.now() - updatedAtMs) / 1000))
      : null;
    const staleByAge = Number.isFinite(updatedAtMs)
      ? Date.now() - updatedAtMs >
        Math.max(
          60_000,
          (Number(payload?.pollSeconds || 15) || 15) * 8_000,
          (Number(payload?.staleMinutes || 0) || 0) * 60_000
        )
      : false;
    const supervisorAlive = isWatchdogSupervisorAlive();
    const recovering = reportedRunning && !pidAlive && supervisorAlive && !staleByAge;
    const running = reportedRunning && !staleByAge && (pidAlive || supervisorAlive);
    const stale = (reportedRunning && !pidAlive && !supervisorAlive) || staleByAge;
    const status = running
      ? "running"
      : supervisorAlive
        ? (staleByAge ? "stale" : "recovering")
        : pidAlive
          ? "stale"
          : "stopped";
    return { ...payload, pidAlive, supervisorAlive, reportedRunning, recovering, running, stale, stateAgeSeconds, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}


function readEmbeddingsSummary({ EMBEDDINGS_INDEX_PATH }) {
  if (!fs.existsSync(EMBEDDINGS_INDEX_PATH)) {
    return {
      exists: false,
      path: EMBEDDINGS_INDEX_PATH,
      count: 0,
      bytes: 0,
      updatedAt: null,
      ageSeconds: null,
      tools: {},
      backends: {},
      models: {},
      dimensions: {},
      providerHosts: {},
      configHashes: {},
    };
  }

  const tools = {};
  const backends = {};
  const models = {};
  const dimensions = {};
  const providerHosts = {};
  const configHashes = {};
  let count = 0;
  const lines = fs.readFileSync(EMBEDDINGS_INDEX_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      count += 1;
      const tool = record.tool || "unknown";
      tools[tool] = (tools[tool] || 0) + 1;
      const backend = record.backend || "unknown";
      backends[backend] = (backends[backend] || 0) + 1;
      const model = record.model || "unknown";
      models[model] = (models[model] || 0) + 1;
      const dim = Number(record.dim) || (Array.isArray(record.embedding) ? record.embedding.length : 0);
      if (dim > 0) {
        dimensions[String(dim)] = (dimensions[String(dim)] || 0) + 1;
      }
      if (record.providerHost) {
        providerHosts[record.providerHost] = (providerHosts[record.providerHost] || 0) + 1;
      }
      if (record.configHash) {
        configHashes[record.configHash] = (configHashes[record.configHash] || 0) + 1;
      }
    } catch (err) {
      log.warn("embeddings-index-json-parse-error", { error: err.message, path: EMBEDDINGS_INDEX_PATH });
    }
  }

  const stat = fs.statSync(EMBEDDINGS_INDEX_PATH);
  const ageSeconds = Number.isFinite(stat.mtimeMs)
    ? Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000))
    : null;
  return {
    exists: true,
    path: EMBEDDINGS_INDEX_PATH,
    count,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    ageSeconds,
    tools,
    backends,
    models,
    dimensions,
    providerHosts,
    configHashes,
  };
}

function readEmbeddingRuntimeSummary({ resolveEmbeddingRuntime, EMBEDDING_RUNTIME_DEFAULTS }) {
  const runtime = resolveEmbeddingRuntime({
    rootPath: AI_MEMORY_ROOT,
    getEnvValue: firstNonEmptyEnv,
    defaults: EMBEDDING_RUNTIME_DEFAULTS,
  });
  return {
    profile: runtime.profileName || "",
    provider: runtime.providerName || "",
    adapter: runtime.adapter || runtime.backend || "hash",
    backend: runtime.backend || "hash",
    model: runtime.model || "all-MiniLM-L6-v2",
    baseUrl: runtime.baseUrl || "",
    apiKeyEnv: runtime.apiKeyEnv || "",
    apiKeyConfigured: Boolean(runtime.apiKey),
    processEmbeddingOverridesAllowed: Boolean(runtime.processEmbeddingOverridesAllowed),
    timeoutMs: runtime.timeoutMs || 120000,
    requestDelayMs: runtime.requestDelayMs || 0,
    batchSize: runtime.batchSize || 0,
    allowBatchFallback: Boolean(runtime.allowBatchFallback),
    resolutionMode: runtime.resolutionMode || "",
    availableProfiles: Array.isArray(runtime.availableProfiles) ? runtime.availableProfiles : [],
    availableProviders: Array.isArray(runtime.availableProviders) ? runtime.availableProviders : [],
    configPath: runtime.configPath || "",
    configExists: Boolean(runtime.configExists),
    configError: runtime.configError || "",
  };
}

function readMemoryIntegritySummary({ buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT }) {
  return buildMemoryIntegrityReport({ structuredRoot: STRUCTURED_ROOT, generatedRoot: GENERATED_ROOT, detailLimit: 8 });
}

function readMemoryHygieneReport({ GENERATED_ROOT }) {
  const hygienePath = path.join(GENERATED_ROOT, "memory_hygiene_report.json");
  if (!fs.existsSync(hygienePath)) {
    return { ok: false, reason: "report-not-found" };
  }
  try {
    const content = fs.readFileSync(hygienePath, "utf8");
    const parsed = JSON.parse(content);
    return {
      ok: true,
      generatedAt: parsed.generatedAt || null,
      stats: parsed.stats || {},
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      samples: parsed.samples || {},
      filePath: hygienePath,
    };
  } catch (error) {
    return { ok: false, reason: "report-parse-failed", error: String(error), filePath: hygienePath };
  }
}

function buildEmbeddingIndexState(runtimeSummary, embeddingsSummary, { buildEmbeddingConfigHash, HASH_MODEL }) {
  const adapter = String(runtimeSummary?.adapter || runtimeSummary?.backend || "hash").trim() || "hash";
  const modelName = adapter === "hash" ? HASH_MODEL : String(runtimeSummary?.model || "").trim() || HASH_MODEL;
  const activeConfigHash = buildEmbeddingConfigHash({
    backend: adapter,
    modelName,
    baseUrl: String(runtimeSummary?.baseUrl || ""),
  });
  const indexedConfigHashes =
    embeddingsSummary && typeof embeddingsSummary.configHashes === "object" ? embeddingsSummary.configHashes : {};
  const uniqueConfigHashes = Object.keys(indexedConfigHashes);

  if (!embeddingsSummary?.exists || embeddingsSummary?.count === 0) {
    return {
      status: "missing",
      rebuildRequired: true,
      reason: "embeddings-index-missing-or-empty",
      activeConfigHash,
      indexedConfigHash: "",
      indexedConfigHashes,
    };
  }

  if (uniqueConfigHashes.length === 0) {
    return {
      status: "unknown",
      rebuildRequired: true,
      reason: "embeddings-index-missing-config-hash",
      activeConfigHash,
      indexedConfigHash: "",
      indexedConfigHashes,
    };
  }

  if (uniqueConfigHashes.length > 1) {
    return {
      status: "mixed",
      rebuildRequired: true,
      reason: "embeddings-index-has-mixed-config-hashes",
      activeConfigHash,
      indexedConfigHash: "",
      indexedConfigHashes,
    };
  }

  const indexedConfigHash = uniqueConfigHashes[0];
  if (indexedConfigHash !== activeConfigHash) {
    return {
      status: "stale",
      rebuildRequired: true,
      reason: "active-runtime-differs-from-index",
      activeConfigHash,
      indexedConfigHash,
      indexedConfigHashes,
    };
  }

  return {
    status: "aligned",
    rebuildRequired: false,
    reason: "",
    activeConfigHash,
    indexedConfigHash,
    indexedConfigHashes,
  };
}

function readEmbeddingRuntimeCatalog({ buildEmbeddingRuntimeCatalog, EMBEDDING_RUNTIME_DEFAULTS }) {
  return buildEmbeddingRuntimeCatalog({
    rootPath: AI_MEMORY_ROOT,
    getEnvValue: firstNonEmptyEnv,
    defaults: EMBEDDING_RUNTIME_DEFAULTS,
  });
}

function buildEmbeddingRuntimeRestartSignature(runtimeSummary = {}) {
  return JSON.stringify({
    profile: String(runtimeSummary?.profile || runtimeSummary?.profileName || "").trim(),
    provider: String(runtimeSummary?.provider || runtimeSummary?.providerName || "").trim(),
    adapter: String(runtimeSummary?.adapter || runtimeSummary?.backend || "hash").trim() || "hash",
    backend: String(runtimeSummary?.backend || runtimeSummary?.adapter || "hash").trim() || "hash",
    model: String(runtimeSummary?.model || "").trim(),
    baseUrl: String(runtimeSummary?.baseUrl || "").trim(),
    timeoutMs: Number(runtimeSummary?.timeoutMs || 0),
    requestDelayMs: Number(runtimeSummary?.requestDelayMs || runtimeSummary?.delayMs || 0),
    batchSize: Number(runtimeSummary?.batchSize || 0),
    allowBatchFallback: Boolean(runtimeSummary?.allowBatchFallback),
  });
}

// ---------------------------------------------------------------------------
// METRICS refresh helpers (file-backed)
// ---------------------------------------------------------------------------

function refreshEmbeddingMetricsFromSummary(summary = null) {
  const count = Number(summary?.count || 0);
  const ageSeconds = Number(summary?.ageSeconds);
  METRICS.embeddings_index_size = Number.isFinite(count) ? count : 0;
  METRICS.embeddings_index_age_seconds =
    Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0;
}

function refreshMetricsFromFiles({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary }) {
  try {
    refreshEmbeddingMetricsFromSummary(readEmbeddingsSummary());
    const hygienePath = path.join(GENERATED_ROOT, "memory_hygiene_report.json");
    if (fs.existsSync(hygienePath)) {
      const hygiene = JSON.parse(fs.readFileSync(hygienePath, "utf8"));
      for (const [scope, count] of Object.entries(hygiene.stats?.byScope || {})) {
        METRICS.structured_files_total[`scope:${scope}`] = count;
      }
      const dreamStatePath = path.join(STORE_ROOT, "state", "auto-dream-state.json");
      if (fs.existsSync(dreamStatePath)) {
        const dreamState = JSON.parse(fs.readFileSync(dreamStatePath, "utf8"));
        METRICS.promotion_queue_size.promotion = Array.isArray(dreamState.promotionQueue)
          ? dreamState.promotionQueue.length
          : 0;
        METRICS.promotion_queue_size.refresh = Array.isArray(dreamState.refreshQueue)
          ? dreamState.refreshQueue.length
          : 0;
      }
    }
  } catch (_err) {
    // Non-fatal — metrics refresh failures should not crash the server.
  }
}

export {
  log,
  METRICS,
  readWatchdogState,
  readEmbeddingsSummary,
  readEmbeddingRuntimeSummary,
  readMemoryIntegritySummary,
  readMemoryHygieneReport,
  readEmbeddingRuntimeCatalog,
  buildEmbeddingIndexState,
  buildEmbeddingRuntimeRestartSignature,
  refreshEmbeddingMetricsFromSummary,
  refreshMetricsFromFiles,
};
