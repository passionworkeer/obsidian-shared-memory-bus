import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function makeStructuredRecord(overrides = {}) {
  return {
    schemaVersion: 2,
    id: "smoke-record-1",
    t: "2026-05-29T00:00:00.000Z",
    tool: "codex",
    type: "n",
    title: "Smoke record",
    source: "codex",
    scope: "user",
    memory_level: "durable",
    visibility: "shared",
    source_kind: "session",
    content: "Smoke content for store-root verification",
    ...overrides,
  };
}

function writeStructuredStore(record = makeStructuredRecord()) {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-entry-store-"));
  fs.mkdirSync(path.join(storeRoot, "structured"), { recursive: true });
  fs.mkdirSync(path.join(storeRoot, "generated"), { recursive: true });
  fs.mkdirSync(path.join(storeRoot, "embeddings"), { recursive: true });
  fs.writeFileSync(
    path.join(storeRoot, "structured", "shared-inbox.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
  return storeRoot;
}

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

test("check-memory-integrity.js runs as an ESM CLI against AI_MEMORY_STORE", () => {
  const storeRoot = writeStructuredStore();
  try {
    const result = runNode(["ops/check/check-memory-integrity.js", "--json"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_AMBIGUOUS_MODULE_SYNTAX|__dirname is not defined/);
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.status, "string");
    assert.equal(payload.totals.recordCount, 1);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("generate-memory-hygiene-report.js writes under the canonical store generated dir", () => {
  const storeRoot = writeStructuredStore();
  try {
    const result = runNode(["ops/generate/generate-memory-hygiene-report.js", "--json"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_AMBIGUOUS_MODULE_SYNTAX|__dirname is not defined/);
    assert.ok(fs.existsSync(path.join(storeRoot, "generated", "memory_hygiene_report.json")));
    assert.equal(
      fs.existsSync(path.join(storeRoot, "00-System", "ai-memory", "generated", "memory_hygiene_report.json")),
      false
    );
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("entity-backfill.js resolves the project store helper and uses AI_MEMORY_STORE", () => {
  const storeRoot = writeStructuredStore(
    makeStructuredRecord({
      content: "Alice works on MemPalace project with Postgres",
    })
  );
  try {
    const result = runNode(["ops/entity/entity-backfill.js"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /vault-root-helper-missing|ERR_AMBIGUOUS_MODULE_SYNTAX/);
    assert.match(result.stdout, /Store:/);
    const storedRecord = JSON.parse(
      fs.readFileSync(path.join(storeRoot, "structured", "shared-inbox.jsonl"), "utf8").trim()
    );
    assert.equal(storedRecord._entityExtracted, true);
    assert.ok(storedRecord.entities.some((entity) => entity.name === "Alice"));
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("generate-embeddings.js indexes canonical store structured records", () => {
  const storeRoot = writeStructuredStore();
  try {
    const result = runNode(["bus/generate-embeddings.js", "--force"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    const indexPath = path.join(storeRoot, "embeddings", "index.jsonl");
    assert.ok(fs.existsSync(indexPath), "embeddings index should be written under the store root");
    const indexText = fs.readFileSync(indexPath, "utf8");
    assert.match(indexText, /smoke-record-1/);
    assert.equal(
      fs.existsSync(path.join(storeRoot, "00-System", "ai-memory", "embeddings", "index.jsonl")),
      false
    );
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("memory-archival.js scans the canonical structured store", () => {
  const storeRoot = writeStructuredStore(
    makeStructuredRecord({
      id: "archive-candidate-1",
      lifecycle: {
        tier: 4,
        access_count: 0,
        last_access_at: "2025-01-01T00:00:00.000Z",
      },
    })
  );
  try {
    const result = runNode(["ops/memory/memory-archival.js", "--store-root", storeRoot, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Structured directory not found/);
    assert.doesNotMatch(result.stdout, /00-System[\\/]ai-memory/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("memory-promotion-scorer.js reads canonical structured records", () => {
  const storeRoot = writeStructuredStore(
    makeStructuredRecord({
      id: "promote-candidate-1",
      lifecycle: {
        tier: 2,
        access_count: 3,
        last_access_at: "2026-05-29T00:00:00.000Z",
      },
      metadata: {
        promotion: {
          source_confidence: 0.9,
          cross_session_refs: ["s1", "s2"],
        },
      },
    })
  );
  try {
    const result = runNode(["ops/memory/memory-promotion-scorer.js", "--store-root", storeRoot, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Scored 1 promotion candidates/);
    assert.doesNotMatch(result.stdout, /No records found/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("memory-promotion-resolver.js uses canonical structured records for tiebreaking", () => {
  const storeRoot = writeStructuredStore(
    makeStructuredRecord({
      id: "promote-candidate-1",
      lifecycle: {
        tier: 2,
        last_access_at: "2026-05-29T00:00:00.000Z",
      },
    })
  );
  fs.mkdirSync(path.join(storeRoot, ".ai-memory", "queue"), { recursive: true });
  fs.writeFileSync(
    path.join(storeRoot, ".ai-memory", "queue", "promotion-queue.jsonl"),
    `${JSON.stringify({
      id: "promote-candidate-1",
      score: 0.9,
      tier_from: 2,
      tier_to: 3,
      needs_review: false,
      conflicts: [],
      scored_at: "2026-05-29T00:00:00.000Z",
    })}\n`,
    "utf8"
  );
  try {
    const result = runNode(["ops/memory/memory-promotion-resolver.js", "--store-root", storeRoot, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Loaded 1 structured records for tiebreaking/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("verify-atomic-write.js runs as an ESM CLI against the canonical inbox", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-memory-atomic-verify-"));
  try {
    const result = runNode(["ops/verify/verify-atomic-write.js"], {
      env: { AI_MEMORY_STORE: storeRoot },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /__dirname is not defined|Cannot find module/);
    assert.match(result.stdout, /RESULT: PASS/);
    assert.equal(fs.existsSync(path.join(storeRoot, "00-System", "ai-memory", "inbox")), false);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("ai-memory CLI --workspace dry-run forwards AI_MEMORY_STORE", () => {
  const storeRoot = writeStructuredStore();
  try {
    const result = runNode(["cli/ai-memory.js", "--workspace", storeRoot, "check", "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ops[\\/]check[\\/]check-memory-integrity\.js/);
    assert.match(result.stdout, /AI_MEMORY_STORE=/);
    assert.match(result.stdout, new RegExp(storeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("runtime detection scripts avoid machine-specific fallback paths", () => {
  const files = [
    "scripts/store-detect.js",
    "scripts/vault-detect.js",
    "scripts/pressure-test-embedding-pool.js",
    "scripts/env-check.js",
    "scripts/start-all.ps1",
    "scripts/validate-schema-sync.js",
    "scripts/watchdog.ps1",
    "bus/runtime-platform-runtimes.ps1",
    "ops/build/build-handoff-pack.js",
    "ops/check/check-vbs.js",
    "ops/generate/generate-context.js",
    "ops/memory/memory-layers-parse.js",
    "ops/memory/memory-promotion-resolver.js",
    "ops/memory/memory-promotion-scorer.js",
    "retrieval/benchmark-backends.py",
    "retrieval/eval/judgments-generator.js",
    "shared-mcp/omni-memory-server.js",
    "tests/cross-language/lsh_equivalence.test.js",
    "tests/integration/py/search-flow.test.js",
  ];
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    if (/(^|[^A-Za-z])[A-Z]:(?:\\\\|\\|\/)/.test(text)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);
});

test("PowerShell store-root workflows do not nest canonical stores under legacy vault paths", () => {
  const files = [
    "ops/run/run-memory-dream.ps1",
    "bus/memory-watchdog.ps1",
  ];
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    if (/Join-SharedPath @\(\$(?:StoreRoot|VaultRoot), "00-System", "ai-memory"/.test(text)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);

  const memoryBusText = fs.readFileSync(path.join(REPO_ROOT, "bus", "memory-bus.ps1"), "utf8");
  assert.match(memoryBusText, /Test-Path \(Join-Path \$Script:VaultRoot "structured"\)/);
});

test("unit tests do not overwrite production store-root helper files", () => {
  const unitDir = path.join(REPO_ROOT, "tests", "unit", "js");
  const offenders = [];
  for (const name of fs.readdirSync(unitDir)) {
    if (!name.endsWith(".test.js") && !name.endsWith(".test.mjs")) {
      continue;
    }
    const filePath = path.join(unitDir, name);
    const text = fs.readFileSync(filePath, "utf8");
    if (/writeFileSync\([^)]*store-root\.js/s.test(text) || /writeFileSync\(stubStoreRoot/s.test(text)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, []);
});
