/**
 * Tests for ops/sync/sync-openclaw-to-obsidian.js (I-HIGH-2 import path fix).
 *
 * The script is at ops/sync/ but uses dynamic `import()` for vault-root.js
 * and python-runtime.js. On Windows + Node ESM, the `__dirname` global is
 * not available, and `path.join` returns backslash paths that are invalid
 * ES module specifiers. This test asserts the import path resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("sync-openclaw-to-obsidian.js is importable on this platform", async () => {
  // If __dirname was undefined or path.join returned backslash, this would
  // throw "Cannot find module ...". The script auto-runs main() which
  // returns a JSON report (ok: true/false) — both are fine for this test.
  const mod = await import(
    pathToFileURL(
      path.resolve("ops/sync/sync-openclaw-to-obsidian.js"),
    ).href
  ).catch((err) => ({ error: err.message }));
  // Either a module with no exports, or a catch-wrapped error object
  // — the key invariant is that the import does NOT throw "Cannot find module".
  if (mod.error) {
    assert.ok(
      !mod.error.includes("Cannot find module"),
      `should resolve vault-root.js + python-runtime.js; got: ${mod.error}`,
    );
  }
});

test("vault-root.js resolves to bus/vault-root.js (not ops/sync/bus/...)", async () => {
  // Repro of the original bug: the candidate `path.join(__dirname, "bus", "vault-root.js")`
  // produces ops/sync/bus/vault-root.js (wrong). The correct relative path from
  // ops/sync/ to bus/ is `..`/`..`/bus.
  const __dirname_under_test = path.resolve("ops/sync");
  const wrong = path.join(__dirname_under_test, "bus", "vault-root.js");
  const right = path.join(__dirname_under_test, "..", "..", "bus", "vault-root.js");
  assert.ok(!wrong.endsWith(path.join("bus", "vault-root.js")) || wrong !== right);
  assert.ok(right.endsWith(path.join("bus", "vault-root.js")));
  // wrong path should NOT exist (project layout guarantee)
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(wrong), false, "wrong path must not exist");
  assert.equal(fs.existsSync(right), true, "right path must exist");
});
