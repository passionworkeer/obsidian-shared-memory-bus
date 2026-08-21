// omni-memory-server.js — MCP entrypoint for the obsidian-shared-memory-bus.
//
// This file is intentionally thin: it wires together the helpers split across
// sibling modules (omni-store, omni-platform-helpers, omni-handlers,
// omni-metrics), builds the sharedParams bundle, and starts the MCP stdio
// server + HTTP metrics endpoint.
//
// Re-exports at the bottom preserve the original module surface so any
// existing importer keeps working.

import process from "node:process";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  PROJECT_ROOT,
  AI_MEMORY_ROOT,
  IS_WINDOWS,
  resolveProjectPath,
  resolveStoreRoot,
} from "./omni-store.js";
import {
  firstNonEmptyEnv,
  buildMergedEnv,
  resolvePowerShellCommand,
  resolveRuntimePath,
} from "./omni-platform-helpers.js";
import {
  loadStoreRootHelper,
  loadPythonRuntimeHelper,
  loadRuntimeConfigHelper,
  loadEmbeddingProviderHelper,
  loadMemoryContractHelper,
  loadMcpMemoryHandler,
  buildHandlerRegistry,
  createMcpServer,
  registerMcpRequestHandlers,
} from "./omni-handlers.js";
import {
  METRICS,
  refreshEmbeddingMetricsFromSummary,
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
  requestSearchWorker,
  getSearchWorkerHealth,
  clearSearchWorkerCache,
  restartSearchWorker,
  ensureSearchWorker,
  killSearchWorkerOnExit,
  startMetricsServer,
  startMetricsRefreshInterval,
  log,
} from "./omni-metrics.js";

// ---------------------------------------------------------------------------
// Resolve runtime scripts + helper namespaces (ESM top-level await).
// ---------------------------------------------------------------------------
const SEARCH_SCRIPT = resolveRuntimePath(
  "semantic_search.py",
  path.join("retrieval", "semantic_search.py"),
  "semantic-search.py",
  path.join("retrieval", "semantic-search.py"),
);
const EMBEDDINGS_SCRIPT = resolveRuntimePath("generate-embeddings.js", path.join("bus", "generate-embeddings.js"));
const MEMORY_BUS_SCRIPT = resolveRuntimePath("memory-bus.ps1", path.join("bus", "memory-bus.ps1"));

// F2.1 (perf audit HIGH): load all 6 helper modules in parallel via
// Promise.all. The previous top-level-await chain serialized 6 dynamic
// imports + their transitive reads (some load config/runtime.json sync);
// parallelizing trims ~200-500ms off MCP server boot on Windows.
const [
  { resolveStoreRoot: _resolveStoreRootHelper },
  { resolvePythonRuntime, withPythonArgs },
  { buildEmbeddingConfigHash },
  { buildMemoryIntegrityReport },
  {
    buildEmbeddingRuntimeCatalog,
    resolveEmbeddingRuntime,
    updateEmbeddingRuntimeSelection,
  },
  mcpMemoryHandlers,
] = await Promise.all([
  loadStoreRootHelper(),
  loadPythonRuntimeHelper(),
  loadEmbeddingProviderHelper(),
  loadMemoryContractHelper(),
  loadRuntimeConfigHelper(),
  loadMcpMemoryHandler(resolveProjectPath),
]);

const POWERSHELL_COMMAND = resolvePowerShellCommand();
const WATCHDOG_STATE_PATH = path.join(AI_MEMORY_ROOT, "watchdog-state.json");
const RUNTIME_ENV = buildMergedEnv();
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
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
// Path constants (computed after helpers are loaded)
// ---------------------------------------------------------------------------
const STORE_ROOT = resolveStoreRoot();
const MEMORY_STORE_ROOT = STORE_ROOT;
const STRUCTURED_ROOT = path.join(MEMORY_STORE_ROOT, "structured");
const GENERATED_ROOT = path.join(MEMORY_STORE_ROOT, "generated");
const EMBEDDINGS_INDEX_PATH = path.join(MEMORY_STORE_ROOT, "embeddings", "index.jsonl");
const VAULT_ROOT = firstNonEmptyEnv("AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT") || STORE_ROOT;
const HANDOFF_PACK_JSON_PATH = path.join(GENERATED_ROOT, "HANDOFF.json");
const MEMORY_LAYERS_JSON_PATH = path.join(GENERATED_ROOT, "MEMORY-LAYERS.json");
const AUTO_DREAM_JSON_PATH = path.join(GENERATED_ROOT, "AUTO-DREAM.json");

// ---------------------------------------------------------------------------
// sharedParams bundle — passed to every createMemory* factory.
// ---------------------------------------------------------------------------
const searchWorkerDeps = {
  SEARCH_SCRIPT,
  PYTHON,
  withPythonArgs,
  PYTHON_SPAWN_ENV,
  STORE_ROOT,
};

const readEmbeddingRuntimeSummaryBound = () => readEmbeddingRuntimeSummary({ resolveEmbeddingRuntime, EMBEDDING_RUNTIME_DEFAULTS });
const readEmbeddingsSummaryBound = () => readEmbeddingsSummary({ EMBEDDINGS_INDEX_PATH });
const readMemoryIntegritySummaryBound = () =>
  readMemoryIntegritySummary({ buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT });
const readMemoryHygieneReportBound = () => readMemoryHygieneReport({ GENERATED_ROOT });
const readEmbeddingRuntimeCatalogBound = () =>
  readEmbeddingRuntimeCatalog({ buildEmbeddingRuntimeCatalog, EMBEDDING_RUNTIME_DEFAULTS });

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
  BLACKBOARD_DB_PATH,
  CLAUDE_MEM_BASE: (firstNonEmptyEnv("CLAUDE_MEM_BASE") || "http://127.0.0.1:37778").replace(/\/+$/, ""),
  SEARCH_SCRIPT,
  EMBEDDINGS_SCRIPT,
  MEMORY_BUS_SCRIPT,
  PYTHON,
  PYTHON_SPAWN_ENV,
  RUNTIME_ENV,
  EMBEDDING_RUNTIME_DEFAULTS,
  HASH_MODEL,
  PROJECT_ROOT,
  AI_MEMORY_ROOT,
  IS_WINDOWS,
  POWERSHELL_COMMAND,
  getSearchWorkerSnapshot,
  getSearchWorkerHealth: () => getSearchWorkerHealth(searchWorkerDeps),
  clearSearchWorkerCache: (opts) => clearSearchWorkerCache(opts, searchWorkerDeps),
  requestSearchWorker: (payload, timeoutMs) => requestSearchWorker(payload, timeoutMs, searchWorkerDeps),
  isSearchWorkerRunning,
  restartSearchWorker,
  readEmbeddingRuntimeSummary: readEmbeddingRuntimeSummaryBound,
  readEmbeddingsSummary: readEmbeddingsSummaryBound,
  refreshEmbeddingMetricsFromSummary,
  buildEmbeddingIndexState: (runtimeSummary, embeddingsSummary) =>
    buildEmbeddingIndexState(runtimeSummary, embeddingsSummary, { buildEmbeddingConfigHash, HASH_MODEL }),
  readMemoryIntegritySummary: readMemoryIntegritySummaryBound,
  readMemoryHygieneReport: readMemoryHygieneReportBound,
  readWatchdogState,
  getClaudeMemHealth: async () => {
    const base = sharedParams.CLAUDE_MEM_BASE;
    try {
      const response = await fetch(`${base}/api/health`);
      const payload = await response.json();
      const normalizedStatus = String(payload?.status || "").trim().toLowerCase();
      const ok = typeof payload?.ok === "boolean" ? payload.ok : normalizedStatus === "ok";
      return { ...payload, ok };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },
  readEmbeddingRuntimeCatalog: readEmbeddingRuntimeCatalogBound,
  annotateEmbeddingRuntimeCatalog: (catalog, embeddingsSummary) =>
    annotateEmbeddingRuntimeCatalog(catalog, embeddingsSummary, { buildEmbeddingConfigHash, HASH_MODEL }),
  updateEmbeddingRuntimeSelection,
  buildEmbeddingRuntimeRestartSignature,
};

// ---------------------------------------------------------------------------
// Build handler registry and wire the MCP server.
// ---------------------------------------------------------------------------
const ALL_HANDLERS = buildHandlerRegistry(sharedParams, mcpMemoryHandlers);
const server = createMcpServer();

// I-HIGH-1 partial: AI_MEMORY_SERVER_MODE 控制工具子集暴露。
//   undefined / "all"          → 全部 29 个工具 (向后兼容,monolithic 模式,默认)
//   "retrieval" / "bridge" / "dream" / "mgmt"
//                              → 仅暴露对应子集 (为未来 4-server 拆分做铺垫;
//                                 当前仍是单进程,只是工具名过滤 + 不可见 tool
//                                 调用直接返回 tool-not-found)
//
// 完整 4-server 独立进程拆分 (docs/architecture/SERVER-SPLIT.md §7) 留作未来 PR;
// 本次 PR 只激活 toolFilter 入口,把现状从"死代码"变为"环境变量驱动"模式,
import { RETRIEVAL_TOOLS, BRIDGE_TOOLS, DREAM_TOOLS, MGMT_TOOLS } from "./tool-registry.js";
const SUBSETS_BY_MODE = Object.freeze({
  retrieval: RETRIEVAL_TOOLS,
  bridge: BRIDGE_TOOLS,
  dream: DREAM_TOOLS,
  mgmt: MGMT_TOOLS,
});
const serverMode = String(process.env.AI_MEMORY_SERVER_MODE || "all").trim().toLowerCase();
const toolFilter = SUBSETS_BY_MODE[serverMode] || undefined;
// I-HIGH-1 stage 3 (PR17 commit 4): 让 tasklist / ps 能区分 4 个独立 server 进程。
// split 模式下 process.title 显示为 omni-memory-{retrieval,bridge,dream,mgmt},
// monolithic / 默认模式下保持 omni-memory-server 原标题。
if (SUBSETS_BY_MODE[serverMode]) {
  try {
    process.title = `omni-memory-${serverMode}`;
  } catch {
    // 某些平台 (e.g. Windows w/ title 权限受限) 不允许改 process.title,
    // best-effort 失败不应阻塞启动。
  }
}
if (toolFilter) {
  log.info("omni-memory-server-mode-active", { mode: serverMode, toolCount: toolFilter.length });
}
registerMcpRequestHandlers(server, { ALL_HANDLERS, METRICS, log, toolFilter });

process.on("uncaughtException", (err) => {
  log.error("uncaught-exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled-rejection", { reason: String(reason) });
});
process.on("exit", () => {
  try {
    killSearchWorkerOnExit();
  } catch {
    // Best-effort cleanup only.
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
log.info("omni-memory-server-starting", {
  pid: process.pid,
  version: "3.1.0",
  storeRoot: STORE_ROOT,
  vaultRoot: VAULT_ROOT,
  nodeVersion: process.version,
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Start metrics refresh interval and HTTP server.
startMetricsRefreshInterval({
  GENERATED_ROOT,
  STORE_ROOT,
  readEmbeddingsSummary: readEmbeddingsSummaryBound,
});
startMetricsServer({
  EMBEDDINGS_INDEX_PATH,
  readEmbeddingRuntimeSummary: readEmbeddingRuntimeSummaryBound,
});

// ---------------------------------------------------------------------------
// Re-exports — preserve the original module surface for any external importer.
// ---------------------------------------------------------------------------
export {
  resolveProjectPath,
  resolveStoreRoot,
  STORE_ROOT,
  MEMORY_STORE_ROOT,
  STRUCTURED_ROOT,
  GENERATED_ROOT,
  EMBEDDINGS_INDEX_PATH,
  VAULT_ROOT,
  METRICS,
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
  restartSearchWorker,
  ensureSearchWorker,
};