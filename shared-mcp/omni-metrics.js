// Metrics collection + state-aggregation for the omni-memory-server.
//
// This module owns:
//   - The in-process METRICS counter object (Prometheus-shaped).
//   - All "read state from disk" helpers used by status/embeddings tools.
//   - The search-worker process lifecycle (PID, restart counters, pending map,
//     circuit breaker, backpressure).
//   - The HTTP /metrics server bootstrap and the metrics-refresh interval.
//
// The MCP entrypoint wires these into sharedParams via the createMemory*
// factories. All state is module-local; nothing leaks through closures.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

import { createStructuredLogger } from "./metrics/structured-logger.js";
import { isProcessAlive } from "./health-check.js";
import { IPC_ERROR_CODES } from "./ipc-protocol.js";
import { AI_MEMORY_ROOT } from "./omni-store.js";
import { firstNonEmptyEnv, isWatchdogSupervisorAlive } from "./omni-platform-helpers.js";

// Structured logger for the server component
const log = createStructuredLogger("omni-memory-server");

// ---------------------------------------------------------------------------
// Observability / metrics (Prometheus-compatible)
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

function collectMetrics() {
  const lines = [];

  for (const [route, statuses] of Object.entries(METRICS.searches_total)) {
    for (const [status, count] of Object.entries(statuses)) {
      lines.push(`memory_search_requests_total{route="${route}",status="${status}"} ${count}`);
    }
  }

  for (const [tool, count] of Object.entries(METRICS.mcp_requests_total)) {
    lines.push(`memory_mcp_requests_total{tool="${tool}"} ${count}`);
  }

  lines.push(`memory_search_worker_restarts_total ${METRICS.search_worker_restarts_total}`);
  lines.push(`memory_search_worker_backpressure_rejected_total ${METRICS.search_worker_backpressure_rejected}`);

  lines.push(`memory_embeddings_index_age_seconds ${METRICS.embeddings_index_age_seconds}`);
  lines.push(`memory_embeddings_index_size ${METRICS.embeddings_index_size}`);
  for (const [file, count] of Object.entries(METRICS.structured_files_total)) {
    lines.push(`memory_structured_records_total{file="${file}"} ${count}`);
  }
  lines.push(`memory_promotion_queue_size_promotion ${METRICS.promotion_queue_size.promotion}`);
  lines.push(`memory_promotion_queue_size_refresh ${METRICS.promotion_queue_size.refresh}`);

  // Phase 1A new metrics — Python-side cache metrics merged in
  lines.push(`memory_cache_hits_total ${METRICS.cache_hits_total}`);
  lines.push(`memory_cache_misses_total ${METRICS.cache_misses_total}`);

  if (METRICS.search_latency_seconds.length > 0) {
    const sorted = METRICS.search_latency_seconds.slice().sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    lines.push(`memory_search_latency_seconds_avg ${avg.toFixed(6)}`);
    lines.push(`memory_search_latency_seconds_p95 ${p95 != null ? p95.toFixed(6) : 0}`);
  }

  if (METRICS.dream_lock_held_seconds.length > 0) {
    const avg = METRICS.dream_lock_held_seconds.reduce((a, b) => a + b, 0) / METRICS.dream_lock_held_seconds.length;
    lines.push(`memory_dream_lock_held_seconds_avg ${avg.toFixed(6)}`);
  }

  return lines.join("\n");
}

/**
 * Build a comprehensive metrics snapshot (JSON object) that merges:
 *   - The Node.js METRICS object
 *   - Cache hit / miss counts (updated by polling Python's metrics-exporter at 9091)
 *   - Worker health snapshot
 *
 * @returns {object}
 */
function buildMetricsSnapshot({
  EMBEDDINGS_INDEX_PATH,
  readEmbeddingRuntimeSummary,
}) {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    nodeMetrics: { ...METRICS },
    searchWorker: getSearchWorkerSnapshot(),
    embeddingRuntime: readEmbeddingRuntimeSummary(),
    embeddingsIndex: {
      indexAgeSeconds: METRICS.embeddings_index_age_seconds,
      indexSize: METRICS.embeddings_index_size,
      path: EMBEDDINGS_INDEX_PATH,
    },
    structuredFiles: { ...METRICS.structured_files_total },
    promotionQueue: { ...METRICS.promotion_queue_size },
    // Note: Python-side metrics (9091) should be fetched separately and merged
    // by the caller if a unified snapshot is needed.
    pythonMetricsUrl: "http://127.0.0.1:9091/metrics",
  };
}

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

function annotateEmbeddingRuntimeCatalog(catalog, embeddingsSummary, { buildEmbeddingConfigHash, HASH_MODEL }) {
  if (!catalog || typeof catalog !== "object") {
    return catalog;
  }

  const annotated = JSON.parse(JSON.stringify(catalog));
  const indexedConfigHashes =
    embeddingsSummary && typeof embeddingsSummary.configHashes === "object" ? embeddingsSummary.configHashes : {};

  const annotateEntry = (entry = {}) => {
    const adapter = String(entry.adapter || entry.backend || "hash").trim() || "hash";
    const modelName = adapter === "hash" ? HASH_MODEL : String(entry.model || "").trim() || HASH_MODEL;
    const configHash = buildEmbeddingConfigHash({
      backend: adapter,
      modelName,
      baseUrl: String(entry.baseUrl || ""),
    });
    const indexedCount = Number(indexedConfigHashes[configHash] || 0);
    return {
      ...entry,
      configHash,
      indexedCount,
      indexCompatible: indexedCount > 0,
      rebuildRequired: indexedCount === 0,
    };
  };

  if (annotated.runtime && typeof annotated.runtime === "object") {
    annotated.runtime = annotateEntry(annotated.runtime);
  }
  if (Array.isArray(annotated.providers)) {
    annotated.providers = annotated.providers.map(annotateEntry);
  }
  if (Array.isArray(annotated.profiles)) {
    annotated.profiles = annotated.profiles.map(annotateEntry);
  }

  return annotated;
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
// Search worker lifecycle state
// ---------------------------------------------------------------------------
let searchWorker = null;
let searchWorkerStartupPromise = null;
let searchWorkerBuffer = "";
let searchWorkerRequestCounter = 0;
let searchWorkerStartedAt = "";
let searchWorkerLastError = "";
let searchWorkerRestartCount = 0;
let searchWorkerFirstFailureAt = null;
const SEARCH_WORKER_MAX_RESTARTS = 5;
const SEARCH_WORKER_CIRCUIT_WINDOW_MS = 300000;
const SEARCH_BACKPRESSURE_LIMIT = 50;
let searchWorkerCircuitOpen = false;
let searchWorkerBackpressureRejected = 0;
const searchWorkerPending = new Map();

function isSearchWorkerRunning() {
  return isProcessAlive(searchWorker);
}

function getSearchWorkerSnapshot() {
  return {
    enabled: true,
    running: isProcessAlive(searchWorker),
    pid: searchWorker?.pid || null,
    startedAt: searchWorkerStartedAt || null,
    pendingRequests: searchWorkerPending.size,
    restartCount: searchWorkerRestartCount,
    lastError: searchWorkerLastError || "",
    mode: "isolated-subprocess",
    isolation: "separate-nodejs-process-with-stdio-ipc",
    circuitBreaker: {
      circuitOpen: searchWorkerCircuitOpen,
      restartCount: searchWorkerRestartCount,
      firstFailureAt: searchWorkerFirstFailureAt ? new Date(searchWorkerFirstFailureAt).toISOString() : null,
      backpressureRejected: searchWorkerBackpressureRejected,
      maxRestarts: SEARCH_WORKER_MAX_RESTARTS,
      circuitWindowMs: SEARCH_WORKER_CIRCUIT_WINDOW_MS,
    },
  };
}

function rejectPendingSearchRequests(reason) {
  for (const [, pending] of searchWorkerPending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  searchWorkerPending.clear();
}

function resetSearchWorkerState(reason = "") {
  searchWorkerBuffer = "";
  if (reason) {
    searchWorkerLastError = reason;
  }
  rejectPendingSearchRequests(reason || "search-worker-reset");
  searchWorker = null;
}

function handleSearchWorkerStdout(chunk) {
  searchWorkerBuffer += chunk.toString();
  const lines = searchWorkerBuffer.split(/\r?\n/);
  searchWorkerBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      searchWorkerLastError = `search-worker-invalid-json: ${error.message}`;
      continue;
    }

    const requestId = String(payload?.id || "").trim();
    if (!requestId || !searchWorkerPending.has(requestId)) {
      continue;
    }

    const pending = searchWorkerPending.get(requestId);
    searchWorkerPending.delete(requestId);
    clearTimeout(pending.timeout);
    if (payload?.ok === false) {
      pending.reject(Object.assign(new Error(String(payload.error || "search-worker-error")), { code: IPC_ERROR_CODES.INTERNAL_ERROR }));
      continue;
    }
    pending.resolve(payload);
    if (payload && typeof payload === "object") {
      METRICS.embeddings_index_age_seconds = payload.embeddings?.indexAgeSeconds || METRICS.embeddings_index_age_seconds;
      METRICS.embeddings_index_size = payload.embeddings?.indexedCount || METRICS.embeddings_index_size;
    }
  }
}

function resetSearchWorkerHealth() {
  searchWorkerRestartCount = 0;
  searchWorkerFirstFailureAt = null;
  searchWorkerCircuitOpen = false;
}

function checkSearchWorkerCircuit() {
  const now = Date.now();
  if (searchWorkerCircuitOpen) {
    if (
      searchWorkerRestartCount < SEARCH_WORKER_MAX_RESTARTS ||
      now - searchWorkerFirstFailureAt >= SEARCH_WORKER_CIRCUIT_WINDOW_MS
    ) {
      resetSearchWorkerHealth();
      return false;
    }
    return true;
  }
  return false;
}

function handleSearchWorkerExit(code, signal) {
  const reason = `search-worker-exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
  const now = Date.now();
  if (checkSearchWorkerCircuit()) {
    searchWorkerCircuitOpen = true;
    log.error("search-worker-circuit-open", {
      restartCount: searchWorkerRestartCount,
      circuitWindowMs: SEARCH_WORKER_CIRCUIT_WINDOW_MS,
    });
    resetSearchWorkerState(reason);
    return;
  }

  searchWorkerRestartCount += 1;
  METRICS.search_worker_restarts_total = searchWorkerRestartCount;
  if (searchWorkerRestartCount === 1) {
    searchWorkerFirstFailureAt = now;
  }
  const backoffMs = Math.min(1000 * Math.pow(2, searchWorkerRestartCount - 1), 30000);
  resetSearchWorkerState(reason);
  setTimeout(async () => {
    try {
      await ensureSearchWorker();
    } catch (error) {
      log.error("search-worker-scheduled-restart-failed", { error: error.message, backoffMs });
    }
  }, backoffMs);
}

async function stopSearchWorker(reason = "search-worker-stop-requested") {
  if (searchWorkerStartupPromise) {
    try {
      await searchWorkerStartupPromise;
    } catch (_error) {
      // Startup failure already updates the shared worker state.
    }
  }

  const child = searchWorker;
  if (!child || child.killed || child.exitCode !== null) {
    return {
      ok: true,
      stopped: false,
      previousPid: child?.pid || null,
      reason: "search-worker-not-running",
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const previousPid = child.pid || null;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: true, previousPid, ...payload });
    };

    const exitHandler = (code, signal) => {
      clearTimeout(timeout);
      finish({
        stopped: true,
        exitCode: code ?? null,
        signal: signal ?? null,
        reason: `search-worker-exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
      });
    };

    const timeout = setTimeout(() => {
      child.removeListener("exit", exitHandler);
      try {
        child.kill("SIGKILL");
      } catch (_error) {
        // best-effort cleanup only
      }
      resetSearchWorkerState(`${reason}-timeout`);
      finish({
        stopped: false,
        exitCode: child.exitCode ?? null,
        signal: "timeout",
        reason: `${reason}-timeout`,
      });
    }, 5000);

    child.once("exit", exitHandler);
    try {
      child.kill();
    } catch (error) {
      clearTimeout(timeout);
      child.removeListener("exit", exitHandler);
      resetSearchWorkerState(String(error?.message || error));
      finish({
        stopped: false,
        exitCode: child.exitCode ?? null,
        signal: "kill-error",
        reason: String(error?.message || error),
      });
    }
  });
}

async function restartSearchWorker(reason = "search-worker-restart-requested") {
  const before = getSearchWorkerSnapshot();
  const stop = await stopSearchWorker(reason);
  const child = await ensureSearchWorker();
  const health = await getSearchWorkerHealth();
  const after = getSearchWorkerSnapshot();
  return {
    ok: true,
    requested: true,
    reason,
    previousPid: before.pid,
    currentPid: child?.pid || null,
    pidChanged: Number.isInteger(before.pid) && before.pid > 0 ? before.pid !== (child?.pid || null) : null,
    stop,
    before,
    after,
    health,
  };
}

async function ensureSearchWorker({
  SEARCH_SCRIPT,
  PYTHON,
  withPythonArgs,
  PYTHON_SPAWN_ENV,
  STORE_ROOT,
}) {
  if (isSearchWorkerRunning()) {
    return searchWorker;
  }
  if (searchWorkerStartupPromise) {
    return searchWorkerStartupPromise;
  }
  if (!fs.existsSync(SEARCH_SCRIPT)) {
    throw new Error(`search-script-missing: ${SEARCH_SCRIPT}`);
  }
  if (!PYTHON.available) {
    throw new Error(`python-runtime-unavailable: ${PYTHON.error || "unknown-error"}`);
  }

  searchWorkerStartupPromise = new Promise((resolve, reject) => {
    const child = spawn(PYTHON.command, withPythonArgs(PYTHON, [SEARCH_SCRIPT, "--server"]), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...PYTHON_SPAWN_ENV,
        AI_MEMORY_STORE: STORE_ROOT,
      },
    });

    let settled = false;
    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      searchWorker = child;
      searchWorkerStartedAt = new Date().toISOString();
      searchWorkerLastError = "";
      searchWorkerBuffer = "";
      child.stdout.on("data", handleSearchWorkerStdout);
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          searchWorkerLastError = text;
          // Log at warn level — stderr from the worker may be benign
          log.warn("search-worker-stderr", { text });
        }
      });
      child.on("exit", handleSearchWorkerExit);
      child.on("error", (error) => {
        searchWorkerLastError = String(error?.message || error);
      });
      resolve(child);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resetSearchWorkerState(String(error?.message || error));
      reject(error);
    };

    child.once("spawn", settleResolve);
    child.once("error", settleReject);
    child.once("exit", (code, signal) => {
      if (!settled) {
        settleReject(new Error(`search-worker-startup-exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
    });
  }).finally(() => {
    searchWorkerStartupPromise = null;
  });

  return searchWorkerStartupPromise;
}

async function requestSearchWorker(payload, timeoutMs = 120000, deps = {}) {
  if (checkSearchWorkerCircuit()) {
    throw Object.assign(new Error("Search worker circuit breaker open, manual restart required"), { code: IPC_ERROR_CODES.CIRCUIT_OPEN });
  }
  if (searchWorkerPending.size >= SEARCH_BACKPRESSURE_LIMIT) {
    searchWorkerBackpressureRejected += 1;
    METRICS.search_worker_backpressure_rejected = searchWorkerBackpressureRejected;
    throw Object.assign(new Error("Search worker overloaded, try again later"), { code: IPC_ERROR_CODES.BACKPRESSURE });
  }

  const child = await ensureSearchWorker(deps);
  return await new Promise((resolve, reject) => {
    const requestId = `search-${Date.now()}-${++searchWorkerRequestCounter}`;
    const timeout = setTimeout(() => {
      searchWorkerPending.delete(requestId);
      reject(new Error("search-worker-timeout"));
    }, timeoutMs);
    searchWorkerPending.set(requestId, {
      resolve: (val) => {
        if (searchWorkerRestartCount > 0) {
          resetSearchWorkerHealth();
        }
        resolve(val);
      },
      reject,
      timeout,
    });
    try {
      child.stdin.write(`${JSON.stringify({ id: requestId, ...payload })}\n`, "utf8");
    } catch (error) {
      clearTimeout(timeout);
      searchWorkerPending.delete(requestId);
      reject(error);
    }
  });
}

async function getSearchWorkerHealth(deps = {}) {
  try {
    return await requestSearchWorker({ action: "health" }, 10000, deps);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function clearSearchWorkerCache({ includeDataCaches = false } = {}, deps = {}) {
  return await requestSearchWorker({ action: "clear_cache", includeDataCaches }, 30000, deps);
}

function killSearchWorkerOnExit() {
  try {
    if (isProcessAlive(searchWorker)) {
      searchWorker.kill();
    }
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

// ---------------------------------------------------------------------------
// HTTP metrics server (Prometheus-compatible /metrics endpoint)
// ---------------------------------------------------------------------------
function startMetricsServer({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }) {
  const port = Number(firstNonEmptyEnv("AI_MEMORY_METRICS_PORT") || "9090");
  const metricsToken = firstNonEmptyEnv("AI_MEMORY_METRICS_TOKEN");
  const requireMetricsAuth = metricsToken && metricsToken.length > 0;
  const metricsServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        searchWorker: getSearchWorkerSnapshot(),
        // Phase 1A: full metrics snapshot at /health
        snapshot: buildMetricsSnapshot({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }),
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      if (requireMetricsAuth) {
        const authHeader = req.headers["authorization"] || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== metricsToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(collectMetrics());
      return;
    }
    // Phase 1A: proxy Python-side metrics from the search worker exporter (9091)
    if (req.method === "GET" && req.url === "/python-metrics") {
      const pythonPort = Number(firstNonEmptyEnv("AI_MEMORY_PY_METRICS_PORT") || "9091");
      const pythonReq = http.get(
        { hostname: "127.0.0.1", port: pythonPort, path: "/metrics", timeout: 3000 },
        (pythonRes) => {
          res.writeHead(pythonRes.statusCode || 200, { "Content-Type": "text/plain; version=0.0.4" });
          pythonRes.pipe(res);
        },
      );
      pythonReq.on("error", () => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "python-metrics-unavailable" }));
      });
      pythonReq.on("timeout", () => {
        pythonReq.destroy();
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "python-metrics-timeout" }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  metricsServer.on("error", (err) => { log.error("metrics-server-error", { port, error: err.message }); });
  metricsServer.listen(port, () => { log.info("metrics-server-started", { port }); });
}

function startMetricsRefreshInterval({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary }) {
  setInterval(
    () => refreshMetricsFromFiles({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary }),
    60_000,
  );
  refreshMetricsFromFiles({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary });
}

export {
  METRICS,
  collectMetrics,
  buildMetricsSnapshot,
  refreshEmbeddingMetricsFromSummary,
  refreshMetricsFromFiles,
  readWatchdogState,
  readEmbeddingsSummary,
  readEmbeddingRuntimeSummary,
  readMemoryIntegritySummary,
  readMemoryHygieneReport,
  buildEmbeddingIndexState,
  annotateEmbeddingRuntimeCatalog,
  readEmbeddingRuntimeCatalog,
  buildEmbeddingRuntimeRestartSignature,
  isSearchWorkerRunning,
  getSearchWorkerSnapshot,
  rejectPendingSearchRequests,
  stopSearchWorker,
  restartSearchWorker,
  requestSearchWorker,
  getSearchWorkerHealth,
  clearSearchWorkerCache,
  ensureSearchWorker,
  resetSearchWorkerState,
  killSearchWorkerOnExit,
  startMetricsServer,
  startMetricsRefreshInterval,
  log,
};