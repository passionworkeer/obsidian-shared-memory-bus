/**
 * tests/unit/js/inbox-atomic-write-saferoot.test.js
 * ===================================================
 * Tests for the optional `safeRoot` parameter on appendLineAtomic.
 * When safeRoot is provided, the helper must verify the file's realpath
 * is contained within safeRoot before writing. Refuses symlink escapes.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { appendLineAtomic } = await import("../../../ops/inbox/inbox-atomic-write.js");

describe("appendLineAtomic — safeRoot containment", () => {
  let tempDir;
  let projectsDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-saferoot-"));
    projectsDir = path.join(tempDir, "projects");
    fs.mkdirSync(projectsDir);
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("allows writes inside safeRoot", () => {
    const file = path.join(projectsDir, "test.jsonl");
    appendLineAtomic(file, { id: "r1", msg: "ok" }, { safeRoot: projectsDir });
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  test("creates parent dir inside safeRoot and writes there", () => {
    const nestedDir = path.join(projectsDir, "subdir");
    const file = path.join(nestedDir, "x.jsonl");
    appendLineAtomic(file, { id: "r2" }, { safeRoot: projectsDir });
    assert.ok(fs.existsSync(file));
  });

  test("refuses write to path outside safeRoot (sibling dir)", () => {
    const sibling = path.join(tempDir, "sibling");
    fs.mkdirSync(sibling);
    const file = path.join(sibling, "evil.jsonl");
    assert.throws(
      () => appendLineAtomic(file, { id: "r3" }, { safeRoot: projectsDir }),
      /escapes safeRoot/
    );
    assert.ok(!fs.existsSync(file));
  });

  test("refuses write when parent dir escapes via ..", () => {
    // Path that resolves outside projectsDir via ../
    const escape = path.join(projectsDir, "..", "escaped.jsonl");
    assert.throws(
      () => appendLineAtomic(escape, { id: "r4" }, { safeRoot: projectsDir }),
      /escapes safeRoot/
    );
  });

  test("safeRoot is optional — omission preserves legacy behavior", () => {
    const file = path.join(projectsDir, "no-saferoot.jsonl");
    // No safeRoot passed — should not throw on legitimate writes
    appendLineAtomic(file, { id: "r5" });
    assert.ok(fs.existsSync(file));
  });
});
