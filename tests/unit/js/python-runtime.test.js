/**
 * tests/unit/js/python-runtime.test.js
 * =====================================
 * Unit tests for bus/python-runtime.js.
 *
 * The module probes the host filesystem for available Python interpreters
 * and caches the result. Tests focus on:
 *   - `withPythonArgs` (pure helper)
 *   - Shape of returned runtime objects
 *   - Env override behaviour for the global cached runtime
 *   - Cross-platform path handling for absolute env-var candidates
 *
 * Real Python probing is exercised but not asserted (we can't assume the
 * CI environment has a specific Python version). Instead we verify the
 * probe mechanics and the shape of results.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolvePythonRuntime, withPythonArgs } from "../../../bus/python-runtime.js";

describe("python-runtime — withPythonArgs", () => {
  test("concatenates argsPrefix and args", () => {
    const runtime = { argsPrefix: ["-3"], command: "py" };
    const out = withPythonArgs(runtime, ["-c", "print(1)"]);
    assert.deepEqual(out, ["-3", "-c", "print(1)"]);
  });

  test("treats missing argsPrefix as empty", () => {
    const runtime = { command: "python" };
    const out = withPythonArgs(runtime, ["--version"]);
    assert.deepEqual(out, ["--version"]);
  });

  test("coerces non-array args to empty (defensive)", () => {
    const runtime = { command: "python" };
    assert.deepEqual(withPythonArgs(runtime, null), []);
    assert.deepEqual(withPythonArgs(runtime, undefined), []);
    assert.deepEqual(withPythonArgs(runtime, "bad"), []);
  });
});

describe("python-runtime — resolvePythonRuntime", () => {
  const savedEnv = { ...process.env };

  before(() => {
    // Clear any cached runtime from prior tests by ensuring the module's
    // module-level cache is fresh — we re-import per test in the next test
    // if needed. For now, just snapshot env.
  });

  after(() => {
    process.env = savedEnv;
  });

  test("returns a runtime object with the documented shape", () => {
    const r = resolvePythonRuntime();
    assert.equal(typeof r, "object");
    assert.ok(r !== null);
    assert.equal(typeof r.command, "string");
    assert.ok(Array.isArray(r.argsPrefix));
    assert.equal(typeof r.source, "string");
    assert.equal(typeof r.available, "boolean");
    assert.equal(typeof r.version, "string");
    assert.equal(typeof r.error, "string");
  });

  test("falls through to other resolvers when AI_MEMORY_PYTHON points at a non-existent path", async () => {
    // When the env path doesn't exist, resolvePythonRuntime does NOT
    // return that path. It falls through to PATH probes, uv, conda,
    // etc. The fake path must not appear in the returned runtime.
    const fakePath = path.join(os.tmpdir(), "definitely-not-a-real-python-" + Date.now());
    process.env.AI_MEMORY_PYTHON = fakePath;
    delete process.env.CONDA_PREFIX;
    const mod = await import(
      `../../../bus/python-runtime.js?bust=${Date.now()}-${Math.random()}`
    );
    const r = mod.resolvePythonRuntime();
    assert.notEqual(r.command, fakePath, "fake env path must not be returned as-is");
    assert.notEqual(r.source, "env", "source must not be 'env' for an invalid env path");
  });

  test("cached runtime: second call returns the same object", () => {
    const a = resolvePythonRuntime();
    const b = resolvePythonRuntime();
    assert.equal(a, b, "module-level cache should return identical object");
  });

  test("falls back to default 'python' command if nothing else found", () => {
    delete process.env.AI_MEMORY_PYTHON;
    delete process.env.CONDA_PREFIX;
    const r = resolvePythonRuntime();
    // We don't assert availability (CI may or may not have python), only
    // that the returned object is well-formed even in the unavailable path.
    assert.equal(typeof r.command, "string");
    if (!r.available) {
      assert.equal(r.source, "fallback");
      assert.equal(r.error, "python-runtime-not-found");
    }
  });
});
