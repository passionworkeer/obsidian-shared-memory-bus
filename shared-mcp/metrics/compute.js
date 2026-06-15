// shared-mcp/metrics/compute.js
//
// Compute layer for the metrics pipeline: snapshot rendering, runtime
// catalog annotation, and the in-process search-worker lifecycle (state
// machine, restart/backpressure counters, IPC plumbing). Pure CPU
// transforms — no HTTP transport (server.js owns that).
//
// Public surface (re-exported by shared-mcp/omni-metrics.js):
//   - collectMetrics
//   - buildMetricsSnapshot
//   - annotateEmbeddingRuntimeCatalog
//   - buildEmbeddingRuntimeRestartSignature
//   - isSearchWorkerRunning
//   - getSearchWorkerSnapshot
//   - rejectPendingSearchRequests
//   - stopSearchWorker
//   - restartSearchWorker
//   - requestSearchWorker
//   - getSearchWorkerHealth
//   - clearSearchWorkerCache
//   - ensureSearchWorker
//   - resetSearchWorkerState
//   - killSearchWorkerOnExit
//   - METRICS (shared with source.js; see source.js for the canonical owner)

import fs from "node:fs";
import { spawn } from "node:child_process";

import { isProcessAlive } from "../health-check.js";
import { IPC_ERROR_CODES } from "../ipc-protocol.js";
import { log, METRICS } from "./source.js";

// ---------------------------------------------------------------------------
// collectMetrics — render METRICS into Prometheus text exposition format
// ---------------------------------------------------------------------------
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
    } catch {
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
      } catch {
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
  } catch {
    // Best-effort cleanup only.
  }
}

export {
  METRICS,
  collectMetrics,
  buildMetricsSnapshot,
  annotateEmbeddingRuntimeCatalog,
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
};
