/**
 * Unit tests for shared-mcp/tool-registry.js
 *
 * 守护拆分契约:
 *   - 4 个子集名集合的并集 = TOOLS 全集 (29 个)
 *   - 子集之间无重复 (一个工具只能归属一个 server)
 *   - pickTools / pickHandlers 按名过滤正确
 *   - SERVER_DEFINITIONS 4 个 server 的端口唯一
 *
 * Run: node --test tests/unit/js/tool-registry.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { TOOLS } from "../../../shared-mcp/memory-tools.js";
import {
  RETRIEVAL_TOOLS,
  BRIDGE_TOOLS,
  DREAM_TOOLS,
  MGMT_TOOLS,
  ALL_TOOLS,
  SERVER_DEFINITIONS,
  pickTools,
  pickHandlers,
} from "../../../shared-mcp/tool-registry.js";

describe("tool-registry subset coverage", () => {
  test("RETRIEVAL_TOOLS has 14 entries", () => {
    assert.equal(RETRIEVAL_TOOLS.length, 14);
  });

  test("BRIDGE_TOOLS has 6 entries", () => {
    assert.equal(BRIDGE_TOOLS.length, 6);
  });

  test("DREAM_TOOLS has 3 entries", () => {
    assert.equal(DREAM_TOOLS.length, 3);
  });

  test("MGMT_TOOLS has 6 entries", () => {
    assert.equal(MGMT_TOOLS.length, 6);
  });

  test("4 subsets sum to 29 tools (no missing, no extra)", () => {
    const total = RETRIEVAL_TOOLS.length + BRIDGE_TOOLS.length + DREAM_TOOLS.length + MGMT_TOOLS.length;
    assert.equal(total, 29);
    assert.equal(total, TOOLS.length, "TOOLS 全集应有 29 个工具");
  });

  test("ALL_TOOLS = TOOLS (按工具名顺序对齐)", () => {
    const allNames = new Set(ALL_TOOLS);
    const toolNames = new Set(TOOLS.map((t) => t.name));
    assert.equal(allNames.size, toolNames.size);
    for (const name of toolNames) {
      assert.ok(allNames.has(name), `TOOLS 中的 ${name} 应在 ALL_TOOLS 中`);
    }
  });

  test("subsets are mutually exclusive (no tool in 2 servers)", () => {
    const seen = new Map();
    for (const [subsetName, tools] of [
      ["RETRIEVAL", RETRIEVAL_TOOLS],
      ["BRIDGE", BRIDGE_TOOLS],
      ["DREAM", DREAM_TOOLS],
      ["MGMT", MGMT_TOOLS],
    ]) {
      for (const tool of tools) {
        if (seen.has(tool)) {
          assert.fail(`工具 ${tool} 同时出现在 ${seen.get(tool)} 和 ${subsetName}`);
        }
        seen.set(tool, subsetName);
      }
    }
  });

  test("每个 tool 名都在 TOOLS 中实际存在", () => {
    const validNames = new Set(TOOLS.map((t) => t.name));
    for (const name of ALL_TOOLS) {
      assert.ok(validNames.has(name), `子集中的 ${name} 在 TOOLS 中不存在`);
    }
  });
});

describe("pickTools / pickHandlers 过滤逻辑", () => {
  test("pickTools(undefined) 返回完整 TOOLS", () => {
    const result = pickTools(undefined);
    assert.equal(result.length, TOOLS.length);
  });

  test("pickTools([]) 返回完整 TOOLS (与 undefined 等价)", () => {
    const result = pickTools([]);
    assert.equal(result.length, TOOLS.length);
  });

  test("pickTools(RETRIEVAL_TOOLS) 只返回 14 个", () => {
    const result = pickTools(RETRIEVAL_TOOLS);
    assert.equal(result.length, 14);
    for (const tool of result) {
      assert.ok(RETRIEVAL_TOOLS.includes(tool.name));
    }
  });

  test("pickTools(['memory_status']) 返回 1 个", () => {
    const result = pickTools(["memory_status"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "memory_status");
  });

  test("pickTools(['不存在']) 返回 0 个", () => {
    const result = pickTools(["不存在的工具名"]);
    assert.equal(result.length, 0);
  });

  test("pickHandlers 按 names 过滤", () => {
    const fakeHandlers = {
      memory_status: () => "a",
      search_shared_memory: () => "b",
      run_memory_dream: () => "c",
    };
    const result = pickHandlers(fakeHandlers, RETRIEVAL_TOOLS);
    assert.ok(result.memory_status);
    assert.ok(result.search_shared_memory);
    assert.equal(result.run_memory_dream, undefined, "DREAM 工具不应漏到 RETRIEVAL");
  });

  test("pickHandlers(undefined) 返回完整 handler 表", () => {
    const fakeHandlers = { a: () => 1, b: () => 2 };
    const result = pickHandlers(fakeHandlers, undefined);
    assert.equal(Object.keys(result).length, 2);
  });
});

describe("SERVER_DEFINITIONS 元信息", () => {
  test("4 个 server 端口唯一且为 9338-9341", () => {
    const ports = Object.values(SERVER_DEFINITIONS).map((d) => d.port);
    assert.equal(ports.length, 4);
    assert.equal(new Set(ports).size, 4, "端口应全部唯一");
    assert.deepEqual([...ports].sort(), [9338, 9339, 9340, 9341]);
  });

  test("4 个 serverName 唯一", () => {
    const names = Object.values(SERVER_DEFINITIONS).map((d) => d.serverName);
    assert.equal(new Set(names).size, 4);
  });

  test("每个 SERVER_DEFINITION 的 tools 与对应子集一致", () => {
    assert.deepEqual([...SERVER_DEFINITIONS.retrieval.tools], [...RETRIEVAL_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.bridge.tools], [...BRIDGE_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.dream.tools], [...DREAM_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.mgmt.tools], [...MGMT_TOOLS]);
  });

  test("SERVER_DEFINITIONS 是冻结的 (防止运行时篡改)", () => {
    assert.ok(Object.isFrozen(SERVER_DEFINITIONS));
    assert.ok(Object.isFrozen(SERVER_DEFINITIONS.retrieval));
  });
});
