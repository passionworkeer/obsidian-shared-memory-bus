"use strict";

const { afterEach, beforeEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Ensure the store-root stub exists before mcp-memory-tools.js loads.
// The stub must exist and use process.env (deferred evaluation) so that
// beforeEach can override the store root before any test calls memory_*.
const stubStoreRootPath = path.join(__dirname, "..", "..", "..", "bus", "store-root.js");
const storeRootStub = `
module.exports = {
  resolveStoreRoot() {
    return process.env.AI_MEMORY_STORE ||
      process.env.AI_MEMORY_STORE_ROOT ||
      "E:/desktop/.ai-memory";
  },
};
`;
fs.writeFileSync(stubStoreRootPath, storeRootStub, "utf8");

// Clear cached modules that capture resolveStoreRoot at load time so the stub
// is re-evaluated with the correct deferred logic.
const mcpToolsPath = require.resolve("../../../ops/mcp/mcp-memory-tools.js");
for (const key of [...Object.keys(require.cache)]) {
  if (key.includes("mcp-memory-tools") || key.includes("store-root")) {
    delete require.cache[key];
  }
}

const {
  memory_boot,
  memory_query,
  memory_search,
  memory_write,
} = require("../../../ops/mcp/mcp-memory-tools.js");

describe("mcp-memory-tools", () => {
  let tempRoot;
  let originalStore;
  let originalStoreRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tools-"));
    originalStore = process.env.AI_MEMORY_STORE;
    originalStoreRoot = process.env.AI_MEMORY_STORE_ROOT;
    process.env.AI_MEMORY_STORE = tempRoot;
    delete process.env.AI_MEMORY_STORE_ROOT;
  });

  afterEach(() => {
    if (originalStore == null) {
      delete process.env.AI_MEMORY_STORE;
    } else {
      process.env.AI_MEMORY_STORE = originalStore;
    }
    if (originalStoreRoot == null) {
      delete process.env.AI_MEMORY_STORE_ROOT;
    } else {
      process.env.AI_MEMORY_STORE_ROOT = originalStoreRoot;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("memory_boot returns global content and recent project facts", () => {
    fs.writeFileSync(path.join(tempRoot, "global.md"), "User prefers concise replies.\n", "utf8");

    const writeResult = memory_write({
      project: "demo-project",
      facts: [
        { content: "Merged CI fixes into the demo project.", session_type: "chore" },
        { content: "Memory boot now reads from projects JSONL.", session_type: "feature" },
      ],
    });

    assert.equal(writeResult.ok, true);

    const result = memory_boot({ project: "demo-project", top_k: 5 });

    assert.equal(result.project, "demo-project");
    assert.equal(result.fact_count, 2);
    assert.equal(result.global_exists, true);
    assert.match(result.context, /User prefers concise replies/);
    assert.match(result.context, /Memory boot now reads from projects JSONL/);
  });

  test("memory_search finds matching project facts", () => {
    memory_write({
      project: "demo-project",
      facts: [
        { content: "Search worker caches repeated BM25 queries.", session_type: "feature" },
        { content: "Installer now writes context summaries.", session_type: "docs" },
      ],
    });

    const result = memory_search({ query: "BM25 queries", project: "demo-project" });

    assert.equal(result.total_docs, 2);
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].content, /BM25/);
  });

  test("memory_query exposes compact and full result shapes", () => {
    const writeResult = memory_write({
      project: "demo-project",
      facts: [{ content: "Context generation writes CONTEXT.md for passive agents.", session_type: "docs" }],
    });

    assert.equal(writeResult.ok, true);

    const compact = memory_query({ query: "passive agents", project: "demo-project" });
    const full = memory_query({ query: "passive agents", project: "demo-project", depth: "full" });

    assert.equal(compact.results.length, 1);
    assert.ok(compact.results[0].summary);
    assert.equal(full.results.length, 1);
    assert.ok(full.results[0].content_hash);
  });
});
