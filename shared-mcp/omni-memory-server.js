import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const IS_WINDOWS = process.platform === "win32";
const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..");
const WINDOWS_ENV_CACHE = new Map();
const RUNTIME_ENV_NAMES = [
  "AI_MEMORY_ROOT",
  "AI_MEMORY_RUNTIME_CONFIG_PATH",
  "AI_MEMORY_PYTHON",
  "AI_MEMORY_OBSIDIAN_VAULT",
  "OBSIDIAN_VAULT_ROOT",
  "CLAUDE_MEM_BASE",
  "OPENCLAW_HOME",
  "OPENCLAW_BLACKBOARD_DB",
  "AI_MEMORY_EMBED_ADAPTER",
  "AI_MEMORY_EMBED_BACKEND",
  "AI_MEMORY_EMBED_BASE_URL",
  "AI_MEMORY_EMBED_API_KEY",
  "AI_MEMORY_EMBED_API_KEY_ENV",
  "AI_MEMORY_EMBED_MODEL",
  "AI_MEMORY_EMBED_PROFILE",
  "AI_MEMORY_EMBED_PROVIDER",
  "AI_MEMORY_EMBED_TIMEOUT_MS",
  "AI_MEMORY_EMBED_TIMEOUT_SECONDS",
  "AI_MEMORY_EMBED_REQUEST_DELAY_MS",
  "AI_MEMORY_EMBED_DELAY_MS",
  "AI_MEMORY_EMBED_BATCH_SIZE",
  "AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK",
];

function resolveRuntimePath(...candidates) {
  for (const relativePath of candidates) {
    const fullPath = path.join(AI_MEMORY_ROOT, relativePath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return path.join(AI_MEMORY_ROOT, candidates[0]);
}

function loadVaultResolver() {
  const helperPath = resolveRuntimePath("vault-root.js", path.join("bus", "vault-root.js"));
  return require(helperPath);
}

function loadPythonRuntimeHelper() {
  const helperPath = resolveRuntimePath("python-runtime.js", path.join("bus", "python-runtime.js"));
  return require(helperPath);
}

function loadRuntimeConfigHelper() {
  const helperPath = resolveRuntimePath("runtime-config.js", path.join("bus", "runtime-config.js"));
  return require(helperPath);
}

function loadEmbeddingProviderHelper() {
  const helperPath = resolveRuntimePath("embedding-provider-registry.js", path.join("bus", "embedding-provider-registry.js"));
  return require(helperPath);
}

function loadMemoryContractHelper() {
  const helperPath = resolveRuntimePath("memory-contract.js", path.join("ops", "memory-contract.js"));
  return require(helperPath);
}

function readWindowsEnvironmentVariable(name) {
  if (!IS_WINDOWS) {
    return "";
  }
  if (WINDOWS_ENV_CACHE.has(name)) {
    return WINDOWS_ENV_CACHE.get(name);
  }

  const escapedName = String(name || "").replace(/'/g, "''");
  const command = [
    `$value = [Environment]::GetEnvironmentVariable('${escapedName}', 'User')`,
    "if ([string]::IsNullOrWhiteSpace($value)) {",
    `  $value = [Environment]::GetEnvironmentVariable('${escapedName}', 'Machine')`,
    "}",
    "if (-not [string]::IsNullOrWhiteSpace($value)) { [Console]::Out.Write($value) }",
  ].join(" ");

  let value = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      value = String(result.stdout || "").trim();
    }
  } catch (_error) {
    value = "";
  }

  WINDOWS_ENV_CACHE.set(name, value);
  return value;
}

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const name of names) {
    const value = readWindowsEnvironmentVariable(name);
    if (value) {
      return value;
    }
  }
  return "";
}

function buildMergedEnv(baseEnv = process.env, names = RUNTIME_ENV_NAMES) {
  const merged = { ...(baseEnv || {}) };
  for (const name of names) {
    const current = merged[name];
    if (typeof current === "string" && current.trim()) {
      continue;
    }
    const resolved = firstNonEmptyEnv(name);
    if (resolved) {
      merged[name] = resolved;
    }
  }
  return merged;
}

function resolvePowerShellCommand() {
  if (IS_WINDOWS) {
    return "powershell.exe";
  }

  for (const candidate of [
    firstNonEmptyEnv("AI_MEMORY_PWSH"),
    "pwsh",
    "/usr/local/bin/pwsh",
    "/opt/homebrew/bin/pwsh",
  ]) {
    if (!candidate) {
      continue;
    }
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
    try {
      const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    } catch (_error) {
      // Keep probing fallbacks.
    }
  }

  return firstNonEmptyEnv("AI_MEMORY_PWSH") || "pwsh";
}

const SEARCH_SCRIPT = resolveRuntimePath("semantic-search.py", path.join("retrieval", "semantic-search.py"));
const EMBEDDINGS_SCRIPT = resolveRuntimePath("generate-embeddings.js", path.join("bus", "generate-embeddings.js"));
const MEMORY_BUS_SCRIPT = resolveRuntimePath("memory-bus.ps1", path.join("bus", "memory-bus.ps1"));
const HANDOFF_PACK_SCRIPT = resolveRuntimePath("build-handoff-pack.js", path.join("ops", "build-handoff-pack.js"));
const MEMORY_LAYERS_SCRIPT = resolveRuntimePath("build-memory-layers.js", path.join("ops", "build-memory-layers.js"));
const MEMORY_DREAM_SCRIPT = resolveRuntimePath("run-memory-dream.ps1", path.join("ops", "run-memory-dream.ps1"));
const WATCHDOG_STATE_PATH = path.join(AI_MEMORY_ROOT, "watchdog-state.json");
const WATCHDOG_SUPERVISOR_VBS_PATH = IS_WINDOWS
  ? path.join(
      process.env.APPDATA || path.join(USER_HOME, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "AI Memory Watchdog.vbs",
    )
  : "";
const WATCHDOG_SUPERVISOR_SCRIPT_PATH = resolveRuntimePath(
  "memory-watchdog-supervisor.ps1",
  path.join("bus", "memory-watchdog-supervisor.ps1"),
);
const RUNTIME_ENV = buildMergedEnv();
const OPENCLAW_HOME = firstNonEmptyEnv("OPENCLAW_HOME") || path.join(USER_HOME, ".openclaw");
const BLACKBOARD_DB_PATH =
  firstNonEmptyEnv("OPENCLAW_BLACKBOARD_DB") || path.join(OPENCLAW_HOME, "workspace", "ai-shrimp", "blackboard", "tasks.db");
const { resolveVaultRoot } = loadVaultResolver();
const { resolvePythonRuntime, withPythonArgs } = loadPythonRuntimeHelper();
const { buildEmbeddingConfigHash } = loadEmbeddingProviderHelper();
const { buildMemoryIntegrityReport } = loadMemoryContractHelper();
const { buildEmbeddingRuntimeCatalog, resolveEmbeddingRuntime, updateEmbeddingRuntimeSelection } = loadRuntimeConfigHelper();
const POWERSHELL_COMMAND = resolvePowerShellCommand();
const HASH_MODEL = "hashing-v1";
const EMBEDDING_RUNTIME_DEFAULTS = {
  adapter: "hash",
  model: "all-MiniLM-L6-v2",
  timeoutMs: 120000,
  requestDelayMs: 0,
  batchSize: 0,
  allowBatchFallback: false,
};

const PYTHON = resolvePythonRuntime();
const PYTHON_SPAWN_ENV = {
  ...RUNTIME_ENV,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};
const SEARCH_ROUTE_VALUES = new Set(["auto", "mixed", "durable", "task", "recent", "reference"]);
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
let watchdogSupervisorCache = {
  checkedAt: 0,
  alive: false,
};

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
};
const MAX_LATENCY_BUFFER = 100;
const MAX_LOCK_BUFFER = 20;

// ---------------------------------------------------------------------------
// Metrics collection (Prometheus-compatible /metrics endpoint)
// ---------------------------------------------------------------------------

function collectMetrics() {
  const lines = [];

  // Counters — search requests
  for (const [route, statuses] of Object.entries(METRICS.searches_total)) {
    for (const [status, count] of Object.entries(statuses)) {
      lines.push(`memory_search_requests_total{route="${route}",status="${status}"} ${count}`);
    }
  }

  // Counters — MCP tool requests
  for (const [tool, count] of Object.entries(METRICS.mcp_requests_total)) {
    lines.push(`memory_mcp_requests_total{tool="${tool}"} ${count}`);
  }

  lines.push(`memory_search_worker_restarts_total ${METRICS.search_worker_restarts_total}`);
  lines.push(`memory_search_worker_backpressure_rejected_total ${METRICS.search_worker_backpressure_rejected}`);

  // Gauges
  lines.push(`memory_embeddings_index_age_seconds ${METRICS.embeddings_index_age_seconds}`);
  lines.push(`memory_embeddings_index_size ${METRICS.embeddings_index_size}`);
  for (const [file, count] of Object.entries(METRICS.structured_files_total)) {
    lines.push(`memory_structured_records_total{file="${file}"} ${count}`);
  }
  lines.push(`memory_promotion_queue_size_promotion ${METRICS.promotion_queue_size.promotion}`);
  lines.push(`memory_promotion_queue_size_refresh ${METRICS.promotion_queue_size.refresh}`);

  // Histogram approximations (from circular buffers)
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

function refreshMetricsFromFiles() {
  try {
    const hygienePath = path.join(GENERATED_ROOT, "memory_hygiene_report.json");
    if (fs.existsSync(hygienePath)) {
      const hygiene = JSON.parse(fs.readFileSync(hygienePath, "utf8"));
      // Update structured file counts from byScope stats
      for (const [scope, count] of Object.entries(hygiene.stats?.byScope || {})) {
        METRICS.structured_files_total[`scope:${scope}`] = count;
      }
      // Update promotion queue sizes from dream state
      const dreamStatePath = path.join(VAULT_ROOT, "00-System", "ai-memory", "state", "auto-dream-state.json");
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
// Search worker helpers
// ---------------------------------------------------------------------------

function isSearchWorkerRunning() {
  return Boolean(searchWorker && !searchWorker.killed && searchWorker.exitCode === null);
}

function getSearchWorkerSnapshot() {
  return {
    enabled: true,
    running: isSearchWorkerRunning(),
    pid: searchWorker?.pid || null,
    startedAt: searchWorkerStartedAt || null,
    pendingRequests: searchWorkerPending.size,
    restartCount: searchWorkerRestartCount,
    lastError: searchWorkerLastError || "",
    mode: "persistent-jsonl-with-oneshot-fallback",
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function runWindowsPowerShellProbe(scriptLines = []) {
  if (!IS_WINDOWS || !Array.isArray(scriptLines) || scriptLines.length === 0) {
    return { ok: false, stdout: "", stderr: "", status: null };
  }

  try {
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", scriptLines.join("\n")], {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: !probe.error && probe.status === 0,
      stdout: String(probe.stdout || "").trim(),
      stderr: String(probe.stderr || "").trim(),
      status: probe.status,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: String(error || ""),
      status: null,
    };
  }
}

function isHiddenWindowsScriptAlive(scriptPath, processFilter, commandMatchLines = []) {
  if (!IS_WINDOWS || !scriptPath || !fs.existsSync(scriptPath)) {
    return false;
  }

  const target = scriptPath.replace(/'/g, "''").toLowerCase();
  const probe = runWindowsPowerShellProbe([
    "$selfPid = $PID",
    `$target = '${target}'`,
    `$proc = Get-CimInstance Win32_Process -Filter "${processFilter}" -ErrorAction SilentlyContinue |`,
    "  Where-Object {",
    "    $cmd = [string]$_.CommandLine;",
    "    $_.ProcessId -ne $selfPid -and",
    "    -not [string]::IsNullOrWhiteSpace($cmd) -and",
    ...commandMatchLines,
    "  } | Select-Object -First 1",
    "if ($proc) { [Console]::Out.Write('1') }",
  ]);
  return probe.ok && probe.stdout === "1";
}

function isWatchdogSupervisorAlive() {
  if (!IS_WINDOWS) {
    return false;
  }

  if (Date.now() - watchdogSupervisorCache.checkedAt < 3000) {
    return watchdogSupervisorCache.alive;
  }

  const vbsAlive = isHiddenWindowsScriptAlive(
    WATCHDOG_SUPERVISOR_VBS_PATH,
    "Name='wscript.exe'",
    ["$cmd.ToLowerInvariant().Contains($target)"],
  );
  const scriptAlive = isHiddenWindowsScriptAlive(
    WATCHDOG_SUPERVISOR_SCRIPT_PATH,
    "Name='powershell.exe' or Name='pwsh.exe'",
    ["$cmd.ToLowerInvariant().Contains('-file') -and", "$cmd.ToLowerInvariant().Contains($target)"],
  );
  const alive = vbsAlive || scriptAlive;

  watchdogSupervisorCache = {
    checkedAt: Date.now(),
    alive,
  };
  return alive;
}

const VAULT_ROOT = resolveVaultRoot();
const CANONICAL_AI_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_ROOT = path.join(CANONICAL_AI_MEMORY_ROOT, "structured");
const GENERATED_ROOT = path.join(CANONICAL_AI_MEMORY_ROOT, "generated");
const EMBEDDINGS_INDEX_PATH = path.join(VAULT_ROOT, "00-System", "ai-memory", "embeddings", "index.jsonl");
const HANDOFF_PACK_JSON_PATH = path.join(VAULT_ROOT, "00-System", "ai-memory", "generated", "HANDOFF.json");
const MEMORY_LAYERS_JSON_PATH = path.join(VAULT_ROOT, "00-System", "ai-memory", "generated", "MEMORY-LAYERS.json");
const AUTO_DREAM_JSON_PATH = path.join(VAULT_ROOT, "00-System", "ai-memory", "generated", "AUTO-DREAM.json");
const CLAUDE_MEM_BASE = (firstNonEmptyEnv("CLAUDE_MEM_BASE") || "http://127.0.0.1:37778").replace(/\/+$/, "");

const server = new Server(
  {
    name: "omni-memory-mesh",
    version: "3.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Uncaught exception handlers — crash loudly with useful log
process.on('uncaughtException', (err) => {
  console.error('[omni-memory] uncaughtException:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[omni-memory] unhandledRejection:', reason);
});
process.on("exit", () => {
  try {
    if (searchWorker && !searchWorker.killed) {
      searchWorker.kill();
    }
  } catch (_error) {
    // Best-effort cleanup only.
  }
});

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
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
      pending.reject(new Error(String(payload.error || "search-worker-error")));
      continue;
    }

    pending.resolve(payload);

    // Update metrics from search worker health snapshot embedded in response
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
      // Window has passed — allow one more attempt.
      resetSearchWorkerHealth();
      return false;
    }
    return true; // circuit still open
  }
  return false;
}

function handleSearchWorkerExit(code, signal) {
  const reason = `search-worker-exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
  const now = Date.now();

  if (checkSearchWorkerCircuit()) {
    searchWorkerCircuitOpen = true;
    console.error(
      `[omni-memory] FATAL: Search worker circuit breaker open after ${searchWorkerRestartCount} failures, manual restart required`
    );
    resetSearchWorkerState(reason);
    return;
  }

  searchWorkerRestartCount += 1;
  METRICS.search_worker_restarts_total = searchWorkerRestartCount;
  if (searchWorkerRestartCount === 1) {
    searchWorkerFirstFailureAt = now;
  }

  const backoffMs = Math.min(1000 * Math.pow(2, searchWorkerRestartCount - 1), 30_000);
  resetSearchWorkerState(reason);

  setTimeout(async () => {
    try {
      await ensureSearchWorker();
    } catch (error) {
      console.error(`[omni-memory] Search worker scheduled restart failed: ${error.message}`);
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
      resolve({
        ok: true,
        previousPid,
        ...payload,
      });
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
        // Best-effort hard stop only.
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

async function ensureSearchWorker() {
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
        AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
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
          console.error(`[search-worker] ${text}`);
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

async function runSemanticSearchOnce({
  query,
  mode = "hybrid",
  route = "auto",
  limit = 8,
  tool = "",
  project = "",
  scope = "",
  sourceKind = "",
  workspace = "",
  taskState = "",
  preferSummaries = false,
}) {
  const normalizedRoute = SEARCH_ROUTE_VALUES.has(String(route || "").trim().toLowerCase())
    ? String(route || "").trim().toLowerCase()
    : "auto";
  const args = [SEARCH_SCRIPT, "--mode", mode, "--top-k", String(limit), "--json", query];
  if (normalizedRoute) {
    args.push("--route", normalizedRoute);
  }
  if (tool) {
    args.push("--tool", tool);
  }
  if (project) {
    args.push("--project", project);
  }
  if (scope) {
    args.push("--scope", scope);
  }
  if (sourceKind) {
    args.push("--source-kind", sourceKind);
  }
  if (workspace) {
    args.push("--workspace", workspace);
  }
  if (taskState) {
    args.push("--task-state", taskState);
  }
  if (preferSummaries) {
    args.push("--prefer-summaries");
  }

  const result = await spawnProcess(PYTHON.command, withPythonArgs(PYTHON, args), {
    env: {
      ...PYTHON_SPAWN_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `semantic-search-exit-${result.code}`);
  }
  return JSON.parse(result.stdout);
}

function spawnProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function getClaudeMemHealth() {
  try {
    const response = await fetch(`${CLAUDE_MEM_BASE}/api/health`);
    const payload = await response.json();
    const normalizedStatus = String(payload?.status || "").trim().toLowerCase();
    const ok =
      typeof payload?.ok === "boolean"
        ? payload.ok
        : normalizedStatus === "ok";
    return {
      ...payload,
      ok,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function readWatchdogState() {
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
    return {
      ...payload,
      pidAlive,
      supervisorAlive,
      reportedRunning,
      recovering,
      running,
      stale,
      stateAgeSeconds,
      status,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, error: String(error), path: filePath };
  }
}

function readEmbeddingsSummary() {
  if (!fs.existsSync(EMBEDDINGS_INDEX_PATH)) {
    return {
      exists: false,
      path: EMBEDDINGS_INDEX_PATH,
      count: 0,
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
      const dimension = Number(record.dim) || (Array.isArray(record.embedding) ? record.embedding.length : 0);
      if (dimension > 0) {
        dimensions[String(dimension)] = (dimensions[String(dimension)] || 0) + 1;
      }
      if (record.providerHost) {
        providerHosts[record.providerHost] = (providerHosts[record.providerHost] || 0) + 1;
      }
      if (record.configHash) {
        configHashes[record.configHash] = (configHashes[record.configHash] || 0) + 1;
      }
    } catch (err) {
      // Ignore malformed lines and keep reporting readable data.
      console.error(`[omni-memory-server] JSON parse error in embeddings index (skipping line): ${err.message}`);
    }
  }

  const stat = fs.statSync(EMBEDDINGS_INDEX_PATH);
  return {
    exists: true,
    path: EMBEDDINGS_INDEX_PATH,
    count,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    tools,
    backends,
    models,
    dimensions,
    providerHosts,
    configHashes,
  };
}

function readEmbeddingRuntimeSummary() {
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

function readMemoryIntegritySummary() {
  return buildMemoryIntegrityReport({
    structuredRoot: STRUCTURED_ROOT,
    generatedRoot: GENERATED_ROOT,
    detailLimit: 8,
  });
}

function readMemoryHygieneReport() {
  const hygienePath = path.join(GENERATED_ROOT, "memory_hygiene_report.json");
  if (!fs.existsSync(hygienePath)) {
    return { ok: false, reason: "report-not-found" };
  }
  try {
    const content = fs.readFileSync(hygienePath, "utf8");
    const parsed = JSON.parse(content);
    return {
      ok: true,
      generatedAt: parsed.generatedAt || "",
      reportVersion: parsed.reportVersion || 1,
      structuredSignature: parsed.structuredSignature || "",
      stats: parsed.stats || {},
      health: parsed.health || {},
      recommendations: parsed.recommendations || [],
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

function buildEmbeddingIndexState(runtimeSummary, embeddingsSummary) {
  const adapter = String(runtimeSummary?.adapter || runtimeSummary?.backend || "hash").trim() || "hash";
  const modelName = adapter === "hash" ? HASH_MODEL : String(runtimeSummary?.model || "").trim();
  const activeConfigHash = buildEmbeddingConfigHash({
    backend: adapter,
    modelName: modelName || HASH_MODEL,
    baseUrl: String(runtimeSummary?.baseUrl || ""),
  });
  const indexedConfigHashes =
    embeddingsSummary && typeof embeddingsSummary.configHashes === "object" && embeddingsSummary.configHashes
      ? embeddingsSummary.configHashes
      : {};
  const uniqueConfigHashes = Object.keys(indexedConfigHashes);

  if (!embeddingsSummary?.exists || !embeddingsSummary?.count) {
    return {
      status: "missing",
      rebuildRequired: false,
      reason: "missing-embeddings-index",
      activeConfigHash,
      indexedConfigHash: "",
      indexedConfigHashes,
    };
  }

  if (uniqueConfigHashes.length === 0) {
    return {
      status: "legacy",
      rebuildRequired: false,
      reason: "index-missing-config-hash",
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

function annotateEmbeddingRuntimeCatalog(catalog, embeddingsSummary) {
  if (!catalog || typeof catalog !== "object") {
    return catalog;
  }

  const annotated = JSON.parse(JSON.stringify(catalog));
  const indexedConfigHashes =
    embeddingsSummary && typeof embeddingsSummary.configHashes === "object" && embeddingsSummary.configHashes
      ? embeddingsSummary.configHashes
      : {};

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
    annotated.providers = annotated.providers.map((entry) => annotateEntry(entry));
  }
  if (Array.isArray(annotated.profiles)) {
    annotated.profiles = annotated.profiles.map((entry) => annotateEntry(entry));
  }

  return annotated;
}

function readEmbeddingRuntimeCatalog() {
  return buildEmbeddingRuntimeCatalog({
    rootPath: AI_MEMORY_ROOT,
    getEnvValue: firstNonEmptyEnv,
    defaults: EMBEDDING_RUNTIME_DEFAULTS,
  });
}

async function runSemanticSearch({
  query,
  mode = "hybrid",
  route = "auto",
  limit = 8,
  tool = "",
  project = "",
  scope = "",
  sourceKind = "",
  workspace = "",
  taskState = "",
  preferSummaries = false,
}) {
  const normalizedRoute = SEARCH_ROUTE_VALUES.has(String(route || "").trim().toLowerCase())
    ? String(route || "").trim().toLowerCase()
    : "auto";
  const searchStartMs = Date.now();
  try {
    return await requestSearchWorker(
      {
        action: "search",
        query,
        mode,
        route: normalizedRoute,
        limit,
        tool,
        project,
        scope,
        sourceKind,
        workspace,
        taskState,
        preferSummaries,
      },
      120000
    );
  } catch (error) {
    searchWorkerLastError = String(error?.message || error);
    try {
      return runSemanticSearchOnce({
        query,
        mode,
        route: normalizedRoute,
        limit,
        tool,
        project,
        scope,
        sourceKind,
        workspace,
        taskState,
        preferSummaries,
      });
    } catch (_fallbackError) {
      // Fallback also failed — record as error and re-throw so caller sees failure.
      if (!METRICS.searches_total[normalizedRoute]) METRICS.searches_total[normalizedRoute] = {};
      METRICS.searches_total[normalizedRoute].error = (METRICS.searches_total[normalizedRoute].error || 0) + 1;
      throw error;
    }
  } finally {
    const latency = (Date.now() - searchStartMs) / 1000;
    METRICS.search_latency_seconds.push(latency);
    if (METRICS.search_latency_seconds.length > MAX_LATENCY_BUFFER) {
      METRICS.search_latency_seconds.shift();
    }
    if (!METRICS.searches_total[normalizedRoute]) METRICS.searches_total[normalizedRoute] = {};
    // ok is 0 if set, otherwise increment (only first path succeeds lands here without being set)
    if (METRICS.searches_total[normalizedRoute].ok === undefined) {
      METRICS.searches_total[normalizedRoute].ok = (METRICS.searches_total[normalizedRoute].ok || 0) + 1;
    }
  }
}

async function requestSearchWorker(payload, timeoutMs = 120000) {
  if (checkSearchWorkerCircuit()) {
    throw Object.assign(new Error("Search worker circuit breaker open, manual restart required"), {
      code: 503,
    });
  }

  if (searchWorkerPending.size >= SEARCH_BACKPRESSURE_LIMIT) {
    searchWorkerBackpressureRejected += 1;
    METRICS.search_worker_backpressure_rejected = searchWorkerBackpressureRejected;
    throw Object.assign(new Error("Search worker overloaded, try again later"), { code: 503 });
  }

  const child = await ensureSearchWorker();
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

// Alias: readOptionalJson already handles missing files gracefully (returns null).
// Used throughout as loadJsonFile for the get_memory_overview tool.
const loadJsonFile = readOptionalJson;

async function loadTaskRecords(workspaceRoot) {
  const structuredDir = path.join(workspaceRoot, "00-System", "ai-memory", "structured");
  const taskFile = path.join(structuredDir, "task-memory.jsonl");
  if (!fs.existsSync(taskFile)) {
    return [];
  }
  const lines = fs.readFileSync(taskFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return records;
}

function detectCurrentProject(workspaceRoot) {
  // Try to detect project name from git remote or directory name.
  const gitConfig = path.join(workspaceRoot, ".git", "config");
  if (fs.existsSync(gitConfig)) {
    try {
      const content = fs.readFileSync(gitConfig, "utf8");
      const remoteMatch = content.match(/url\s*=\s*.*[\/:]([^\/]+\/[^\/]+?)(?:\.git)?$/m);
      if (remoteMatch) {
        return remoteMatch[1];
      }
    } catch {
      // Fall through to directory-name detection.
    }
  }
  return path.basename(workspaceRoot);
}

async function getSearchWorkerHealth() {
  try {
    return await requestSearchWorker({ action: "health" }, 10000);
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
    };
  }
}

async function clearSearchWorkerCache({ includeDataCaches = false } = {}) {
  return await requestSearchWorker(
    {
      action: "clear_cache",
      includeDataCaches,
    },
    30000
  );
}

async function rebuildEmbeddings({ force = false }) {
  if (!fs.existsSync(EMBEDDINGS_SCRIPT)) {
    throw new Error(`embeddings-script-missing: ${EMBEDDINGS_SCRIPT}`);
  }

  const args = [EMBEDDINGS_SCRIPT];
  if (force) {
    args.push("--force");
  }

  const result = await spawnProcess(process.execPath, args, {
    env: {
      ...RUNTIME_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `embeddings-exit-${result.code}`);
  }

  return {
    ok: true,
    command: `${process.execPath} ${args.join(" ")}`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: readEmbeddingsSummary(),
  };
}

async function refreshDerivedArtifacts() {
  if (!fs.existsSync(MEMORY_BUS_SCRIPT)) {
    throw new Error(`memory-bus-script-missing: ${MEMORY_BUS_SCRIPT}`);
  }

  const args = IS_WINDOWS
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MEMORY_BUS_SCRIPT, "-Action", "RefreshDerivedArtifacts", "-Quiet"]
    : ["-NoProfile", "-File", MEMORY_BUS_SCRIPT, "-Action", "RefreshDerivedArtifacts", "-Quiet"];
  const result = await spawnProcess(POWERSHELL_COMMAND, args, {
    env: {
      ...RUNTIME_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `refresh-derived-artifacts-exit-${result.code}`);
  }

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    memoryLayers: readOptionalJson(MEMORY_LAYERS_JSON_PATH),
    handoffPack: readOptionalJson(HANDOFF_PACK_JSON_PATH),
    autoDream: readOptionalJson(AUTO_DREAM_JSON_PATH),
  };
}

async function rebuildMemoryLayers() {
  const result = await refreshDerivedArtifacts();

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: result.memoryLayers,
  };
}

async function buildHandoffPack() {
  const result = await refreshDerivedArtifacts();

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: result.handoffPack,
  };
}

async function runMemoryDream({ force = false }) {
  const result = await refreshDerivedArtifacts();

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: result.autoDream,
    force,
  };
}

async function runBlackboardPython(payload) {
  if (!fs.existsSync(BLACKBOARD_DB_PATH)) {
    return { ok: false, error: `blackboard-db-missing: ${BLACKBOARD_DB_PATH}` };
  }
  if (!PYTHON.available) {
    return { ok: false, error: `python-runtime-unavailable: ${PYTHON.error || "unknown-error"}` };
  }

  const script = `
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
db = sqlite3.connect(payload["db"])
db.row_factory = sqlite3.Row

try:
    if payload["op"] == "query":
        states = [str(item).strip().upper() for item in payload.get("states", []) if str(item).strip()]
        where = ""
        params = []
        if states:
            where = " WHERE state IN ({})".format(",".join("?" for _ in states))
            params.extend(states)
        params.append(max(1, int(payload.get("limit", 10))))
        sql = "SELECT id, repo, issue_number, issue_title, state, assigned_agent, processor, updated_at FROM tasks{} ORDER BY updated_at DESC LIMIT ?".format(where)
        rows = [dict(row) for row in db.execute(sql, params)]
        print(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False))
    elif payload["op"] == "insert":
        repo = str(payload["repo"]).strip()
        issue_number = int(payload["issue_number"])
        assigned_agent = str(payload.get("assigned_agent") or "intel").strip() or "intel"
        issue_title = str(payload.get("issue_title") or "{}#{}".format(repo, issue_number)).strip()
        cursor = db.execute(
            "INSERT INTO tasks (repo, issue_number, assigned_agent, issue_title, state) VALUES (?, ?, ?, ?, 'PENDING')",
            (repo, issue_number, assigned_agent, issue_title),
        )
        db.commit()
        print(json.dumps({"ok": True, "insertedId": cursor.lastrowid}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "unsupported-op"}, ensure_ascii=False))
finally:
    db.close()
`;

  const result = await spawnProcess(PYTHON.command, withPythonArgs(PYTHON, ["-c", script]), {
    env: PYTHON_SPAWN_ENV,
    input: JSON.stringify({
      ...payload,
      db: BLACKBOARD_DB_PATH,
    }),
  });

  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || `blackboard-exit-${result.code}`,
    };
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    return { ok: false, error: `blackboard-json-parse-failed: ${error.message}` };
  }
}

async function queryBlackboard({ limit = 10, states = [], state = "" }) {
  const normalizedStates = Array.isArray(states)
    ? states.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
    : [];
  if (normalizedStates.length === 0 && String(state || "").trim()) {
    normalizedStates.push(String(state).trim().toUpperCase());
  }

  return await runBlackboardPython({
    op: "query",
    limit: Math.max(1, Number(limit) || 10),
    states: normalizedStates,
  });
}

async function insertBlackboardTask({ repo, issue_number, assigned_agent = "intel", issue_title = "" }) {
  return await runBlackboardPython({
    op: "insert",
    repo,
    issue_number: Number(issue_number),
    assigned_agent,
    issue_title,
  });
}

async function queryClaudeMem({ query, limit = 5 }) {
  const url = `${CLAUDE_MEM_BASE}/api/search?query=${encodeURIComponent(query)}&limit=${Math.max(
    1,
    Number(limit) || 5
  )}`;
  const response = await fetch(url);
  return await response.json();
}

async function insertClaudeMem({ content, metadata = {} }) {
  const response = await fetch(`${CLAUDE_MEM_BASE}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, metadata }),
  });
  return await response.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_status",
      description:
        "Inspect the shared memory stack health: watchdog state, contract/integrity status, embeddings index summary, and claude-mem health.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_memory_overview",
      description:
        "Get a project-level memory overview for the current workspace. Returns project context, active tasks, recent memory activity, and memory system health. Use this at the start of a session to understand what the shared memory system already knows.",
      inputSchema: {
        type: "object",
        properties: {
          workspace_root: {
            type: "string",
            description:
              "Optional workspace path. If omitted, uses AI_MEMORY_OBSIDIAN_VAULT or the canonical vault root.",
          },
          include_stats: {
            type: "boolean",
            default: true,
            description:
              "Include memory statistics (record counts, freshness distribution).",
          },
        },
      },
    },
    {
      name: "search_shared_memory",
      description:
        "Search the canonical shared Obsidian memory bus across Codex, Claude Code, OpenCode, Copilot, Cursor, Trae, and OpenClaw. Defaults to hybrid retrieval and falls back to BM25 when dense embeddings are unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          mode: {
            type: "string",
            enum: ["bm25", "dense", "hybrid", "auto"],
            default: "hybrid",
            description: "Retrieval mode. hybrid is recommended.",
          },
          strategy: {
            type: "string",
            enum: ["bm25", "dense", "hybrid", "auto"],
            description: "Alias for mode.",
          },
          route: {
            type: "string",
            enum: ["auto", "mixed", "durable", "task", "recent", "reference"],
            default: "auto",
            description: "Optional query routing profile. auto infers the best layer mix from the query intent.",
          },
          limit: { type: "number", default: 8, description: "Maximum number of results." },
          tool: { type: "string", description: "Optional exact tool filter." },
          project: { type: "string", description: "Optional project/workspace substring filter." },
          scope: { type: "string", description: "Optional scope filter such as user, feedback, project, task, run, or summary." },
          sourceKind: { type: "string", description: "Optional source kind filter such as session, writeback, cron, run, or blackboard." },
          workspace: { type: "string", description: "Optional workspace filter." },
          taskState: { type: "string", description: "Optional task state filter." },
          preferSummaries: { type: "boolean", default: false, description: "Boost session/summary records slightly in ranking." },
        },
        required: ["query"],
      },
    },
    {
      name: "get_memory_records",
      description:
        "Fetch full structured records by ID from the canonical shared Obsidian memory bus. Returns all available fields including content, facts, concepts, files_read, files_modified, scope, memory_level, freshness, and confidence.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of record IDs to fetch.",
          },
        },
        required: ["ids"],
      },
    },
    {
      name: "refine_memory_selection",
      description:
        "Given a query and a list of memory record IDs, use an LLM to select the most relevant subset. Use this after get_memory_records returns too many results and you need the top-N most relevant to your current task.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The current task or question context" },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of memory record IDs to refine from (from get_memory_records)",
            maxItems: 50,
          },
          max_results: {
            type: "number",
            default: 5,
            description: "Maximum number of records to return (default 5)",
          },
        },
        required: ["query", "ids"],
      },
    },
    {
      name: "get_memory_timeline",
      description:
        "Given an anchor record ID, return chronologically interleaved nearby records. Useful for navigating backward and forward from a known record.",
      inputSchema: {
        type: "object",
        properties: {
          anchor_id: { type: "string", description: "The anchor record ID." },
          depth_before: { type: "number", default: 3, description: "Number of records to return before the anchor." },
          depth_after: { type: "number", default: 3, description: "Number of records to return after the anchor." },
        },
        required: ["anchor_id"],
      },
    },
    {
      name: "clear_shared_memory_search_cache",
      description:
        "Clear the persistent shared retrieval worker's in-memory search caches. Optionally also clear loaded entry/index data so the next query fully reloads state from disk.",
      inputSchema: {
        type: "object",
        properties: {
          includeDataCaches: {
            type: "boolean",
            default: false,
            description: "When true, also drop the loaded entries and embeddings index caches in addition to query/BM25/result caches.",
          },
        },
      },
    },
    {
      name: "list_embedding_runtimes",
      description:
        "List the configured embedding defaults, providers, and profiles, along with the currently resolved active runtime and whether the dense index is aligned or needs a rebuild.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "set_embedding_runtime",
      description:
        "Activate an embedding profile or provider in the runtime config. Returns the updated runtime selection and whether the dense embeddings index now needs a rebuild.",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string", description: "Configured embedding profile name to activate." },
          provider: { type: "string", description: "Configured provider name to activate directly." },
          clearProfile: { type: "boolean", default: false, description: "Clear the persisted activeProfile selection." },
          clearProvider: { type: "boolean", default: false, description: "Clear the persisted activeProvider selection." },
        },
      },
    },
    {
      name: "rebuild_memory_layers",
      description:
        "Rebuild derived shared memory layers such as shared inbox records, session-layer records, and shared event records.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "build_handoff_pack",
      description:
        "Build a bounded handoff pack with current goal, done, next, blocked, files, open threads, and tool invariants.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "run_memory_dream",
      description:
        "Run one memory dream consolidation pass over durable, session, and task layers to refresh AUTO-DREAM summaries.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: false, description: "Force a dream pass even when gates would normally skip." },
        },
      },
    },
    {
      name: "rebuild_memory_embeddings",
      description: "Rebuild the dense embeddings index from shared Obsidian structured memory.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: false, description: "Re-embed even unchanged records." },
        },
      },
    },
    {
      name: "rebuild_shared_embeddings",
      description: "Alias for rebuild_memory_embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "query_claude_mem",
      description:
        "Query the local claude-mem semantic memory API directly. Use search_shared_memory for the canonical cross-tool shared layer.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic query." },
          limit: { type: "number", default: 5, description: "Maximum number of results." },
        },
        required: ["query"],
      },
    },
    {
      name: "insert_claude_mem",
      description: "Insert a new item into the local claude-mem store.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content to insert." },
          metadata: { type: "object", description: "Optional metadata." },
        },
        required: ["content"],
      },
    },
    {
      name: "get_blackboard_tasks",
      description: "Read recent OpenClaw blackboard tasks from the shared AI Shrimp SQLite blackboard.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 10, description: "Maximum rows to return." },
          state: { type: "string", description: "Optional single state filter." },
          states: {
            type: "array",
            items: { type: "string" },
            description: "Optional task states to filter, e.g. ['PENDING', 'ACTIVE']",
          },
        },
      },
    },
    {
      name: "write_blackboard_task",
      description: "Insert a new task into the OpenClaw blackboard.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository name, e.g. browser-use/browser-use." },
          issue_number: { type: "number", description: "Issue number." },
          assigned_agent: {
            type: "string",
            default: "intel",
            description: "OpenClaw agent lane, usually intel or developer.",
          },
          issue_title: { type: "string", description: "Optional issue title." },
        },
        required: ["repo", "issue_number"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments || {};

  // Track MCP tool request count
  METRICS.mcp_requests_total[name] = (METRICS.mcp_requests_total[name] || 0) + 1;

  try {
    if (name === "memory_status") {
      const embeddingRuntime = readEmbeddingRuntimeSummary();
      const embeddings = readEmbeddingsSummary();
      const embeddingIndexState = buildEmbeddingIndexState(embeddingRuntime, embeddings);
      const memoryIntegrity = readMemoryIntegritySummary();
      const workerHealth = await getSearchWorkerHealth();
      const hygiene = readMemoryHygieneReport();
      return jsonResult({
        ok: true,
        generatedAt: new Date().toISOString(),
        pythonRuntime: {
          command: PYTHON.command,
          argsPrefix: PYTHON.argsPrefix,
          source: PYTHON.source,
          available: PYTHON.available,
          version: PYTHON.version,
          error: PYTHON.error,
        },
        searchWorker: {
          ...getSearchWorkerSnapshot(),
          health: workerHealth,
        },
        searchWorkerCircuitBreaker: getSearchWorkerSnapshot().circuitBreaker,
        watchdog: readWatchdogState(),
        memoryIntegrity,
        embeddingRuntime,
        embeddingIndexState,
        embeddings,
        handoffPack: readOptionalJson(HANDOFF_PACK_JSON_PATH),
        memoryLayers: readOptionalJson(MEMORY_LAYERS_JSON_PATH),
        autoDream: readOptionalJson(AUTO_DREAM_JSON_PATH),
        hygiene,
        claudeMem: await getClaudeMemHealth(),
        metrics: {
          searches_total: METRICS.searches_total,
          search_latency_buffer: {
            count: METRICS.search_latency_seconds.length,
            avg_seconds: METRICS.search_latency_seconds.length > 0
              ? METRICS.search_latency_seconds.reduce((a, b) => a + b, 0) / METRICS.search_latency_seconds.length
              : null,
          },
          embeddings_index: {
            age_seconds: METRICS.embeddings_index_age_seconds,
            size: METRICS.embeddings_index_size,
          },
          structured_files_total: METRICS.structured_files_total,
          promotion_queue_size: METRICS.promotion_queue_size,
          search_worker: {
            restarts_total: METRICS.search_worker_restarts_total,
            backpressure_rejected: METRICS.search_worker_backpressure_rejected,
          },
          mcp_requests_total: METRICS.mcp_requests_total,
        },
      });
    }

    if (name === "get_memory_overview") {
      const workspaceRoot = args.workspace_root || VAULT_ROOT;
      const generatedDir = path.join(workspaceRoot, "00-System", "ai-memory", "generated");

      const meta = loadJsonFile(path.join(generatedDir, "GLOBAL-CONTEXT.meta.json"));
      const dream = loadJsonFile(path.join(generatedDir, "AUTO-DREAM.json"));
      const hygiene = loadJsonFile(path.join(generatedDir, "memory_hygiene_report.json"));
      const handoff = loadJsonFile(path.join(generatedDir, "HANDOFF.json"));

      const taskRecords = await loadTaskRecords(workspaceRoot);
      const openTasks = taskRecords.filter(
        (r) => r.task_state && !["completed", "aborted", "failed"].includes(r.task_state)
      );

      // Build segment summaries from meta if present.
      const segmentSummaries = {};
      if (meta && meta.segments) {
        for (const seg of meta.segments) {
          if (seg && seg.name) {
            segmentSummaries[seg.name] = {
              totalCount: seg.totalCount || 0,
              displayedCount: Array.isArray(seg.displayedRecords) ? seg.displayedRecords.length : 0,
              truncated: Boolean(seg.truncated),
              truncatedCount: seg.truncatedCount || 0,
            };
          }
        }
      }

      return jsonResult({
        ok: true,
        workspace: {
          root: workspaceRoot,
          detected_project: detectCurrentProject(workspaceRoot),
        },
        memory_summary: {
          total_records: meta?.totalRecords || 0,
          estimated_tokens: meta?.estimatedTotalTokens || 0,
          segments: segmentSummaries,
        },
        recent_activity: {
          last_dream_run: dream?.generatedAt || null,
          dream_promotions: Array.isArray(dream?.promotionQueue) ? dream.promotionQueue.length : 0,
          dream_refreshes: Array.isArray(dream?.refreshQueue) ? dream.refreshQueue.length : 0,
        },
        active_tasks: {
          count: openTasks.length,
          samples: openTasks.slice(0, 5).map((t) => ({
            id: t.id || null,
            title: t.title || null,
            state: t.task_state || null,
            tool: t.tool || null,
          })),
        },
        handoff: {
          goal: handoff?.goal || null,
          done: Array.isArray(handoff?.done) ? handoff.done.slice(0, 3) : [],
          next: Array.isArray(handoff?.next) ? handoff.next.slice(0, 3) : [],
          blocked: Array.isArray(handoff?.blocked) ? handoff.blocked.slice(0, 3) : [],
        },
        health: hygiene?.health || { score: null, grade: "unknown" },
        recommendations: Array.isArray(hygiene?.recommendations)
          ? hygiene.recommendations.slice(0, 3)
          : [],
      });
    }

    if (name === "search_shared_memory") {
      const query = String(args.query || "").trim();
      if (!query) {
        return errorResult("query is required");
      }
      const payload = await runSemanticSearch({
        query,
        mode: String(args.mode || args.strategy || "hybrid"),
        route: String(args.route || "auto"),
        limit: Math.max(1, Number(args.limit) || 8),
        tool: String(args.tool || ""),
        project: String(args.project || ""),
        scope: String(args.scope || ""),
        sourceKind: String(args.sourceKind || ""),
        workspace: String(args.workspace || ""),
        taskState: String(args.taskState || ""),
        preferSummaries: Boolean(args.preferSummaries),
      });
      return jsonResult(payload);
    }

    if (name === "get_memory_records") {
      const ids = Array.isArray(args.ids) ? args.ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
      if (ids.length === 0) {
        return errorResult("ids is required and must be a non-empty array");
      }
      const payload = await requestSearchWorker({ action: "get_records", ids }, 60000);
      return jsonResult(payload);
    }

    if (name === "refine_memory_selection") {
      const ids = Array.isArray(args.ids)
        ? args.ids.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
      if (ids.length === 0) {
        return errorResult("ids is required and must be a non-empty array");
      }
      const maxResults = Math.max(1, Number(args.max_results) || 5);
      const query = String(args.query || "").trim();
      if (!query) {
        return errorResult("query is required");
      }

      // 1. Fetch full records via the search worker
      let records;
      try {
        const recordsPayload = await requestSearchWorker({ action: "get_records", ids }, 60000);
        records = recordsPayload?.records || [];
      } catch (err) {
        return errorResult(`get_memory_records failed: ${err.message}`);
      }

      if (records.length === 0) {
        return jsonResult({ ok: true, selected: [], reasoning: "No records found for the given IDs." });
      }

      // 2. Build the LLM prompt
      const recordsSection = records
        .map((rec) => {
          const facts = Array.isArray(rec.facts)
            ? rec.facts.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).join("; ")
            : "";
          const concepts = Array.isArray(rec.concepts)
            ? rec.concepts.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("; ")
            : "";
          return [
            `---`,
            `ID: ${rec.id}`,
            `Type: ${rec.type || ""} | Scope: ${rec.scope || ""} | Tool: ${rec.tool || ""}`,
            `Title: ${(rec.title || "").trim()}`,
            `Description: ${(rec.description || "").trim()}`,
            `Content: ${(rec.content || "").trim().slice(0, 2000)}`,
            facts ? `Facts: ${facts}` : "",
            concepts ? `Concepts: ${concepts}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");

      const refinementPrompt = `You are a memory relevance selector. Given a query and a list of memory records, select the top-N most relevant ones.

QUERY: ${query}

MEMORY RECORDS:
${recordsSection}
---

Return a JSON object with:
{
  "selected": [{"id": "...", "reason": "why this is relevant"}, ...],
  "reasoning": "brief explanation of the overall selection strategy"
}

Select at most ${maxResults} records. Prioritize records that directly address the query.
Only include records that are genuinely relevant. Return fewer than max_results if appropriate.`;

      // 3. Resolve LLM API configuration
      const apiKey =
        firstNonEmptyEnv("OPENAI_API_KEY") ||
        firstNonEmptyEnv("ANTHROPIC_API_KEY") ||
        firstNonEmptyEnv("AI_MEMORY_EMBED_API_KEY") ||
        "";

      if (!apiKey) {
        // Fallback: return top max_results by original order
        const fallback = ids.slice(0, maxResults);
        return jsonResult({
          ok: true,
          fallback: true,
          selected: fallback.map((id) => ({ id, reason: "LLM unavailable, returning by original order" })),
          reasoning: "No LLM API key configured (checked OPENAI_API_KEY, ANTHROPIC_API_KEY, AI_MEMORY_EMBED_API_KEY). Returned top N by original order.",
        });
      }

      const baseUrl = (firstNonEmptyEnv("AI_MEMORY_EMBED_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
      const model = firstNonEmptyEnv("AI_MEMORY_REFINE_MODEL") || "gpt-4o-mini";
      const isAnthropic = Boolean(firstNonEmptyEnv("ANTHROPIC_API_KEY")) && !firstNonEmptyEnv("OPENAI_API_KEY");

      // 4. Call the LLM
      let llmResponse;
      try {
        const body = isAnthropic
          ? {
              model,
              max_tokens: 1024,
              messages: [{ role: "user", content: refinementPrompt }],
            }
          : {
              model,
              max_tokens: 1024,
              temperature: 0.2,
              messages: [{ role: "user", content: refinementPrompt }],
            };

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(isAnthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-05-31" } : { Authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`LLM API error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        llmResponse = isAnthropic
          ? data.content?.[0]?.text || ""
          : data.choices?.[0]?.message?.content || "";
      } catch (err) {
        // Fallback on LLM failure
        const fallbackIds = ids.slice(0, maxResults);
        return jsonResult({
          ok: true,
          fallback: true,
          selected: fallbackIds.map((id) => ({ id, reason: `LLM call failed: ${err.message}` })),
          reasoning: `LLM call failed (${err.message}). Returned top N by original order.`,
        });
      }

      // 5. Parse the LLM response
      let parsed = null;
      try {
        // Strip markdown code fences if present
        const stripped = llmResponse
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        parsed = JSON.parse(stripped);
      } catch {
        // Try extracting JSON object from response
        const match = llmResponse.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {
            // fall through to error
          }
        }
      }

      if (
        !parsed ||
        !Array.isArray(parsed.selected) ||
        parsed.selected.length === 0 ||
        !parsed.selected[0]?.id
      ) {
        const fallbackIds = ids.slice(0, maxResults);
        return jsonResult({
          ok: true,
          fallback: true,
          selected: fallbackIds.map((id) => ({ id, reason: "LLM response was not parseable" })),
          reasoning: `LLM returned unparseable response. Returned top N by original order.\n\nRaw: ${llmResponse.slice(0, 300)}`,
        });
      }

      // 6. Validate selected IDs exist in the input set
      const validIdSet = new Set(ids);
      const validSelected = parsed.selected
        .filter((s) => s?.id && validIdSet.has(String(s.id).trim()))
        .slice(0, maxResults)
        .map((s) => ({ id: String(s.id).trim(), reason: String(s.reason || "").trim() }));

      return jsonResult({
        ok: true,
        selected: validSelected,
        reasoning: String(parsed.reasoning || "").trim(),
        llmModel: model,
      });
    }

    if (name === "get_memory_timeline") {
      const anchorId = String(args.anchor_id || "").trim();
      if (!anchorId) {
        return errorResult("anchor_id is required");
      }
      const payload = await requestSearchWorker(
        {
          action: "timeline",
          anchor_id: anchorId,
          depth_before: Math.max(0, Number(args.depth_before) || 3),
          depth_after: Math.max(0, Number(args.depth_after) || 3),
        },
        60000
      );
      return jsonResult(payload);
    }

    if (name === "clear_shared_memory_search_cache") {
      return jsonResult(
        await clearSearchWorkerCache({
          includeDataCaches: Boolean(args.includeDataCaches),
        })
      );
    }

    if (name === "list_embedding_runtimes") {
      const embeddings = readEmbeddingsSummary();
      const catalog = annotateEmbeddingRuntimeCatalog(readEmbeddingRuntimeCatalog(), embeddings);
      return jsonResult({
        ok: true,
        catalog,
        embeddingIndexState: buildEmbeddingIndexState(catalog.runtime, embeddings),
      });
    }

    if (name === "set_embedding_runtime") {
      const previousRuntime = readEmbeddingRuntimeSummary();
      const workerWasRunning = isSearchWorkerRunning();
      const payload = updateEmbeddingRuntimeSelection({
        rootPath: AI_MEMORY_ROOT,
        getEnvValue: firstNonEmptyEnv,
        defaults: EMBEDDING_RUNTIME_DEFAULTS,
        profile: String(args.profile || ""),
        provider: String(args.provider || ""),
        clearProfile: Boolean(args.clearProfile),
        clearProvider: Boolean(args.clearProvider),
      });
      const embeddings = readEmbeddingsSummary();
      const catalog = annotateEmbeddingRuntimeCatalog(payload.catalog, embeddings);
      const runtimeSignatureBefore = buildEmbeddingRuntimeRestartSignature(previousRuntime);
      const runtimeSignatureAfter = buildEmbeddingRuntimeRestartSignature(catalog.runtime || payload.runtime || {});
      const runtimeChanged = runtimeSignatureBefore !== runtimeSignatureAfter;
      const workerSnapshot = getSearchWorkerSnapshot();
      const searchWorkerRestart =
        runtimeChanged && workerWasRunning
          ? await restartSearchWorker("embedding-runtime-changed")
          : {
              ok: true,
              requested: runtimeChanged,
              reason: runtimeChanged ? "embedding-runtime-updated-worker-idle" : "embedding-runtime-unchanged",
              workerWasRunning,
              previousPid: workerSnapshot.pid,
              currentPid: workerSnapshot.pid,
              pidChanged: false,
              stop: {
                ok: true,
                stopped: false,
                previousPid: workerSnapshot.pid,
                reason: runtimeChanged ? "search-worker-idle-no-restart-needed" : "embedding-runtime-unchanged",
              },
              before: workerSnapshot,
              after: workerSnapshot,
              health: workerWasRunning ? await getSearchWorkerHealth() : null,
            };
      return jsonResult({
        ...payload,
        runtimeChanged,
        catalog,
        embeddingIndexState: buildEmbeddingIndexState(catalog.runtime, embeddings),
        searchWorkerRestart,
      });
    }

    if (name === "rebuild_memory_layers") {
      return jsonResult(await rebuildMemoryLayers());
    }

    if (name === "build_handoff_pack") {
      return jsonResult(await buildHandoffPack());
    }

    if (name === "run_memory_dream") {
      return jsonResult(await runMemoryDream({ force: Boolean(args.force) }));
    }

    if (name === "rebuild_memory_embeddings" || name === "rebuild_shared_embeddings") {
      const payload = await rebuildEmbeddings({ force: Boolean(args.force) });
      return jsonResult(payload);
    }

    if (name === "query_claude_mem") {
      const query = String(args.query || "").trim();
      if (!query) {
        return errorResult("query is required");
      }
      return jsonResult({
        ok: true,
        query,
        response: await queryClaudeMem({
          query,
          limit: Math.max(1, Number(args.limit) || 5),
        }),
      });
    }

    if (name === "insert_claude_mem") {
      const content = String(args.content || "").trim();
      if (!content) {
        return errorResult("content is required");
      }
      return jsonResult({
        ok: true,
        response: await insertClaudeMem({
          content,
          metadata: args.metadata || {},
        }),
      });
    }

    if (name === "get_blackboard_tasks") {
      return jsonResult(
        await queryBlackboard({
          limit: Math.max(1, Number(args.limit) || 10),
          state: String(args.state || ""),
          states: args.states || [],
        })
      );
    }

    if (name === "write_blackboard_task") {
      const repo = String(args.repo || "").trim();
      const issueNumber = Number(args.issue_number);
      if (!repo || !Number.isFinite(issueNumber)) {
        return errorResult("repo and issue_number are required");
      }
      return jsonResult(
        await insertBlackboardTask({
          repo,
          issue_number: issueNumber,
          assigned_agent: String(args.assigned_agent || "intel"),
          issue_title: String(args.issue_title || ""),
        })
      );
    }

    return errorResult(`tool-not-found: ${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// ---------------------------------------------------------------------------
// HTTP metrics server (Prometheus-compatible /metrics endpoint)
// ---------------------------------------------------------------------------
function startMetricsServer() {
  const port = Number(firstNonEmptyEnv("AI_MEMORY_METRICS_PORT") || "9090");
  const metricsServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(collectMetrics());
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  metricsServer.on("error", (err) => {
    console.error(`[omni-memory] metrics server error: ${err.message}`);
  });

  metricsServer.listen(port, () => {
    console.error(`[omni-memory] metrics server listening on :${port}`);
  });
}

// Start metrics refresh interval and HTTP server immediately.
setInterval(refreshMetricsFromFiles, 60_000);
refreshMetricsFromFiles();
startMetricsServer();
