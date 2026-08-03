import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "release.yml"),
  "utf8",
);

test("release workflow requires the tag commit to be reachable from main", () => {
  assert.match(workflow, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/);
});

test("checkout credentials are not persisted into release build steps", () => {
  assert.match(workflow, /persist-credentials:\s*false/);
});

test("release still verifies the tag against package version", () => {
  assert.match(workflow, /GITHUB_REF_NAME/);
  assert.match(workflow, /package\.json/);
});
