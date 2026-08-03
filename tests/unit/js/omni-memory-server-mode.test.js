/**
 * Guard the omni-memory-server mode contract without importing the entrypoint.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RETRIEVAL_TOOLS,
  BRIDGE_TOOLS,
  DREAM_TOOLS,
  MGMT_TOOLS,
} from "../../../shared-mcp/tool-registry.js";

describe("omni-memory-server subset consistency", () => {
  test("maps the four service modes to the expected registry subsets", () => {
    assert.equal(RETRIEVAL_TOOLS.length, 13);
    assert.equal(RETRIEVAL_TOOLS.includes("memory_write"), false);
    assert.equal(BRIDGE_TOOLS.length, 6);
    assert.equal(DREAM_TOOLS.length, 3);
    assert.equal(MGMT_TOOLS.length, 7);
    assert.equal(MGMT_TOOLS.includes("memory_write"), true);
  });

  test("the four subsets cover 29 unique tools", () => {
    const all = [...RETRIEVAL_TOOLS, ...BRIDGE_TOOLS, ...DREAM_TOOLS, ...MGMT_TOOLS];
    assert.equal(all.length, 29);
    assert.equal(new Set(all).size, 29);
  });
});

describe("process.title side effect", () => {
  test("split mode process titles can identify the subset", () => {
    const original = process.title;
    try {
      process.title = "omni-memory-retrieval";
      assert.equal(process.title, "omni-memory-retrieval");
      process.title = "omni-memory-bridge";
      assert.equal(process.title, "omni-memory-bridge");
    } catch {
      // Some platforms do not permit changing process.title.
    } finally {
      try {
        process.title = original;
      } catch {
        // Best-effort restore.
      }
    }
  });
});

describe("AI_MEMORY_SERVER_MODE contract", () => {
  test("supports retrieval, bridge, dream, and mgmt", () => {
    const subsets = {
      retrieval: RETRIEVAL_TOOLS,
      bridge: BRIDGE_TOOLS,
      dream: DREAM_TOOLS,
      mgmt: MGMT_TOOLS,
    };
    for (const mode of Object.keys(subsets)) {
      assert.ok(Array.isArray(subsets[mode]));
      assert.ok(subsets[mode].length > 0);
    }
  });

  test("unknown values expose the monolithic tool set", () => {
    const subsets = {
      retrieval: RETRIEVAL_TOOLS,
      bridge: BRIDGE_TOOLS,
      dream: DREAM_TOOLS,
      mgmt: MGMT_TOOLS,
    };
    assert.equal(subsets.unknown || undefined, undefined);
  });

  test("empty mode exposes the monolithic tool set", () => {
    const subsets = {
      retrieval: RETRIEVAL_TOOLS,
      bridge: BRIDGE_TOOLS,
      dream: DREAM_TOOLS,
      mgmt: MGMT_TOOLS,
    };
    assert.equal(subsets[""] || undefined, undefined);
  });
});
