/**
 * memory-status.js
 *
 * Handles all status / overview tools:
 *   memory_status
 *   get_memory_overview
 *
 * Exposes a factory: createMemoryStatus(params) => { tools, handlers }
 */

import fs from "node:fs";
import path from "node:path";

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
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

/**
 * @param {Object} params
 * @param {string}  params.VAULT_ROOT
 * @param {string}  params.CANONICAL_AI_MEMORY_ROOT
 * @param {string}  params.STRUCTURED_ROOT
 * @param {string}  params.GENERATED_ROOT
 * @param {string}  params.EMBEDDINGS_INDEX_PATH
 * @param {string}  params.HANDOFF_PACK_JSON_PATH
 * @param {string}  params.MEMORY_LAYERS_JSON_PATH
 * @param {string}  params.AUTO_DREAM_JSON_PATH
 * @param {string}  params.CLAUDE_MEM_BASE
 * @param {string}  params.WATCHDOG_STATE_PATH
 * @param {string}  params.HASH_MODEL
 * @param {Object}  params.PYTHON               - Python runtime descriptor
 * @param {Object}  params.METRICS              - Shared metrics object
 * @param {Object}  params.EMBEDDING_RUNTIME_DEFAULTS
 * @param {Function} params.getSearchWorkerSnapshot
 * @param {Function} params.getSearchWorkerHealth
 * @param {Function} params.readEmbeddingRuntimeSummary
 * @param {Function} params.readEmbeddingsSummary
 * @param {Function} params.refreshEmbeddingMetricsFromSummary
 * @param {Function} params.buildEmbeddingIndexState
 * @param {Function} params.readMemoryIntegritySummary
 * @param {Function} params.readMemoryHygieneReport
 * @param {Function} params.readWatchdogState
 * @param {Function} params.getClaudeMemHealth
 */
export function createMemoryStatus(params) {
  function clampText(value, maxLength = 160) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function compactUnique(items, maxItems = 3, maxLength = 160) {
    const results = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const normalized = clampText(item, maxLength);
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(normalized);
      if (results.length >= maxItems) {
        break;
      }
    }
    return results;
  }

  function resolveGeneratedDir(workspaceRoot) {
    if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, "00-System", "ai-memory", "generated"))) {
      return path.join(workspaceRoot, "00-System", "ai-memory", "generated");
    }
    return params.GENERATED_ROOT;
  }

  async function buildWakeUpPack(args = {}) {
    const workspaceRoot = args.workspace_root || params.VAULT_ROOT;
    const generatedDir = resolveGeneratedDir(workspaceRoot);
    const maxItems = Math.max(1, Math.min(6, Number(args.max_items) || 3));
    const includeRecentActivity = args.include_recent_activity !== false;

    const handoff = readOptionalJson(path.join(generatedDir, "HANDOFF.json")) || {};
    const layers = readOptionalJson(path.join(generatedDir, "MEMORY-LAYERS.json")) || {};
    const meta = readOptionalJson(path.join(generatedDir, "GLOBAL-CONTEXT.meta.json")) || {};
    const taskRecordsResult = await loadTaskRecords(workspaceRoot);
    const taskRecords = Array.isArray(taskRecordsResult) ? taskRecordsResult : (taskRecordsResult.records || []);
    const openTasks = taskRecords
      .filter((record) => record.task_state && !["completed", "aborted", "failed"].includes(record.task_state))
      .slice(0, maxItems);

    const durableAnchors = compactUnique([
      ...(layers.latest?.durableByScope?.user || []).map((item) => item.title),
      ...(layers.latest?.durableByScope?.feedback || []).map((item) => item.title),
      ...(layers.latest?.durableByScope?.project || []).map((item) => item.title),
      ...(meta.segments || [])
        .flatMap((segment) => Array.isArray(segment.displayedRecords) ? segment.displayedRecords.map((record) => record.title) : []),
    ], maxItems, 180);
    const userAnchors = compactUnique(
      (layers.latest?.durableByScope?.user || []).map((item) => item.title),
      maxItems,
      180
    );
    const projectAnchors = compactUnique(
      (layers.latest?.durableByScope?.project || []).map((item) => item.title),
      maxItems,
      180
    );

    const recentActivity = includeRecentActivity
      ? compactUnique([
        ...(layers.latest?.sessionMemory || []).map((item) => item.title),
        ...(layers.latest?.taskMemory || []).map((item) => item.title),
        ...(layers.latest?.sharedEvents || []).map((item) => item.title),
      ], maxItems, 180)
      : [];

    const wakeUp = {
      detected_project: detectCurrentProject(workspaceRoot),
      goal: clampText(handoff.goal, 220) || null,
      next: compactUnique(handoff.next, maxItems, 180),
      blocked: compactUnique(handoff.blocked, maxItems, 180),
      recent_wins: compactUnique(handoff.done, maxItems, 180),
      open_threads: compactUnique(handoff.open_threads, maxItems, 180),
      active_tasks: openTasks.map((task) => ({
        id: task.id || null,
        title: clampText(task.title || "", 180) || null,
        state: task.task_state || null,
        tool: task.tool || null,
      })),
      durable_anchors: durableAnchors,
      recent_activity: recentActivity,
    };
    const identityLayer = compactUnique([
      wakeUp.detected_project ? `Project: ${wakeUp.detected_project}` : "",
      ...userAnchors.map((item) => `User: ${item}`),
      ...projectAnchors.map((item) => `Project memory: ${item}`),
    ], maxItems, 220);
    const essentialLayer = compactUnique([
      wakeUp.goal ? `Goal: ${wakeUp.goal}` : "",
      ...wakeUp.next.map((item) => `Next: ${item}`),
      ...wakeUp.blocked.map((item) => `Blocked: ${item}`),
      ...wakeUp.durable_anchors.map((item) => `Anchor: ${item}`),
    ], Math.max(4, maxItems + 1), 220);
    const recentLayer = compactUnique([
      ...wakeUp.recent_activity.map((item) => `Recent: ${item}`),
      ...wakeUp.open_threads.map((item) => `Thread: ${item}`),
      ...wakeUp.active_tasks
        .map((task) => clampText(task.title || "", 180))
        .filter(Boolean)
        .map((title) => `Task: ${title}`),
    ], Math.max(4, maxItems + 1), 220);
    const retrieveLayer = {
      default_route: wakeUp.active_tasks.length > 0 || wakeUp.recent_activity.length > 0 ? "mixed" : "durable",
      suggestions: [
        {
          route: "durable",
          use_when: "Need stable user preferences, project facts, or durable decisions.",
        },
        {
          route: "task",
          use_when: "Need active task state, OpenClaw blackboard items, or in-flight execution context.",
        },
        {
          route: "recent",
          use_when: "Need the freshest session/events without pulling the full durable layer.",
        },
        {
          route: "reference",
          use_when: "Need notes, docs, or exact reference-style recall.",
        },
        {
          route: "mixed",
          use_when: "Default follow-up when the answer may span durable, task, and recent layers.",
        },
      ],
    };
    wakeUp.layers = {
      identity: identityLayer,
      essential: essentialLayer,
      recent: recentLayer,
      retrieve: retrieveLayer,
    };

    wakeUp.prompt = compactUnique([
      ...identityLayer,
      ...essentialLayer,
      ...recentLayer,
    ], 10, 220);

    return {
      ok: true,
      workspace: {
        root: workspaceRoot,
        generated_root: generatedDir,
        detected_project: wakeUp.detected_project,
      },
      wake_up: wakeUp,
    };
  }

  function detectCurrentProject(workspaceRoot) {
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

  async function loadTaskRecords(workspaceRoot) {
    const structuredDir = path.join(workspaceRoot, "00-System", "ai-memory", "structured");
    const taskFile = path.join(structuredDir, "task-memory.jsonl");
    if (!fs.existsSync(taskFile)) {
      return [];
    }
    const lines = fs.readFileSync(taskFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const records = [];
    const skippedLines = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        const preview = line.slice(0, 50).replace(/\s+/g, " ").trim();
        console.warn(`[memory-status] Skipped malformed JSON line: "${preview}..." — ${err.message}`);
        skippedLines.push({ line, error: err.message });
      }
    }
    if (skippedLines.length > 0) {
      return { records, skippedCount: skippedLines.length, skippedLines };
    }
    return records;
  }

  async function handleMemoryStatus() {
    const {
      PYTHON,
      HANDOFF_PACK_JSON_PATH,
      MEMORY_LAYERS_JSON_PATH,
      AUTO_DREAM_JSON_PATH,
      readEmbeddingRuntimeSummary,
      readEmbeddingsSummary,
      refreshEmbeddingMetricsFromSummary,
      buildEmbeddingIndexState,
      readMemoryIntegritySummary,
      readMemoryHygieneReport,
      readWatchdogState,
      getClaudeMemHealth,
    } = params;

    const embeddingRuntime = readEmbeddingRuntimeSummary();
    const embeddings = readEmbeddingsSummary();
    refreshEmbeddingMetricsFromSummary(embeddings);
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

  async function handleGetMemoryOverview(args) {
    const { VAULT_ROOT } = params;
    const workspaceRoot = args.workspace_root || VAULT_ROOT;
    const generatedDir = path.join(workspaceRoot, "00-System", "ai-memory", "generated");

    const meta = readOptionalJson(path.join(generatedDir, "GLOBAL-CONTEXT.meta.json"));
    const dream = readOptionalJson(path.join(generatedDir, "AUTO-DREAM.json"));
    const hygiene = readOptionalJson(path.join(generatedDir, "memory_hygiene_report.json"));
    const handoff = readOptionalJson(path.join(generatedDir, "HANDOFF.json"));

    const taskRecordsResult = await loadTaskRecords(workspaceRoot);
    const taskRecords = Array.isArray(taskRecordsResult) ? taskRecordsResult : (taskRecordsResult.records || []);
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

  async function handleMemoryWakeUp(args) {
    return jsonResult(await buildWakeUpPack(args));
  }

  return {
    handlers: {
      memory_status: handleMemoryStatus,
      get_memory_overview: handleGetMemoryOverview,
      memory_wake_up: handleMemoryWakeUp,
    },
  };
}
