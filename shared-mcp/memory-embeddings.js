/**
 * memory-embeddings.js
 *
 * Handles all embedding management tools:
 *   rebuild_memory_embeddings / rebuild_shared_embeddings
 *   list_embedding_runtimes
 *   set_embedding_runtime
 *
 * Exposes a factory: createMemoryEmbeddings(params) => { tools, handlers }
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
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

/**
 * @param {Object} params
 * @param {string}  params.EMBEDDINGS_SCRIPT        - Absolute path to generate-embeddings.js
 * @param {string}  params.VAULT_ROOT
 * @param {Object}  params.RUNTIME_ENV
 * @param {Object}  params.EMBEDDING_RUNTIME_DEFAULTS
 * @param {string}  params.AI_MEMORY_ROOT
 * @param {Object}  params.EMBEDDINGS_INDEX_PATH
 * @param {Object}  params.METRICS                 - Shared metrics object (modified in-place)
 * @param {Function} params.firstNonEmptyEnv
 * @param {Function} params.readEmbeddingsSummary
 * @param {Function} params.refreshEmbeddingMetricsFromSummary
 * @param {Function} params.readEmbeddingRuntimeSummary
 * @param {Function} params.readEmbeddingRuntimeCatalog
 * @param {Function} params.buildEmbeddingIndexState
 * @param {Function} params.annotateEmbeddingRuntimeCatalog
 * @param {Function} params.updateEmbeddingRuntimeSelection
 * @param {Function} params.buildEmbeddingRuntimeRestartSignature
 * @param {Object}  params.METRICS                 - Shared metrics
 * @param {Function} params.getSearchWorkerSnapshot
 * @param {Function} params.getSearchWorkerHealth
 * @param {Function} params.isSearchWorkerRunning
 * @param {Function} params.restartSearchWorker
 */
export function createMemoryEmbeddings(params) {

  async function handleRebuildMemoryEmbeddings(args) {
    const {
      EMBEDDINGS_SCRIPT,
      VAULT_ROOT,
      RUNTIME_ENV,
      refreshEmbeddingMetricsFromSummary,
    } = params;

    if (!fs.existsSync(EMBEDDINGS_SCRIPT)) {
      throw new Error(`embeddings-script-missing: ${EMBEDDINGS_SCRIPT}`);
    }

    const args_ = [EMBEDDINGS_SCRIPT];
    if (args.force) {
      args_.push("--force");
    }

    const result = await spawnProcess(process.execPath, args_, {
      env: {
        ...RUNTIME_ENV,
        AI_MEMORY_STORE: VAULT_ROOT,
      },
    });

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `embeddings-exit-${result.code}`);
    }

    // Refresh metrics after rebuild
    try {
      const summary = params.readEmbeddingsSummary();
      refreshEmbeddingMetricsFromSummary(summary);
    } catch {
      // Non-fatal — metrics refresh failure should not break the response
    }

    return jsonResult({
      ok: true,
      command: `${process.execPath} ${args_.join(" ")}`,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      summary: params.readEmbeddingsSummary(),
    });
  }

  async function handleListEmbeddingRuntimes() {
    const {
      readEmbeddingsSummary,
      refreshEmbeddingMetricsFromSummary,
      readEmbeddingRuntimeCatalog,
      annotateEmbeddingRuntimeCatalog,
      buildEmbeddingIndexState,
    } = params;
    const embeddings = readEmbeddingsSummary();
    refreshEmbeddingMetricsFromSummary(embeddings);
    const catalog = annotateEmbeddingRuntimeCatalog(readEmbeddingRuntimeCatalog(), embeddings);
    return jsonResult({
      ok: true,
      catalog,
      embeddingIndexState: buildEmbeddingIndexState(catalog.runtime, embeddings),
    });
  }

  async function handleSetEmbeddingRuntime(args) {
    const {
      AI_MEMORY_ROOT,
      EMBEDDING_RUNTIME_DEFAULTS,
      readEmbeddingRuntimeSummary,
      readEmbeddingsSummary,
      refreshEmbeddingMetricsFromSummary,
      buildEmbeddingIndexState,
      annotateEmbeddingRuntimeCatalog,
      buildEmbeddingRuntimeRestartSignature,
      getSearchWorkerSnapshot,
      getSearchWorkerHealth,
      isSearchWorkerRunning,
      restartSearchWorker,
      firstNonEmptyEnv,
      updateEmbeddingRuntimeSelection,
    } = params;

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
    refreshEmbeddingMetricsFromSummary(embeddings);
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

  return {
    handlers: {
      rebuild_memory_embeddings: handleRebuildMemoryEmbeddings,
      rebuild_shared_embeddings: handleRebuildMemoryEmbeddings,
      list_embedding_runtimes: handleListEmbeddingRuntimes,
      set_embedding_runtime: handleSetEmbeddingRuntime,
    },
  };
}
