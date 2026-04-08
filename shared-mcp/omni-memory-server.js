import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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
// ---------------------------------------------------------------------------
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

function refreshMetricsFromFiles() {
  try {
    const hygienePath = path.join(GENERATED_ROOT, "memory_hygiene_report.json");
    if (fs.existsSync(hygienePath)) {
      const hygiene = JSON.parse(fs.readFileSync(hygienePath, "utf8"));
      for (const [scope, count] of Object.entries(hygiene.stats?.byScope || {})) {
        METRICS.structured_files_total[`scope:${scope}`] = count;
      }
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

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

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

// Start metrics refresh interval and HTTP server immediately.
setInterval(refreshMetricsFromFiles, 60_000);
refreshMetricsFromFiles();
startMetricsServer();
