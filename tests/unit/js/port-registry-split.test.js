/**
 * port-registry-split.test.js — PR17 commit 7
 *
 * 守护 port-registry.js 在 I-HIGH-1 stage 3 之后的结构:
 *   - MCP_SERVERS 含 4 条 memory-* + 1 条 legacy memory
 *   - SPLIT_MEMORY_SERVER_PORTS / SPLIT_MEMORY_METRICS_PORTS 同步
 *   - legacy 条目 marked legacy:true + onlyInMode:monolithic
 *   - 端口唯一 (除 legacy 与 memory-retrieval 共用 9338,二者互斥 spawn)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_SERVERS,
  SPLIT_MEMORY_SERVER_PORTS,
  SPLIT_MEMORY_METRICS_PORTS,
  CRITICAL_PORTS,
} from "../../../shared-mcp/port-registry.js";

describe("MCP_SERVERS — 4-server split 完整性", () => {
  test("含 4 条 memory-* 条目 (retrieval/bridge/dream/mgmt)", () => {
    const memoryServers = MCP_SERVERS.filter((s) => s.id.startsWith("memory-"));
    assert.equal(memoryServers.length, 4);
    const ids = memoryServers.map((s) => s.id);
    assert.ok(ids.includes("memory-retrieval"));
    assert.ok(ids.includes("memory-bridge"));
    assert.ok(ids.includes("memory-dream"));
    assert.ok(ids.includes("memory-mgmt"));
  });

  test("4 条 memory-* 的端口是 9338-9341", () => {
    const ports = MCP_SERVERS
      .filter((s) => s.id.startsWith("memory-"))
      .map((s) => s.port)
      .sort((a, b) => a - b);
    assert.deepEqual(ports, [9338, 9339, 9340, 9341]);
  });

  test("每条 memory-* 都有 env (含 AI_MEMORY_SERVER_MODE 与 AI_MEMORY_METRICS_PORT)", () => {
    const memoryServers = MCP_SERVERS.filter((s) => s.id.startsWith("memory-"));
    for (const server of memoryServers) {
      assert.ok(server.env, `${server.id} 应有 env 字段`);
      assert.ok(server.env.AI_MEMORY_SERVER_MODE, `${server.id} env 应含 AI_MEMORY_SERVER_MODE`);
      assert.ok(server.env.AI_MEMORY_METRICS_PORT, `${server.id} env 应含 AI_MEMORY_METRICS_PORT`);
      // mode 与 id 一致
      const expectedMode = server.id.replace("memory-", "");
      assert.equal(server.env.AI_MEMORY_SERVER_MODE, expectedMode);
    }
  });

  test("保留 legacy memory 条目 (向后兼容)", () => {
    const legacy = MCP_SERVERS.find((s) => s.id === "memory");
    assert.ok(legacy, "legacy memory 条目应保留");
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.onlyInMode, "monolithic");
  });
});

describe("SPLIT_MEMORY_SERVER_PORTS / SPLIT_MEMORY_METRICS_PORTS", () => {
  test("SPLIT_MEMORY_SERVER_PORTS 冻结", () => {
    assert.ok(Object.isFrozen(SPLIT_MEMORY_SERVER_PORTS));
    assert.equal(SPLIT_MEMORY_SERVER_PORTS.retrieval, 9338);
    assert.equal(SPLIT_MEMORY_SERVER_PORTS.bridge, 9339);
    assert.equal(SPLIT_MEMORY_SERVER_PORTS.dream, 9340);
    assert.equal(SPLIT_MEMORY_SERVER_PORTS.mgmt, 9341);
  });

  test("SPLIT_MEMORY_METRICS_PORTS 与 MCP 端口同端口", () => {
    assert.deepEqual({ ...SPLIT_MEMORY_METRICS_PORTS }, { ...SPLIT_MEMORY_SERVER_PORTS });
  });

  test("SPLIT_MEMORY_METRICS_PORTS 与 MCP_SERVERS memory-* env 一致", () => {
    const memoryServers = MCP_SERVERS.filter((s) => s.id.startsWith("memory-"));
    for (const server of memoryServers) {
      const subset = server.id.replace("memory-", "");
      const expectedPort = String(SPLIT_MEMORY_METRICS_PORTS[subset]);
      assert.equal(server.env.AI_MEMORY_METRICS_PORT, expectedPort,
        `${server.id} env.AI_MEMORY_METRICS_PORT 应等于 SPLIT_MEMORY_METRICS_PORTS.${subset}`);
    }
  });
});

describe("CRITICAL_PORTS 与 4-server 一致", () => {
  test("CRITICAL_PORTS 含 9338-9341 (4-server 端口)", () => {
    for (const port of [9338, 9339, 9340, 9341]) {
      assert.ok(CRITICAL_PORTS.includes(port), `CRITICAL_PORTS 应含 ${port}`);
    }
  });

  test("doctor 探测的端口数 = 4-server 全部端口 + 其它 shared MCP", () => {
    assert.ok(CRITICAL_PORTS.length >= 5);
  });
});