/**
 * Unit tests for shared-mcp/tool-registry.js.
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
  test("RETRIEVAL_TOOLS has 13 read-only entries", () => {
    assert.equal(RETRIEVAL_TOOLS.length, 13);
    assert.equal(RETRIEVAL_TOOLS.includes("memory_write"), false);
  });

  test("BRIDGE_TOOLS has 6 entries", () => {
    assert.equal(BRIDGE_TOOLS.length, 6);
  });

  test("DREAM_TOOLS has 3 entries", () => {
    assert.equal(DREAM_TOOLS.length, 3);
  });

  test("MGMT_TOOLS has 7 entries including memory_write", () => {
    assert.equal(MGMT_TOOLS.length, 7);
    assert.equal(MGMT_TOOLS.includes("memory_write"), true);
  });

  test("4 subsets cover the complete tool registry", () => {
    const total = RETRIEVAL_TOOLS.length + BRIDGE_TOOLS.length + DREAM_TOOLS.length + MGMT_TOOLS.length;
    assert.equal(total, TOOLS.length);
  });

  test("ALL_TOOLS contains every registered tool", () => {
    const allNames = new Set(ALL_TOOLS);
    const toolNames = new Set(TOOLS.map((tool) => tool.name));
    assert.equal(allNames.size, toolNames.size);
    for (const name of toolNames) {
      assert.ok(allNames.has(name), `${name} must be present in ALL_TOOLS`);
    }
  });

  test("subsets are mutually exclusive", () => {
    const seen = new Map();
    for (const [subsetName, tools] of [
      ["RETRIEVAL", RETRIEVAL_TOOLS],
      ["BRIDGE", BRIDGE_TOOLS],
      ["DREAM", DREAM_TOOLS],
      ["MGMT", MGMT_TOOLS],
    ]) {
      for (const tool of tools) {
        if (seen.has(tool)) {
          assert.fail(`${tool} appears in both ${seen.get(tool)} and ${subsetName}`);
        }
        seen.set(tool, subsetName);
      }
    }
  });

  test("every subset name exists in TOOLS", () => {
    const validNames = new Set(TOOLS.map((tool) => tool.name));
    for (const name of ALL_TOOLS) {
      assert.ok(validNames.has(name), `${name} is missing from TOOLS`);
    }
  });
});

describe("pickTools / pickHandlers", () => {
  test("pickTools(undefined) returns all tools", () => {
    assert.equal(pickTools(undefined).length, TOOLS.length);
  });

  test("pickTools([]) returns all tools", () => {
    assert.equal(pickTools([]).length, TOOLS.length);
  });

  test("pickTools(RETRIEVAL_TOOLS) returns only retrieval tools", () => {
    const result = pickTools(RETRIEVAL_TOOLS);
    assert.equal(result.length, RETRIEVAL_TOOLS.length);
    for (const tool of result) {
      assert.ok(RETRIEVAL_TOOLS.includes(tool.name));
    }
  });

  test("pickTools filters exact names", () => {
    const result = pickTools(["memory_status"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "memory_status");
  });

  test("pickTools returns empty for unknown names", () => {
    assert.equal(pickTools(["missing-tool"]).length, 0);
  });

  test("pickHandlers filters by subset", () => {
    const fakeHandlers = {
      memory_status: () => "a",
      search_shared_memory: () => "b",
      memory_write: () => "c",
    };
    const result = pickHandlers(fakeHandlers, RETRIEVAL_TOOLS);
    assert.ok(result.memory_status);
    assert.ok(result.search_shared_memory);
    assert.equal(result.memory_write, undefined);
  });

  test("pickHandlers(undefined) returns all handlers", () => {
    const fakeHandlers = { a: () => 1, b: () => 2 };
    assert.equal(Object.keys(pickHandlers(fakeHandlers, undefined)).length, 2);
  });
});

describe("SERVER_DEFINITIONS", () => {
  test("ports are unique and cover 9338-9341", () => {
    const ports = Object.values(SERVER_DEFINITIONS).map((definition) => definition.port);
    assert.equal(new Set(ports).size, 4);
    assert.deepEqual([...ports].sort(), [9338, 9339, 9340, 9341]);
  });

  test("server names are unique", () => {
    const names = Object.values(SERVER_DEFINITIONS).map((definition) => definition.serverName);
    assert.equal(new Set(names).size, 4);
  });

  test("definitions reference the expected subsets", () => {
    assert.deepEqual([...SERVER_DEFINITIONS.retrieval.tools], [...RETRIEVAL_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.bridge.tools], [...BRIDGE_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.dream.tools], [...DREAM_TOOLS]);
    assert.deepEqual([...SERVER_DEFINITIONS.mgmt.tools], [...MGMT_TOOLS]);
  });

  test("definitions are frozen", () => {
    assert.ok(Object.isFrozen(SERVER_DEFINITIONS));
    assert.ok(Object.isFrozen(SERVER_DEFINITIONS.retrieval));
  });
});
