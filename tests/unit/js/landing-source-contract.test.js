import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const webReadme = fs.readFileSync(path.join(root, "web", "README.md"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "landing.yml"), "utf8");
const webPackage = JSON.parse(fs.readFileSync(path.join(root, "web", "package.json"), "utf8"));

describe("landing source contract", () => {
  test("keeps React/Vite as the only committed landing implementation", () => {
    assert.equal(fs.existsSync(path.join(root, "web", "src")), true);
    assert.equal(fs.existsSync(path.join(root, "docs", "landing", "index.html")), false);
    assert.equal(fs.existsSync(path.join(root, "web", "legacy-html", "index.html")), false);
  });

  test("uses locked reproducible build commands", () => {
    assert.equal(webPackage.scripts.build, "vite build");
    assert.equal(webPackage.scripts["check:build"], "node scripts/check-build.mjs");
    assert.equal(webPackage.scripts["build:check"], "npm run build && npm run check:build");
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /npm run build:check/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
  });

  test("documents dist as generated, uncommitted deployment output", () => {
    assert.match(webReadme, /唯一内容源/);
    assert.match(webReadme, /dist\/.*生成物/s);
    assert.match(webReadme, /不要重新创建手工维护的 HTML 副本/);
  });
});
