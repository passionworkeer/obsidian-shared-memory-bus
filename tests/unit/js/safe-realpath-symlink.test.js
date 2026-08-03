import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeRealpathWithin } from "../../../ops/util/safe-realpath.js";
import { appendLineAtomic } from "../../../ops/inbox/inbox-atomic-write.js";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-safe-root-"));
  const safeRoot = path.join(root, "store");
  const outside = path.join(root, "outside.txt");
  fs.mkdirSync(safeRoot, { recursive: true });
  fs.writeFileSync(outside, "outside-original\n", "utf8");
  return { root, safeRoot, outside };
}

function createFileSymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")) {
      return false;
    }
    throw error;
  }
}

test("existing symlink targets are resolved before containment checks", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const link = path.join(fixture.safeRoot, "linked.jsonl");
  if (!createFileSymlink(fixture.outside, link)) {
    t.skip("file symlinks are unavailable on this platform");
    return;
  }

  assert.equal(safeRealpathWithin(link, fixture.safeRoot), null);
});

test("JSONL append refuses final-component symlinks and preserves the external file", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const link = path.join(fixture.safeRoot, "linked.jsonl");
  if (!createFileSymlink(fixture.outside, link)) {
    t.skip("file symlinks are unavailable on this platform");
    return;
  }

  assert.throws(
    () => appendLineAtomic(link, { injected: true }, { safeRoot: fixture.safeRoot }),
    /refusing|symbolic-link|escapes safeRoot/,
  );
  assert.equal(fs.readFileSync(fixture.outside, "utf8"), "outside-original\n");
});

test("normal files and missing targets inside the root remain valid", (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = path.join(fixture.safeRoot, "normal.jsonl");

  assert.equal(safeRealpathWithin(target, fixture.safeRoot), target);
  appendLineAtomic(target, { ok: true }, { safeRoot: fixture.safeRoot });
  assert.equal(safeRealpathWithin(target, fixture.safeRoot), fs.realpathSync(target));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8").trim()), { ok: true });
});
