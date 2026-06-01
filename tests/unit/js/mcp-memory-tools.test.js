import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  memory_boot,
  memory_query,
  memory_search,
  memory_write,
} = await import("../../../ops/mcp/mcp-memory-tools.js");

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

  test("memory_boot returns global content and recent project facts", async () => {
    fs.writeFileSync(path.join(tempRoot, "global.md"), "User prefers concise replies.\n", "utf8");

    const writeResult = await memory_write({
      project: "boot-project",
      facts: [
        { content: "Merged CI fixes into the demo project.", session_type: "chore" },
        { content: "Memory boot now reads from projects JSONL.", session_type: "feature" },
      ],
    });

    assert.equal(writeResult.ok, true);

    const result = await memory_boot({ project: "boot-project", top_k: 5 });

    assert.equal(result.project, "boot-project");
    assert.equal(result.fact_count, 2);
    assert.equal(result.global_exists, true);
    assert.match(result.context, /User prefers concise replies/);
    assert.match(result.context, /Memory boot now reads from projects JSONL/);
  });

  test("memory_search finds matching project facts", async () => {
    await memory_write({
      project: "search-project",
      facts: [
        { content: "Search worker caches repeated BM25 queries.", session_type: "feature" },
        { content: "Installer now writes context summaries.", session_type: "docs" },
      ],
    });

    const result = await memory_search({ query: "BM25 queries", project: "search-project" });

    assert.equal(result.total_docs, 2);
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].content, /BM25/);
  });

  test("memory_query exposes compact and full result shapes", async () => {
    const writeResult = await memory_write({
      project: "query-project",
      facts: [{ content: "Context generation writes CONTEXT.md for passive agents.", session_type: "docs" }],
    });

    assert.equal(writeResult.ok, true);

    const compact = await memory_query({ query: "passive agents", project: "query-project" });
    const full = await memory_query({ query: "passive agents", project: "query-project", depth: "full" });

    assert.equal(compact.results.length, 1);
    assert.ok(compact.results[0].summary);
    assert.equal(full.results.length, 1);
    assert.ok(full.results[0].content_hash);
  });
});
