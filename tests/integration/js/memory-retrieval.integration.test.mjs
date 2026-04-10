/**
 * Integration test for memory-retrieval.js factory.
 *
 * Tests the full request flow by injecting mock params and verifying
 * response envelope structure — no real subprocess calls.
 *
 * Run with: node --test tests/integration/js/memory-retrieval.integration.test.mjs
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * Resolve a path to a file:// URL for ESM dynamic import.
 * On Windows, require.resolve() returns 'E:\...' which must be converted.
 */
function resolveAsFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

// ---------------------------------------------------------------------------
// Helper: create a temp directory with JSONL fixtures
// ---------------------------------------------------------------------------

function createTempVault(fixtures) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bus-test-"));
  for (const { filename, content } of fixtures) {
    fs.writeFileSync(path.join(tmpDir, filename), content, "utf8");
  }
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Mock factories for injection
// ---------------------------------------------------------------------------

function createMockParams(overrides = {}) {
  const metrics = {
    search_latency_seconds: [],
    searches_total: {},
  };
  return {
    METRICS: metrics,
    requestSearchWorker: async (payload, timeoutMs) => {
      assert.strictEqual(typeof payload.action, "string");
      assert.strictEqual(typeof payload.query, "string");
      assert.strictEqual(typeof payload.mode, "string");
      assert.ok(timeoutMs > 0, "timeout should be positive");
      return {
        ok: true,
        query: payload.query,
        mode: payload.mode,
        route: payload.route,
        limit: payload.limit,
        resultCount: 2,
        results: [
          {
            id: "test-record-1",
            title: "Test Record One",
            scope: "user",
            memory_level: "durable",
            score: 0.95,
            snippet: "This is a test result for the query.",
          },
          {
            id: "test-record-2",
            title: "Test Record Two",
            scope: "project",
            memory_level: "session",
            score: 0.87,
            snippet: "Another matching record.",
          },
        ],
        timings: { total_ms: 42 },
      };
    },
    getSearchWorkerHealth: async () => ({ ok: true, available: true }),
    clearSearchWorkerCache: async () => ({ ok: true, cleared: true }),
    getToolMetadata: () => ({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("memory-retrieval factory integration", { concurrency: false }, () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let memoryRetrievalPath;

  beforeEach(async () => {
    tmpDir = createTempVault([
      {
        filename: "session-memory.jsonl",
        content:
          JSON.stringify({
            schemaVersion: 2,
            id: "s1",
            tool: "memory-wake-up",
            type: "n",
            title: "Morning standup notes",
            source: "claude-code",
            scope: "session",
            memory_level: "session",
            content: "Daily standup completed. Three tasks in progress.",
          }) + "\n",
      },
      {
        filename: "shared-inbox.jsonl",
        content:
          JSON.stringify({
            schemaVersion: 2,
            id: "u1",
            tool: "memory-wake-up",
            type: "n",
            title: "User preference",
            source: "claude-code",
            scope: "user",
            memory_level: "durable",
            content: "User prefers concise replies.",
          }) + "\n",
      },
    ]);

    memoryRetrievalPath = path.resolve(__dirname, "../../../shared-mcp/memory-retrieval.js");
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      for (const file of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
      fs.rmdirSync(tmpDir);
    }
  });

  test("createMemoryRetrieval returns an object with tools and handlers", async () => {
    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const params = createMockParams();
    const { tools, handlers } = createMemoryRetrieval(params);

    assert.ok(Array.isArray(tools), "tools should be an array");
    assert.ok(tools.length > 0, "tools should not be empty");
    assert.ok(tools.every((t) => typeof t.name === "string"), "each tool should have a name");
    assert.ok(
      typeof handlers === "object" && handlers !== null,
      "handlers should be an object"
    );
  });

  test("handleSearchSharedMemory: empty query returns error envelope", async () => {
    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const params = createMockParams();
    const { handlers } = createMemoryRetrieval(params);

    const result = await handlers.search_shared_memory({ query: "" });

    assert.strictEqual(result.isError, true, "empty query should be an error");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, false, "error payload should have ok=false");
    assert.ok(payload.error.includes("query"), "error message should mention query");
  });

  test("handleSearchSharedMemory: valid query returns structured result", async () => {
    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const params = createMockParams();
    const { handlers } = createMemoryRetrieval(params);

    const result = await handlers.search_shared_memory({
      query: "test search query",
      mode: "hybrid",
      route: "auto",
      limit: 8,
    });

    assert.strictEqual(result.isError, undefined, "valid result should not be an error");
    assert.ok(Array.isArray(result.content), "result should have content array");
    const payload = JSON.parse(result.content[0].text);

    assert.strictEqual(payload.ok, true, "payload should have ok=true");
    assert.strictEqual(payload.query, "test search query", "payload should echo query");
    assert.strictEqual(payload.mode, "hybrid", "payload should include mode");
    assert.ok(Array.isArray(payload.results), "payload should have results array");
    assert.ok(payload.results.length > 0, "results should not be empty");
    assert.ok(typeof payload.results[0].id === "string", "result should have id");
    assert.ok(typeof payload.results[0].score === "number", "result should have numeric score");
  });

  test("handleSearchSharedMemory: passes all route/mode/filter args to requestSearchWorker", async () => {
    let receivedPayload = null;
    const params = createMockParams({
      requestSearchWorker: async (payload) => {
        receivedPayload = payload;
        return { ok: true, results: [], resultCount: 0 };
      },
    });

    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const { handlers } = createMemoryRetrieval(params);

    await handlers.search_shared_memory({
      query: "deep search",
      mode: "dense",
      route: "task",
      limit: 5,
      tool: "openclaw",
      project: "my-app",
      scope: "user",
      sourceKind: "session",
      workspace: "default",
      taskState: "ACTIVE",
      preferSummaries: true,
      includeVerbatim: true,
      snippetWindow: 300,
      maxVerbatimPerResult: 2,
    });

    assert.strictEqual(receivedPayload.query, "deep search");
    assert.strictEqual(receivedPayload.mode, "dense");
    assert.strictEqual(receivedPayload.route, "task");
    assert.strictEqual(receivedPayload.limit, 5);
    assert.strictEqual(receivedPayload.tool, "openclaw");
    assert.strictEqual(receivedPayload.project, "my-app");
    assert.strictEqual(receivedPayload.scope, "user");
    assert.strictEqual(receivedPayload.sourceKind, "session");
    assert.strictEqual(receivedPayload.workspace, "default");
    assert.strictEqual(receivedPayload.taskState, "ACTIVE");
    assert.strictEqual(receivedPayload.preferSummaries, true);
    assert.strictEqual(receivedPayload.includeVerbatim, true);
    assert.strictEqual(receivedPayload.snippetWindow, 300);
    assert.strictEqual(receivedPayload.maxVerbatimPerResult, 2);
  });

  test("handleGetMemoryRecords: returns structured records", async () => {
    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const params = createMockParams({
      requestSearchWorker: async (payload) => {
        return {
          ok: true,
          records: [
            {
              id: "test-record-1",
              title: "Test Record",
              scope: "user",
              memory_level: "durable",
              content: "Test content",
            },
          ],
        };
      },
    });
    const { handlers } = createMemoryRetrieval(params);

    const result = await handlers.get_memory_records({
      ids: ["test-record-1"],
    });

    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, true);
    assert.ok(Array.isArray(payload.records));
    assert.strictEqual(payload.records[0].id, "test-record-1");
  });

  test("handleClearSharedMemorySearchCache: returns ok=true", async () => {
    const { createMemoryRetrieval } = await import(resolveAsFileUrl(memoryRetrievalPath));
    const params = createMockParams();
    const { handlers } = createMemoryRetrieval(params);

    const result = await handlers.clear_shared_memory_search_cache({});
    // Result is wrapped in jsonResult envelope
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.cleared, true);
  });
});
