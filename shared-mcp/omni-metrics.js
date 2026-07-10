// shared-mcp/omni-metrics.js
//
// Re-export shim for the metrics pipeline. The implementation has been
// split into three sibling modules under shared-mcp/metrics/:
//   - source.js  — disk/state readers (read* functions, METRICS counters)
//   - compute.js — snapshot rendering + search-worker lifecycle
//   - server.js  — HTTP /metrics transport + refresh interval
//
// This file preserves the original public surface of the pre-split
// module so existing `import { ... } from "./omni-metrics.js"` callers
// (e.g. shared-mcp/omni-memory-server.js) keep working without edits.

export {
  log,
  METRICS,
  // source.js
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
  // compute.js
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
  // server.js
  startMetricsServer,
  startMetricsRefreshInterval,
} from "./metrics/index.js";
