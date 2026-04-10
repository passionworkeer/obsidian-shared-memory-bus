/**
 * Integration tests for shared-mcp/memory-status.js factory.
 *
 * Tests the full factory integration: handler response envelopes,
 * wake_up structure, overview structure, status structure,
 * and that JSONL parse failures in loadTaskRecords are tracked.
 *
 * Run with: node --test tests/integration/js/memory-status.integration.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function resolveAsFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function createTempVault(fixtures) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-status-test-"));
  for (const { filename, content } of fixtures) {
    const dir = path.join(tmpDir, path.dirname(filename));
    if (dir !== tmpDir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, filename), content, "utf8");
  }
  return tmpDir;
}

function createTempFile(content) {
  const fd = fs.mkstempSync({ dir: os.tmpdir(), prefix: "memory-status-", suffix: ".jsonl" });
  fs.writeSync(fd, content);
  fs.closeSync(fd);
  return fd;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("memory-status integration", () => {

  test("handleMemoryStatus returns a valid MCP envelope", async () => {
    const tmpDir = createTempVault([]);
    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));

    const mockMemoryIntegritySummary = () => ({ ok: true, contractVersion: 2, recordSchemaVersion: 2 });
    const mockMemoryHygieneReport = () => ({ health: { score: 95, grade: "A" } });
    const mockWatchdogState = () => ({ running: false, pid: null });
    const mockGetClaudeMemHealth = async () => ({ available: false });

    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: tmpDir,
      CANONICAL_AI_MEMORY_ROOT: tmpDir,
      STRUCTURED_ROOT: path.join(tmpDir, "00-System", "ai-memory", "structured"),
      GENERATED_ROOT: path.join(tmpDir, "00-System", "ai-memory", "generated"),
      EMBEDDINGS_INDEX_PATH: path.join(tmpDir, "embeddings.index.jsonl"),
      HANDOFF_PACK_JSON_PATH: path.join(tmpDir, "HANDOFF.json"),
      MEMORY_LAYERS_JSON_PATH: path.join(tmpDir, "MEMORY-LAYERS.json"),
      AUTO_DREAM_JSON_PATH: path.join(tmpDir, "AUTO-DREAM.json"),
      WATCHDOG_STATE_PATH: path.join(tmpDir, "watchdog.json"),
      HASH_MODEL: "text-embedding-3-small",
      CLAUDE_MEM_BASE: "http://127.0.0.1:37778",
      PYTHON: { command: "python", available: false, version: null, error: null, argsPrefix: [] },
      METRICS: {
        searches_total: 0,
        search_latency_seconds: [],
        embeddings_index_age_seconds: 0,
        embeddings_index_size: 0,
        structured_files_total: 0,
        promotion_queue_size: 0,
        search_worker_restarts_total: 0,
        search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
      readEmbeddingRuntimeSummary: () => ({ available: false }),
      readEmbeddingsSummary: () => ({ totalVectors: 0 }),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({ needsRebuild: false }),
      readMemoryIntegritySummary: mockMemoryIntegritySummary,
      readMemoryHygieneReport: mockMemoryHygieneReport,
      readWatchdogState: mockWatchdogState,
      getClaudeMemHealth: mockGetClaudeMemHealth,
      getSearchWorkerSnapshot: () => ({ pid: null, status: "not-started" }),
      getSearchWorkerHealth: async () => ({ status: "not-started" }),
    });

    const result = await factory.handlers.memory_status();
    assert.ok(result.content, "response has content array");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, "payload.ok is true");
    assert.ok(payload.pythonRuntime, "has pythonRuntime");
    assert.ok(payload.searchWorker, "has searchWorker");
    assert.ok(payload.watchdog, "has watchdog");
    assert.ok(payload.memoryIntegrity, "has memoryIntegrity");
    assert.ok(payload.embeddingRuntime, "has embeddingRuntime");
    assert.ok(payload.metrics, "has metrics");
  });

  test("handleGetMemoryOverview returns project context and stats", async () => {
    const generatedDir = path.join(os.tmpdir(), "memory-overview-test-" + Date.now());
    fs.mkdirSync(path.join(generatedDir, "00-System", "ai-memory", "generated"), { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "00-System", "ai-memory", "generated", "GLOBAL-CONTEXT.meta.json"), JSON.stringify({
      totalRecords: 42,
      estimatedTotalTokens: 5000,
      segments: [],
    }));
    fs.writeFileSync(path.join(generatedDir, "00-System", "ai-memory", "generated", "AUTO-DREAM.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      promotionQueue: [],
      refreshQueue: [],
    }));
    fs.writeFileSync(path.join(generatedDir, "00-System", "ai-memory", "generated", "memory_hygiene_report.json"), JSON.stringify({
      health: { score: 88, grade: "B" },
      recommendations: ["recommend-rebuild"],
    }));
    fs.writeFileSync(path.join(generatedDir, "00-System", "ai-memory", "generated", "HANDOFF.json"), JSON.stringify({
      goal: "Test goal",
      done: ["item1", "item2"],
      next: ["item3"],
      blocked: [],
    }));

    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));
    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: generatedDir,
      GENERATED_ROOT: path.join(generatedDir, "00-System", "ai-memory", "generated"),
      readEmbeddingRuntimeSummary: () => ({}),
      readEmbeddingsSummary: () => ({}),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({}),
      readMemoryIntegritySummary: () => ({}),
      readMemoryHygieneReport: () => ({}),
      readWatchdogState: () => ({}),
      getClaudeMemHealth: async () => ({}),
      getSearchWorkerSnapshot: () => ({}),
      getSearchWorkerHealth: async () => ({}),
      METRICS: {
        searches_total: 0, search_latency_seconds: [], embeddings_index_age_seconds: 0,
        embeddings_index_size: 0, structured_files_total: 0, promotion_queue_size: 0,
        search_worker_restarts_total: 0, search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
    });

    const result = await factory.handlers.get_memory_overview({});
    assert.ok(result.content, "response has content");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(payload.workspace, "has workspace");
    assert.ok(payload.memory_summary, "has memory_summary");
    assert.equal(payload.memory_summary.total_records, 42);
    assert.ok(payload.active_tasks, "has active_tasks");
    assert.ok(payload.handoff, "has handoff");
    assert.equal(payload.handoff.goal, "Test goal");
  });

  test("handleMemoryWakeUp returns correct layer structure", async () => {
    const generatedDir = path.join(os.tmpdir(), "memory-wakeup-test-" + Date.now());
    fs.mkdirSync(path.join(generatedDir, "00-System", "ai-memory", "generated"), { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "HANDOFF.json"), JSON.stringify({
      goal: "Finish integration tests",
      done: ["task-a", "task-b"],
      next: ["task-c"],
      blocked: ["task-d"],
      open_threads: ["thread-x"],
    }));
    fs.writeFileSync(path.join(generatedDir, "MEMORY-LAYERS.json"), JSON.stringify({
      latest: {
        durableByScope: {
          user: [{ title: "User preference: prefer concise output" }],
          feedback: [],
          project: [{ title: "Project is obsidian-shared-memory-bus" }],
        },
        sessionMemory: [{ title: "Recent session note" }],
        taskMemory: [],
        sharedEvents: [],
      },
    }));

    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));
    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: generatedDir,
      GENERATED_ROOT: generatedDir,
      readEmbeddingRuntimeSummary: () => ({}),
      readEmbeddingsSummary: () => ({}),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({}),
      readMemoryIntegritySummary: () => ({}),
      readMemoryHygieneReport: () => ({}),
      readWatchdogState: () => ({}),
      getClaudeMemHealth: async () => ({}),
      getSearchWorkerSnapshot: () => ({}),
      getSearchWorkerHealth: async () => ({}),
      METRICS: {
        searches_total: 0, search_latency_seconds: [], embeddings_index_age_seconds: 0,
        embeddings_index_size: 0, structured_files_total: 0, promotion_queue_size: 0,
        search_worker_restarts_total: 0, search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
    });

    const result = await factory.handlers.memory_wake_up({ max_items: 3 });
    assert.ok(result.content, "response has content");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(payload.wake_up, "has wake_up");
    assert.ok(payload.wake_up.layers, "wake_up has layers");
    assert.ok(payload.wake_up.layers.identity, "layers has identity");
    assert.ok(payload.wake_up.layers.essential, "layers has essential");
    assert.ok(payload.wake_up.layers.recent, "layers has recent");
    assert.ok(payload.wake_up.layers.retrieve, "layers has retrieve");
    assert.ok(Array.isArray(payload.wake_up.prompt), "wake_up has prompt array");
    assert.equal(payload.wake_up.next[0], "task-c", "next item is correct");
    assert.equal(payload.wake_up.blocked[0], "task-d", "blocked item is correct");
  });

  test("loadTaskRecords tracks skipped malformed lines", async () => {
    // Create a temp task-memory.jsonl with mixed valid and malformed lines
    const generatedDir = path.join(os.tmpdir(), "memory-parse-test-" + Date.now());
    const structuredDir = path.join(generatedDir, "00-System", "ai-memory", "structured");
    fs.mkdirSync(structuredDir, { recursive: true });
    const taskFile = path.join(structuredDir, "task-memory.jsonl");
    const validRecord = JSON.stringify({ id: "task-1", title: "Valid task", task_state: "active", tool: "test" });
    const badLine = "this is not json {{{{broken";
    const anotherValid = JSON.stringify({ id: "task-2", title: "Another task", task_state: "pending", tool: "test" });
    fs.writeFileSync(taskFile, [validRecord, badLine, anotherValid].join("\n"), "utf8");

    // Set up a minimal factory to reach loadTaskRecords indirectly via memory_wake_up
    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));
    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: generatedDir,
      GENERATED_ROOT: generatedDir,
      readEmbeddingRuntimeSummary: () => ({}),
      readEmbeddingsSummary: () => ({}),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({}),
      readMemoryIntegritySummary: () => ({}),
      readMemoryHygieneReport: () => ({}),
      readWatchdogState: () => ({}),
      getClaudeMemHealth: async () => ({}),
      getSearchWorkerSnapshot: () => ({}),
      getSearchWorkerHealth: async () => ({}),
      METRICS: {
        searches_total: 0, search_latency_seconds: [], embeddings_index_age_seconds: 0,
        embeddings_index_size: 0, structured_files_total: 0, promotion_queue_size: 0,
        search_worker_restarts_total: 0, search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
    });

    // The loadTaskRecords result is surfaced via memory_wake_up / get_memory_overview
    // Check that a console.warn was called for the malformed line
    // We verify indirectly: parse result includes skippedCount > 0
    // by calling loadTaskRecords via handleGetMemoryOverview which filters active tasks
    let warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      const result = await factory.handlers.get_memory_overview({});
      console.warn = originalWarn;
      const payload = JSON.parse(result.content[0].text);
      // Active tasks should only include the valid ones
      // The broken line should have been skipped (logged as warning)
      assert.ok(warnings.some(w => w.includes("malformed") || w.includes("broken") || w.includes("not json")),
        `Expected a warning about malformed line, got: ${warnings.join(" | ")}`);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("loadTaskRecords returns empty array when file is absent", async () => {
    const generatedDir = path.join(os.tmpdir(), "memory-no-file-test-" + Date.now());
    fs.mkdirSync(path.join(generatedDir, "00-System", "ai-memory", "structured"), { recursive: true });
    // Do NOT create task-memory.jsonl

    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));
    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: generatedDir,
      GENERATED_ROOT: generatedDir,
      readEmbeddingRuntimeSummary: () => ({}),
      readEmbeddingsSummary: () => ({}),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({}),
      readMemoryIntegritySummary: () => ({}),
      readMemoryHygieneReport: () => ({}),
      readWatchdogState: () => ({}),
      getClaudeMemHealth: async () => ({}),
      getSearchWorkerSnapshot: () => ({}),
      getSearchWorkerHealth: async () => ({}),
      METRICS: {
        searches_total: 0, search_latency_seconds: [], embeddings_index_age_seconds: 0,
        embeddings_index_size: 0, structured_files_total: 0, promotion_queue_size: 0,
        search_worker_restarts_total: 0, search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
    });

    const result = await factory.handlers.get_memory_overview({});
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, "still returns ok when no task file");
    assert.equal(payload.active_tasks.count, 0, "active_tasks.count is 0");
  });

  test("detectCurrentProject reads git remote URL", async () => {
    const tmpDir = createTempVault([]);
    const gitConfigDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitConfigDir);
    fs.writeFileSync(path.join(gitConfigDir, "config"),
      "[core]\n  repositoryformatversion = 0\n[remote \"origin\"]\n  url = https://github.com/example/my-project.git\n");
    const generatedDir = path.join(tmpDir, "00-System", "ai-memory", "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, "HANDOFF.json"), "{}");
    fs.writeFileSync(path.join(generatedDir, "MEMORY-LAYERS.json"), JSON.stringify({ latest: {} }));
    fs.writeFileSync(path.join(generatedDir, "GLOBAL-CONTEXT.meta.json"), "{}");

    const statusModule = await import(resolveAsFileUrl(path.join(__dirname, "..", "..", "..", "shared-mcp", "memory-status.js")));
    const factory = statusModule.createMemoryStatus({
      VAULT_ROOT: tmpDir,
      GENERATED_ROOT: generatedDir,
      readEmbeddingRuntimeSummary: () => ({}),
      readEmbeddingsSummary: () => ({}),
      refreshEmbeddingMetricsFromSummary: () => {},
      buildEmbeddingIndexState: () => ({}),
      readMemoryIntegritySummary: () => ({}),
      readMemoryHygieneReport: () => ({}),
      readWatchdogState: () => ({}),
      getClaudeMemHealth: async () => ({}),
      getSearchWorkerSnapshot: () => ({}),
      getSearchWorkerHealth: async () => ({}),
      METRICS: {
        searches_total: 0, search_latency_seconds: [], embeddings_index_age_seconds: 0,
        embeddings_index_size: 0, structured_files_total: 0, promotion_queue_size: 0,
        search_worker_restarts_total: 0, search_worker_backpressure_rejected: 0,
        mcp_requests_total: 0,
      },
    });

    const result = await factory.handlers.memory_wake_up({});
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.workspace.detected_project, "my-project",
      "detected_project extracts from git remote URL");
  });
});
