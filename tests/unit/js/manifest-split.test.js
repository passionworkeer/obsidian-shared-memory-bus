/**
 * manifest-split.test.js — PR17 commit 7
 *
 * 守护 manifest.json 在 I-HIGH-1 stage 3 之后的结构:
 *   - 4 条 memory-* server (retrieval/bridge/dream/mgmt)
 *   - 1 条 legacy memory (向后兼容)
 *   - 每条 memory-* 有 stdioEnv 含 AI_MEMORY_SERVER_MODE + AI_MEMORY_METRICS_PORT
 *   - isolatedSubprocess 只挂 memory-retrieval (search-worker 隔离)
 *   - 端口唯一 (除 legacy 与 memory-retrieval 共用 9338,二者互斥)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "../../../shared-mcp/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

describe("manifest.json — 4-server split 完整性", () => {
  test("含 4 条 memory-* server 条目", () => {
    const memoryServers = manifest.servers.filter((s) => s.id.startsWith("memory-"));
    assert.equal(memoryServers.length, 4);
    const ids = memoryServers.map((s) => s.id);
    assert.deepEqual(ids, ["memory-retrieval", "memory-bridge", "memory-dream", "memory-mgmt"]);
  });

  test("4 条 memory-* 端口唯一且对应 9338-9341", () => {
    const memoryServers = manifest.servers.filter((s) => s.id.startsWith("memory-"));
    const ports = memoryServers.map((s) => s.port).sort((a, b) => a - b);
    assert.deepEqual(ports, [9338, 9339, 9340, 9341]);
  });

  test("每条 memory-* 都有 stdioEnv 含 mode 与 metrics port", () => {
    const memoryServers = manifest.servers.filter((s) => s.id.startsWith("memory-"));
    for (const server of memoryServers) {
      assert.ok(server.stdioEnv, `${server.id} 应有 stdioEnv`);
      assert.ok(server.stdioEnv.AI_MEMORY_SERVER_MODE, `${server.id} stdioEnv 应含 AI_MEMORY_SERVER_MODE`);
      assert.ok(server.stdioEnv.AI_MEMORY_METRICS_PORT, `${server.id} stdioEnv 应含 AI_MEMORY_METRICS_PORT`);
      const expectedMode = server.id.replace("memory-", "");
      assert.equal(server.stdioEnv.AI_MEMORY_SERVER_MODE, expectedMode);
      assert.equal(server.stdioEnv.AI_MEMORY_METRICS_PORT, String(server.port));
    }
  });

  test("isolatedSubprocess (search-worker) 只挂 memory-retrieval", () => {
    const retrieval = manifest.servers.find((s) => s.id === "memory-retrieval");
    assert.ok(retrieval.isolatedSubprocess, "memory-retrieval 应有 isolatedSubprocess");
    assert.equal(retrieval.isolatedSubprocess.managedBy, "memory-retrieval");

    const otherSubsets = ["memory-bridge", "memory-dream", "memory-mgmt"];
    for (const id of otherSubsets) {
      const server = manifest.servers.find((s) => s.id === id);
      assert.ok(!server.isolatedSubprocess, `${id} 不应有 isolatedSubprocess (避免重复启 search-worker)`);
    }
  });

  test("isolatedSubprocess 包含完整 restartPolicy", () => {
    const retrieval = manifest.servers.find((s) => s.id === "memory-retrieval");
    assert.equal(retrieval.isolatedSubprocess.restartPolicy, "always");
    assert.equal(retrieval.isolatedSubprocess.maxRestarts, 5);
    assert.equal(retrieval.isolatedSubprocess.circuitWindowMs, 300000);
  });
});

describe("manifest.json — legacy memory 向后兼容", () => {
  test("保留 legacy memory 条目", () => {
    const legacy = manifest.servers.find((s) => s.id === "memory");
    assert.ok(legacy, "legacy memory 条目应保留");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.port, 9338);
  });

  test("legacy memory 的 stdioEnv 是 AI_MEMORY_SERVER_MODE=all", () => {
    const legacy = manifest.servers.find((s) => s.id === "memory");
    assert.equal(legacy.stdioEnv.AI_MEMORY_SERVER_MODE, "all");
    assert.equal(legacy.stdioEnv.AI_MEMORY_METRICS_PORT, "9338");
  });
});

describe("manifest.json — 整体 server 数与端口分布", () => {
  test("server 数 = 13 (4 memory-* + 1 legacy memory + 8 others)", () => {
    // 原 9 个 + 拆 1 memory 为 4 + 加 1 legacy = 13
    assert.equal(manifest.servers.length, 13);
  });

  test("所有 server 的端口与 mode 仍合法", () => {
    for (const server of manifest.servers) {
      if (server.id === "pencil") {
        // pencil 是 isolated mode,无端口
        assert.equal(server.mode, "isolated");
        continue;
      }
      assert.ok(typeof server.port === "number", `${server.id} 应有 port`);
      assert.ok(server.port > 0, `${server.id} port 应 > 0`);
    }
  });
});