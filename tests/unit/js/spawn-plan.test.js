/**
 * spawn-plan.test.js — PR17 commit 7
 *
 * 守护 spawn-plan.js 的决策矩阵:
 *   - 默认 / 'split' / 任何非 monolithic 值 → split 模式,4 条 memory-*
 *   - 'monolithic' / 'all' → 1 条 legacy memory
 *   - selectServersForSpawn 按 plan 过滤 MCP_SERVERS
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveSpawnPlan, selectServersForSpawn } from "../../../shared-mcp/spawn-plan.js";
import { MCP_SERVERS } from "../../../shared-mcp/port-registry.js";

describe("resolveSpawnPlan — 默认 split 模式", () => {
  test("无 env 时默认 split", () => {
    const plan = resolveSpawnPlan({});
    assert.equal(plan.mode, "split");
    assert.equal(plan.entries.length, 4);
  });

  test("env={} 不设 AI_MEMORY_SERVER_MODE 也走 split", () => {
    const plan = resolveSpawnPlan({ OTHER: "value" });
    assert.equal(plan.mode, "split");
  });

  test("显式 'split' 走 split", () => {
    const plan = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "split" });
    assert.equal(plan.mode, "split");
    assert.equal(plan.entries.length, 4);
  });

  test("任何未识别值都降级到 split (安全默认)", () => {
    const plan = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "retrieval-only" });
    assert.equal(plan.mode, "split", "未识别值不应被当成 monolithic");
  });
});

describe("resolveSpawnPlan — monolithic 兼容模式", () => {
  test("'monolithic' 走 monolithic", () => {
    const plan = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "monolithic" });
    assert.equal(plan.mode, "monolithic");
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].id, "memory");
  });

  test("'all' 走 monolithic (向后兼容 stage 1 的 env=alL 含义)", () => {
    const plan = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "all" });
    assert.equal(plan.mode, "monolithic");
    assert.equal(plan.entries[0].env.AI_MEMORY_SERVER_MODE, "all");
  });

  test("大小写不敏感", () => {
    const plan1 = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "MONOLITHIC" });
    const plan2 = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: "  Monolithic  " });
    assert.equal(plan1.mode, "monolithic");
    assert.equal(plan2.mode, "monolithic");
  });
});

describe("resolveSpawnPlan — split entries 完整性", () => {
  test("4 条 entry 的 id 与 port 正确", () => {
    const plan = resolveSpawnPlan({});
    const expected = [
      { id: "memory-retrieval", port: 9338, mode: "retrieval" },
      { id: "memory-bridge",    port: 9339, mode: "bridge" },
      { id: "memory-dream",     port: 9340, mode: "dream" },
      { id: "memory-mgmt",      port: 9341, mode: "mgmt" },
    ];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(plan.entries[i].id, expected[i].id);
      assert.equal(plan.entries[i].port, expected[i].port);
      assert.equal(plan.entries[i].env.AI_MEMORY_SERVER_MODE, expected[i].mode);
      assert.equal(plan.entries[i].env.AI_MEMORY_METRICS_PORT, String(expected[i].port));
    }
  });

  test("split entries 的 args 共享同一份 omni-memory-server.js", () => {
    const plan = resolveSpawnPlan({});
    const argsList = plan.entries.map((e) => e.args.join(" "));
    const unique = new Set(argsList);
    assert.equal(unique.size, 1, "所有 entry 应使用同一份 entry 文件");
    assert.ok(argsList[0].includes("omni-memory-server.js"));
  });
});

describe("selectServersForSpawn — 与 MCP_SERVERS 联动", () => {
  test("split 模式返回 4 条 memory-* (不含 legacy memory)", () => {
    const result = selectServersForSpawn(MCP_SERVERS, {});
    const ids = result.map((s) => s.id);
    assert.deepEqual(ids, ["memory-retrieval", "memory-bridge", "memory-dream", "memory-mgmt"]);
  });

  test("monolithic 模式返回 1 条 legacy memory (含 fetch/time 等其它 server)", () => {
    const result = selectServersForSpawn(MCP_SERVERS, { AI_MEMORY_SERVER_MODE: "monolithic" });
    const memoryIds = result.filter((s) => s.id.startsWith("memory")).map((s) => s.id);
    assert.deepEqual(memoryIds, ["memory"]);
    // legacy entry 保留在 MCP_SERVERS,plan 选了它
    const legacy = MCP_SERVERS.find((s) => s.id === "memory");
    assert.ok(legacy);
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.onlyInMode, "monolithic");
  });

  test("split 与 monolithic 互斥 (同一时间不会同时 spawn)", () => {
    const splitSet = new Set(selectServersForSpawn(MCP_SERVERS, {}).map((s) => s.id));
    const monoSet = new Set(selectServersForSpawn(MCP_SERVERS, { AI_MEMORY_SERVER_MODE: "monolithic" })
      .filter((s) => s.id.startsWith("memory"))
      .map((s) => s.id));
    // 同一 memory-* id 不应同时出现在两组
    for (const id of splitSet) {
      assert.ok(!monoSet.has(id) || id === "memory-retrieval" || id === "memory-bridge" || id === "memory-dream" || id === "memory-mgmt",
        `${id} 不应在 split 与 monolithic 两组都出现`);
    }
  });
});