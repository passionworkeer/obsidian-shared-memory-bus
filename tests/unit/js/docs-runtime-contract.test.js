import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_TOOLS } from "../../../shared-mcp/tool-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "../../..");
const apiReference = fs.readFileSync(
  path.join(repositoryRoot, "docs", "guides", "API_REFERENCE.md"),
  "utf8",
);
const installGuide = fs.readFileSync(
  path.join(repositoryRoot, "docs", "guides", "INSTALL.md"),
  "utf8",
);

describe("runtime documentation contract", () => {
  test("API reference contains every registered MCP tool", () => {
    for (const tool of ALL_TOOLS) {
      assert.match(apiReference, new RegExp(`\\\`${tool}\\\``), `${tool} must be documented`);
    }
  });

  test("API reference does not advertise removed tools", () => {
    assert.equal(apiReference.includes("`memory_inbox`"), false);
  });

  test("documents all four split memory endpoints", () => {
    for (const port of [9338, 9339, 9340, 9341]) {
      assert.ok(apiReference.includes(`127.0.0.1:${port}/mcp`));
    }
    assert.ok(installGuide.includes("memory-retrieval"));
    assert.ok(installGuide.includes("memory-mgmt"));
  });

  test("documents immutable templates and environment-backed secrets", () => {
    assert.match(apiReference, /templates\/config\/runtime\.json.*read-only/s);
    assert.match(installGuide, /Do not add `apiKey` to `runtime\.json`/);
    assert.ok(installGuide.includes("apiKeyEnv"));
  });

  test("documents the correct wake-up parameter and write endpoint", () => {
    assert.ok(apiReference.includes('memory_wake_up` accepts `workspace_root`'));
    assert.ok(apiReference.includes("management service — 9341"));
    assert.ok(installGuide.includes('memory_wake_up(workspace_root='));
  });
});
