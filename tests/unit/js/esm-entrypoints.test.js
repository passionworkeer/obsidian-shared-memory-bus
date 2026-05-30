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

function makeStoreRoot(prefix = "ai-memory-entrypoint-") {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(storeRoot, "structured"), { recursive: true });
  fs.mkdirSync(path.join(storeRoot, "generated"), { recursive: true });
  return storeRoot;
}

test("package scripts point to existing CLI entrypoints", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  for (const scriptName of ["check-integrity", "generate-context"]) {
    const script = String(packageJson.scripts?.[scriptName] || "");
    const match = script.match(/\bnode\s+([^\s]+)/);
    assert.ok(match, `${scriptName} should run a node entrypoint`);
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, match[1])),
      `${scriptName} references missing entrypoint: ${match[1]}`
    );
  }
});

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

test("judgments-generator.js starts as an ESM CLI and prints usage without input", () => {
  const result = runNode(["retrieval/eval/judgments-generator.js"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node judgments-generator\.js/);
  assert.doesNotMatch(result.stderr, /require is not defined|ERR_AMBIGUOUS_MODULE_SYNTAX/);
});

test("check-memory-integrity.js starts as an ESM CLI against STORE_ROOT", () => {
  const storeRoot = makeStoreRoot("ai-memory-integrity-");
  try {
    const result = runNode(["ops/check/check-memory-integrity.js", "--json"], {
      env: {
        AI_MEMORY_STORE: storeRoot,
        AI_MEMORY_STORE_ROOT: "",
        AI_MEMORY_ROOT: "",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /"contractVersion"/);
    assert.doesNotMatch(result.stderr, /ERR_AMBIGUOUS_MODULE_SYNTAX|require is not defined/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("entity-backfill.js starts as an ESM CLI and uses STORE_ROOT paths", () => {
  const storeRoot = makeStoreRoot("ai-memory-entity-backfill-");
  const missingFile = path.join(storeRoot, "structured", "missing.jsonl");
  try {
    const result = runNode(["ops/entity/entity-backfill.js", missingFile], {
      env: {
        AI_MEMORY_STORE: storeRoot,
        AI_MEMORY_STORE_ROOT: "",
        AI_MEMORY_ROOT: "",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /=== Entity Backfill ===/);
    assert.match(result.stdout, new RegExp(storeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stderr, /vault-root-helper-missing|require is not defined/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("entity-backfill.js ingests existing entity data into the store KG", async (t) => {
  try {
    await import("node:sqlite");
  } catch {
    t.skip("node:sqlite is unavailable in this runtime");
    return;
  }

  const storeRoot = makeStoreRoot("ai-memory-entity-backfill-kg-");
  fs.mkdirSync(path.join(storeRoot, "kg"), { recursive: true });
  const jsonlPath = path.join(storeRoot, "structured", "entity-records.jsonl");
  fs.writeFileSync(
    jsonlPath,
    JSON.stringify({
      id: "record-1",
      _entityExtracted: true,
      entities: [{ name: "Alice", type: "person", confidence: 0.9 }],
      facts: [{ subject: "Alice", predicate: "uses", object: "Memory Bus", confidence: 0.95 }],
    }) + "\n",
    "utf8"
  );

  try {
    const result = runNode(["ops/entity/entity-backfill.js", jsonlPath], {
      env: {
        AI_MEMORY_STORE: storeRoot,
        AI_MEMORY_STORE_ROOT: "",
        AI_MEMORY_ROOT: "",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /KG: ingested entities\/facts from 1 records/);
    assert.ok(fs.existsSync(path.join(storeRoot, "kg", "knowledge-graph.sqlite3")));
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("extraction-stress-test.mjs exits cleanly when the optional extraction pipeline is absent", () => {
  const storeRoot = makeStoreRoot("ai-memory-extraction-stress-");
  try {
    const result = runNode(["ops/extract/extraction-stress-test.mjs"], {
      env: {
        AI_MEMORY_STORE: storeRoot,
        AI_MEMORY_STORE_ROOT: "",
        AI_MEMORY_ROOT: "",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /skipped/i);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Fatal:/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("platform adapters treat AI_MEMORY_ROOT as the store root, not a parent", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-platform-root-"));
  const previous = {
    AI_MEMORY_STORE: process.env.AI_MEMORY_STORE,
    AI_MEMORY_STORE_ROOT: process.env.AI_MEMORY_STORE_ROOT,
    AI_MEMORY_ROOT: process.env.AI_MEMORY_ROOT,
  };
  try {
    delete process.env.AI_MEMORY_STORE;
    delete process.env.AI_MEMORY_STORE_ROOT;
    process.env.AI_MEMORY_ROOT = storeRoot;

    const { getWindowsAdapter, getDarwinAdapter, getLinuxAdapter } = await import("../../../bus/platform/index.js");
    for (const getAdapter of [getWindowsAdapter, getDarwinAdapter, getLinuxAdapter]) {
      const adapter = getAdapter();
      assert.equal(adapter.resolveStoreRoot({ refresh: true }), path.resolve(storeRoot));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
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
