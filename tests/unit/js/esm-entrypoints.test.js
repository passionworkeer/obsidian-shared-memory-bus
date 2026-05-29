import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

test("semantic-search.js starts as an ESM CLI and prints usage without a query", () => {
  const result = runNode(["retrieval/semantic-search.js"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node semantic-search\.js/);
  assert.doesNotMatch(result.stderr, /require is not defined/);
});

test("playwright-stdio-proxy.js starts as an ESM CLI and reports an unreachable HTTP server", () => {
  const result = runNode(["shared-mcp/playwright-stdio-proxy.js"], {
    env: {
      PLAYWRIGHT_MCP_HOST: "127.0.0.1",
      PLAYWRIGHT_MCP_PORT: "65534",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Playwright MCP HTTP server not running on port 65534/);
  assert.doesNotMatch(result.stderr, /require is not defined/);
});

test("knowledge-graph.js constructs from ESM when node:sqlite is available", async (t) => {
  try {
    await import("node:sqlite");
  } catch {
    t.skip("node:sqlite is not available on this Node.js version");
    return;
  }

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-kg-esm-"));
  try {
    const { KnowledgeGraph } = await import("../../../ops/knowledge/knowledge-graph.js");
    const kg = new KnowledgeGraph({ storeRoot });
    try {
      const stats = kg.stats();
      assert.equal(stats.entities, 0);
      assert.equal(stats.triples, 0);
      assert.equal(stats.currentFacts, 0);
      assert.equal(stats.expiredFacts, 0);
      assert.ok(Array.isArray(stats.relationshipTypes));
    } finally {
      kg.close();
    }
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("knowledge-graph.js CLI runs on Windows-compatible direct-run detection", async (t) => {
  try {
    await import("node:sqlite");
  } catch {
    t.skip("node:sqlite is not available on this Node.js version");
    return;
  }

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-kg-cli-"));
  try {
    const result = runNode(["ops/knowledge/knowledge-graph.js", "stats"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /"entities":\s*0/);
    assert.doesNotMatch(result.stderr, /ReferenceError|require is not defined/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("memory-retrieval KG handlers load the graph from STORE_ROOT", async (t) => {
  try {
    await import("node:sqlite");
  } catch {
    t.skip("node:sqlite is not available on this Node.js version");
    return;
  }

  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-retrieval-kg-"));
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-retrieval-vault-"));
  try {
    const { createMemoryRetrieval } = await import("../../../shared-mcp/memory-retrieval.js");
    const { handlers } = createMemoryRetrieval({
      STORE_ROOT: storeRoot,
      MEMORY_STORE_ROOT: storeRoot,
      VAULT_ROOT: vaultRoot,
    });

    const result = await handlers.get_kg_stats({});
    assert.equal(result.isError, undefined);

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.totalEntities, 0);
    assert.equal(payload.totalRelationships, 0);
    assert.ok(fs.existsSync(path.join(storeRoot, "kg", "knowledge-graph.sqlite3")));
    assert.equal(fs.existsSync(path.join(vaultRoot, "kg", "knowledge-graph.sqlite3")), false);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});
