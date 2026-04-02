import fs from "node:fs";
import path from "node:path";
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
const HANDOFF_PACK_SCRIPT = resolveRuntimePath("build-handoff-pack.js", path.join("ops", "build-handoff-pack.js"));
const MEMORY_LAYERS_SCRIPT = resolveRuntimePath("build-memory-layers.js", path.join("ops", "build-memory-layers.js"));
const MEMORY_DREAM_SCRIPT = resolveRuntimePath("run-memory-dream.ps1", path.join("ops", "run-memory-dream.ps1"));
const WATCHDOG_STATE_PATH = path.join(AI_MEMORY_ROOT, "watchdog-state.json");
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
let searchWorker = null;
let searchWorkerStartupPromise = null;
let searchWorkerBuffer = "";
let searchWorkerRequestCounter = 0;
let searchWorkerStartedAt = "";
let searchWorkerLastError = "";
let searchWorkerRestartCount = 0;
const searchWorkerPending = new Map();

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
  }
}

function handleSearchWorkerExit(code, signal) {
  const reason = `search-worker-exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
  searchWorkerRestartCount += 1;
  resetSearchWorkerState(reason);
}

async function ensureSearchWorker() {
  if (searchWorker && !searchWorker.killed && searchWorker.exitCode === null) {
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
  limit = 8,
  tool = "",
  project = "",
  scope = "",
  sourceKind = "",
  workspace = "",
  taskState = "",
  preferSummaries = false,
}) {
  const args = [SEARCH_SCRIPT, "--mode", mode, "--top-k", String(limit), "--json", query];
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
      ? Date.now() - updatedAtMs > Math.max(60_000, (Number(payload?.pollSeconds || 15) || 15) * 8_000)
      : false;
    const running = reportedRunning && pidAlive && !staleByAge;
    return {
      ...payload,
      pidAlive,
      reportedRunning,
      running,
      stale: (reportedRunning && !pidAlive) || staleByAge,
      stateAgeSeconds,
      status: running ? "running" : pidAlive ? "stale" : "stopped",
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
  limit = 8,
  tool = "",
  project = "",
  scope = "",
  sourceKind = "",
  workspace = "",
  taskState = "",
  preferSummaries = false,
}) {
  try {
    return await requestSearchWorker(
      {
        action: "search",
        query,
        mode,
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
    return runSemanticSearchOnce({
      query,
      mode,
      limit,
      tool,
      project,
      scope,
      sourceKind,
      workspace,
      taskState,
      preferSummaries,
    });
  }
}

async function requestSearchWorker(payload, timeoutMs = 120000) {
  const child = await ensureSearchWorker();
  return await new Promise((resolve, reject) => {
    const requestId = `search-${Date.now()}-${++searchWorkerRequestCounter}`;
    const timeout = setTimeout(() => {
      searchWorkerPending.delete(requestId);
      reject(new Error("search-worker-timeout"));
    }, timeoutMs);

    searchWorkerPending.set(requestId, { resolve, reject, timeout });

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

async function rebuildMemoryLayers() {
  if (!fs.existsSync(MEMORY_LAYERS_SCRIPT)) {
    throw new Error(`memory-layers-script-missing: ${MEMORY_LAYERS_SCRIPT}`);
  }

  const result = await spawnProcess(process.execPath, [MEMORY_LAYERS_SCRIPT], {
    env: {
      ...RUNTIME_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `memory-layers-exit-${result.code}`);
  }

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: readOptionalJson(MEMORY_LAYERS_JSON_PATH),
  };
}

async function buildHandoffPack() {
  if (!fs.existsSync(HANDOFF_PACK_SCRIPT)) {
    throw new Error(`handoff-pack-script-missing: ${HANDOFF_PACK_SCRIPT}`);
  }

  const result = await spawnProcess(process.execPath, [HANDOFF_PACK_SCRIPT], {
    env: {
      ...RUNTIME_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `handoff-pack-exit-${result.code}`);
  }

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: readOptionalJson(HANDOFF_PACK_JSON_PATH),
  };
}

async function runMemoryDream({ force = false }) {
  if (!fs.existsSync(MEMORY_DREAM_SCRIPT)) {
    throw new Error(`memory-dream-script-missing: ${MEMORY_DREAM_SCRIPT}`);
  }

  const args = IS_WINDOWS
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MEMORY_DREAM_SCRIPT]
    : ["-NoProfile", "-File", MEMORY_DREAM_SCRIPT];
  if (force) {
    args.push("-Force");
  }

  const result = await spawnProcess(POWERSHELL_COMMAND, args, {
    env: {
      ...RUNTIME_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `memory-dream-exit-${result.code}`);
  }

  return {
    ok: true,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: readOptionalJson(AUTO_DREAM_JSON_PATH),
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

  try {
    if (name === "memory_status") {
      const embeddingRuntime = readEmbeddingRuntimeSummary();
      const embeddings = readEmbeddingsSummary();
      const embeddingIndexState = buildEmbeddingIndexState(embeddingRuntime, embeddings);
      const memoryIntegrity = readMemoryIntegritySummary();
      const workerHealth = await getSearchWorkerHealth();
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
          enabled: true,
          running: Boolean(searchWorker && !searchWorker.killed && searchWorker.exitCode === null),
          pid: searchWorker?.pid || null,
          startedAt: searchWorkerStartedAt || null,
          pendingRequests: searchWorkerPending.size,
          restartCount: searchWorkerRestartCount,
          lastError: searchWorkerLastError || "",
          mode: "persistent-jsonl-with-oneshot-fallback",
          health: workerHealth,
        },
        watchdog: readWatchdogState(),
        memoryIntegrity,
        embeddingRuntime,
        embeddingIndexState,
        embeddings,
        handoffPack: readOptionalJson(HANDOFF_PACK_JSON_PATH),
        memoryLayers: readOptionalJson(MEMORY_LAYERS_JSON_PATH),
        autoDream: readOptionalJson(AUTO_DREAM_JSON_PATH),
        claudeMem: await getClaudeMemHealth(),
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
      return jsonResult({
        ...payload,
        catalog,
        embeddingIndexState: buildEmbeddingIndexState(catalog.runtime, embeddings),
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
