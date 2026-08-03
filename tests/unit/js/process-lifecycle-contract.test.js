import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const architecture = fs.readFileSync(
  path.join(root, "docs", "architecture", "SERVER-SPLIT.md"),
  "utf8",
);

describe("production process lifecycle contract", () => {
  test("keeps the active launcher and proxy lifecycle modules", () => {
    assert.equal(exists("start.js"), true);
    assert.equal(exists("shared-mcp/singleton-stdio-mcp-proxy.mjs"), true);
    assert.equal(exists("shared-mcp/proto/child-process.mjs"), true);
    assert.equal(exists("shared-mcp/proto/restart.mjs"), true);
  });

  test("does not retain the unused second manager", () => {
    assert.equal(exists("shared-mcp/mcp-process-manager.js"), false);
    assert.equal(exists("tests/unit/js/mcp-process-manager.test.js"), false);
  });

  test("documents lifecycle ownership and failure behavior", () => {
    assert.match(architecture, /exactly one production lifecycle chain/i);
    assert.ok(architecture.includes("start.js"));
    assert.ok(architecture.includes("singleton-stdio-mcp-proxy.mjs"));
    assert.ok(architecture.includes("proto/restart.mjs"));
    assert.match(architecture, /Unknown or unhealthy occupants cause startup to fail/);
    assert.match(architecture, /graceful teardown/i);
  });
});
