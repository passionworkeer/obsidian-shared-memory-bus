import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMemoryRetrieval } from "./memory-retrieval.js";
import { createMemoryGeneration } from "./memory-generation.js";
import { createMemoryBridge } from "./memory-bridge.js";
import { createMemoryStatus } from "./memory-status.js";
import { createMemoryEmbeddings } from "./memory-embeddings.js";
import { TOOLS } from "./memory-tools.js";

// --- ESM globals (must be defined before any code that uses them) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);


// memory_boot and memory_query — resolves via resolveProjectPath so it works
// whether AI_MEMORY_ROOT points to the project dir or to a separate data dir.
const { handlers: mcpMemoryHandlers } = require(
  resolveProjectPath("ops", "mcp-memory-tools-handler.js")
);

// --- Derived constants ---
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

/**
 * Resolve a module path that may live in the project directory (E:\desktop\obsidian-shared-memory-bus)
 * even when AI_MEMORY_ROOT points to a separate data dir (C:\Users\wang\.ai-memory).
 *
 * Checks:
 *   1. process.cwd() + relativePath  (project dir, where ops/ lives)
 *   2. path.resolve(__dirname, "..") + relativePath  (parent of shared-mcp/)
 *   3. AI_MEMORY_ROOT + relativePath  (canonical fallback)
 */
function resolveProjectPath(...parts) {
  const relPath = path.join(...parts);
  for (const base of [process.cwd(), path.resolve(__dirname, "..")]) {
    const candidate = path.join(base, relPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Last resort: use AI_MEMORY_ROOT even if it may not have the file
  return path.join(AI_MEMORY_ROOT, relPath);
}

function loadStoreRootHelper() {
  const helperPath = resolveRuntimePath("store-root.js", path.join("bus", "store-root.js"));
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

/**
 * Batch-read multiple Windows registry environment variables in a single
 * PowerShell call. Falls back to User scope, then Machine scope per variable.
 * Returns a map of name -> value for vars that have values.
 * One spawnSync call instead of N, drastically reducing startup time.
 */
function batchReadWindowsRegistryVars(names) {
  if (!IS_WINDOWS || names.length === 0) {
    return new Map();
  }

  // PowerShell: build a JSON object from the name/value pairs
  // Use plain strings + array join (avoids JS template-literal $/$-interpretation)
  const psLines = ["$result = @{}"];
  for (const name of names) {
    const e = name.replace(/'/g, "''");
    psLines.push(
      "try { $v = [Environment]::GetEnvironmentVariable('" + e + "', 'User'); " +
      "if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable('" + e + "', 'Machine') }; " +
      "if (-not [string]::IsNullOrWhiteSpace($v)) { $result['" + e + "'] = $v } } catch {}"
    );
  }
  psLines.push("$result | ConvertTo-Json -Compress");
  const psScript = psLines.join("\n");

  let raw = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (!result.error && result.status === 0) {
      raw = String(result.stdout || "").trim();
    }
  } catch (_e) {
    return new Map();
  }

  // Parse JSON result
  const results = new Map();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      for (const name of names) {
        if (parsed[name]) {
          results.set(name, String(parsed[name]).trim());
          WINDOWS_ENV_CACHE.set(name, String(parsed[name]).trim());
        }
      }
    } catch (_e) {
      // JSON parse failed, fall through to empty results
    }
  }
  return results;
}

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  // Batch-read all non-found names in one PowerShell call
  const notFound = names.filter((n) => !WINDOWS_ENV_CACHE.has(n));
  if (notFound.length > 0) {
    const cached = batchReadWindowsRegistryVars(notFound);
    for (const name of names) {
      const cachedVal = WINDOWS_ENV_CACHE.get(name);
      if (cachedVal) return cachedVal;
    }
  }
  for (const name of names) {
    const cachedVal = WINDOWS_ENV_CACHE.get(name);
    if (cachedVal) return cachedVal;
  }
  return "";
}

function buildMergedEnv(baseEnv = process.env, names = RUNTIME_ENV_NAMES) {
  const merged = { ...(baseEnv || {}) };
  // Fast path: check process.env first
  const missing = [];
  for (const name of names) {
    const current = merged[name];
    if (typeof current !== "string" || !current.trim()) {
      missing.push(name);
    }
  }
  // Batch-fetch all missing in one PowerShell call
  if (missing.length > 0) {
    batchReadWindowsRegistryVars(missing);
  }
  // Merge resolved values
  for (const name of names) {
    const current = merged[name];
    if (typeof current === "string" && current.trim()) {
      continue;
    }
    const cached = WINDOWS_ENV_CACHE.get(name);
    if (cached) {
      merged[name] = cached;
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
const { resolveStoreRoot } = loadStoreRootHelper();
const { resolvePythonRuntime, withPythonArgs } = loadPythonRuntimeHelper();
const { buildEmbeddingConfigHash } = loadEmbeddingProviderHelper();
const { buildMemoryIntegrityReport } = loadMemoryContractHelper();
const { buildEmbeddingRuntimeCatalog, resolveEmbeddingRuntime, updateEmbeddingRuntimeSelection } = loadRuntimeConfigHelper();
const POWERSHELL_COMMAND = resolvePowerShellCommand();
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
// Metrics collection helpers
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

function refreshEmbeddingMetricsFromSummary(summary = null) {
  const count = Number(summary?.count || 0);
  const ageSeconds = Number(summary?.ageSeconds);
  METRICS.embeddings_index_size = Number.isFinite(count) ? count : 0;
  METRICS.embeddings_index_age_seconds =
    Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0;
}

function refreshMetricsFromFiles() {
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
  watchdogSupervisorCache = { checkedAt: Date.now(), alive };
  return alive;
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
    return { ...payload, pidAlive, supervisorAlive, reportedRunning, recovering, running, stale, stateAgeSeconds, status };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}


function readEmbeddingsSummary() {
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
      console.error(`[omni-memory-server] JSON parse error in embeddings index (skipping line): ${err.message}`);
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
  return buildMemoryIntegrityReport({ structuredRoot: STRUCTURED_ROOT, generatedRoot: GENERATED_ROOT, detailLimit: 8 });
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

function buildEmbeddingIndexState(runtimeSummary, embeddingsSummary) {
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

function annotateEmbeddingRuntimeCatalog(catalog, embeddingsSummary) {
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

function readEmbeddingRuntimeCatalog() {
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
  const backoffMs = Math.min(1000 * Math.pow(2, searchWorkerRestartCount - 1), 30000);
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

async function requestSearchWorker(payload, timeoutMs = 120000) {
  if (checkSearchWorkerCircuit()) {
    throw Object.assign(new Error("Search worker circuit breaker open, manual restart required"), { code: 503 });
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

async function getSearchWorkerHealth() {
  try {
    return await requestSearchWorker({ action: "health" }, 10000);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function clearSearchWorkerCache({ includeDataCaches = false } = {}) {
  return await requestSearchWorker({ action: "clear_cache", includeDataCaches }, 30000);
}

// ---------------------------------------------------------------------------
// claude-mem bridge
// ---------------------------------------------------------------------------

const CLAUDE_MEM_BASE = (firstNonEmptyEnv("CLAUDE_MEM_BASE") || "http://127.0.0.1:37778").replace(/\/+$/, "");

async function getClaudeMemHealth() {
  try {
    const response = await fetch(`${CLAUDE_MEM_BASE}/api/health`);
    const payload = await response.json();
    const normalizedStatus = String(payload?.status || "").trim().toLowerCase();
    const ok = typeof payload?.ok === "boolean" ? payload.ok : normalizedStatus === "ok";
    return { ...payload, ok };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Path constants (computed after helpers are loaded)
// ---------------------------------------------------------------------------

const STORE_ROOT = resolveStoreRoot(); // e.g. "E:\\.ai-memory" (Windows) or "$HOME/.ai-memory" (macOS/Linux)
const MEMORY_STORE_ROOT = STORE_ROOT;
const STRUCTURED_ROOT = path.join(MEMORY_STORE_ROOT, "structured");
const GENERATED_ROOT = path.join(MEMORY_STORE_ROOT, "generated");
const EMBEDDINGS_INDEX_PATH = path.join(MEMORY_STORE_ROOT, "embeddings", "index.jsonl");
const VAULT_ROOT = firstNonEmptyEnv("AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT") || STORE_ROOT;
const HANDOFF_PACK_JSON_PATH = path.join(GENERATED_ROOT, "HANDOFF.json");
const MEMORY_LAYERS_JSON_PATH = path.join(GENERATED_ROOT, "MEMORY-LAYERS.json");
const AUTO_DREAM_JSON_PATH = path.join(GENERATED_ROOT, "AUTO-DREAM.json");

// ---------------------------------------------------------------------------
// Module initialization — build params and create all tool modules
// ---------------------------------------------------------------------------

const sharedParams = {
  METRICS,
  firstNonEmptyEnv,
  withPythonArgs,
  STORE_ROOT,
  VAULT_ROOT,
  MEMORY_STORE_ROOT,
  STRUCTURED_ROOT,
  GENERATED_ROOT,
  EMBEDDINGS_INDEX_PATH,
  HANDOFF_PACK_JSON_PATH,
  MEMORY_LAYERS_JSON_PATH,
  AUTO_DREAM_JSON_PATH,
  WATCHDOG_STATE_PATH,
  MEMORY_STORE_ROOT,
  BLACKBOARD_DB_PATH,
  CLAUDE_MEM_BASE,
  SEARCH_SCRIPT,
  EMBEDDINGS_SCRIPT,
  MEMORY_BUS_SCRIPT,
  PYTHON,
  PYTHON_SPAWN_ENV,
  RUNTIME_ENV,
  EMBEDDING_RUNTIME_DEFAULTS,
  HASH_MODEL,
  getSearchWorkerSnapshot,
  getSearchWorkerHealth,
  clearSearchWorkerCache,
  requestSearchWorker,
  isSearchWorkerRunning,
  restartSearchWorker,
  readEmbeddingRuntimeSummary,
  readEmbeddingsSummary,
  refreshEmbeddingMetricsFromSummary,
  buildEmbeddingIndexState,
  readMemoryIntegritySummary,
  readMemoryHygieneReport,
  readWatchdogState,
  getClaudeMemHealth,
  readEmbeddingRuntimeCatalog,
  annotateEmbeddingRuntimeCatalog,
  updateEmbeddingRuntimeSelection,
  buildEmbeddingRuntimeRestartSignature,
  IS_WINDOWS,
  POWERSHELL_COMMAND,
};

const retrieval = createMemoryRetrieval(sharedParams);
const generation = createMemoryGeneration(sharedParams);
const bridge = createMemoryBridge(sharedParams);
const status = createMemoryStatus(sharedParams);
const embeddings = createMemoryEmbeddings(sharedParams);

// ---------------------------------------------------------------------------
// Merge all handlers — tool definitions come from memory-tools.js
// ---------------------------------------------------------------------------

const ALL_HANDLERS = {};

for (const [name, handler] of Object.entries(status.handlers)) {
  ALL_HANDLERS[name] = handler;
}
for (const [name, handler] of Object.entries(retrieval.handlers)) {
  ALL_HANDLERS[name] = handler;
}
for (const [name, handler] of Object.entries(generation.handlers)) {
  ALL_HANDLERS[name] = handler;
}
for (const [name, handler] of Object.entries(bridge.handlers)) {
  ALL_HANDLERS[name] = handler;
}
for (const [name, handler] of Object.entries(embeddings.handlers)) {
  ALL_HANDLERS[name] = handler;
}
for (const [name, handler] of Object.entries(mcpMemoryHandlers)) {
  ALL_HANDLERS[name] = handler;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "omni-memory-mesh", version: "3.1.0" },
  { capabilities: { tools: {} } }
);

process.on("uncaughtException", (err) => {
  console.error("[omni-memory] uncaughtException:", err.message);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[omni-memory] unhandledRejection:", reason);
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

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments || {};

  METRICS.mcp_requests_total[name] = (METRICS.mcp_requests_total[name] || 0) + 1;

  const handler = ALL_HANDLERS[name];
  if (!handler) {
    return errorResult(`tool-not-found: ${name}`);
  }

  try {
    return await handler(args);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

// ---------------------------------------------------------------------------
// HTTP metrics server (Prometheus-compatible /metrics endpoint)
// ---------------------------------------------------------------------------

function startMetricsServer() {
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
        searchWorker: searchWorker ? { alive: !searchWorker.killed } : null,
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
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  metricsServer.on("error", (err) => { console.error(`[omni-memory] metrics server error: ${err.message}`); });
  metricsServer.listen(port, () => { console.error(`[omni-memory] metrics server listening on :${port}`); });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Start metrics refresh interval and HTTP server.
setInterval(refreshMetricsFromFiles, 60_000);
refreshMetricsFromFiles();
startMetricsServer();
