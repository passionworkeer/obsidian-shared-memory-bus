/**
 * tests/integration/js/export-md-e2e.test.js
 *
 * End-to-end integration test: write 2 JSONL records to a tmp store,
 * run export-md, verify the .md projection is well-formed and complete.
 *
 * Skipped automatically when the CLI binary can't be invoked (e.g. when
 * running in environments without node on PATH). This is a smoke test, not
 * a unit test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findNode() {
  const candidates = [
    process.env.NODE_BIN,
    "/c/Users/04735/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.16.0-win-x64/node.exe",
    "node",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "node") {
      const r = spawnSync("node", ["--version"]);
      if (r.status === 0) return "node";
    } else if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

test("export-md CLI: writes derived/ from JSONL fixture (E2E)", () => {
  const nodeBin = findNode();
  if (!nodeBin) {
    // Skip gracefully when no node binary is available in the test env.
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "export-md-test-"));
  const structuredDir = path.join(tmpRoot, "structured");
  const derivedDir = path.join(tmpRoot, "derived");
  fs.mkdirSync(structuredDir, { recursive: true });

  // Write 2 records to shared-inbox.jsonl
  const inbox = [
    {
      schemaVersion: 2,
      id: "test-rec-A",
      type: "note",
      scope: "user",
      memory_level: "durable",
      title: "User Prefers Dark Mode",
      tool: "claude",
      source: "claude-code",
      t: "2026-06-25T10:00:00.000Z",
      content: "User likes dark mode everywhere.",
      tags: ["preference", "ui"],
    },
    {
      schemaVersion: 2,
      id: "test-rec-B",
      type: "fact",
      scope: "project",
      memory_level: "session",
      title: "Uses Postgres",
      tool: "codex",
      source: "codex-cli",
      content: "Project uses PostgreSQL 16.",
      tags: ["db"],
    },
  ];
  fs.writeFileSync(
    path.join(structuredDir, "shared-inbox.jsonl"),
    inbox.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  // Invoke the CLI with AI_MEMORY_STORE pointed at our tmp dir.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "ops", "export", "export-md.js");
  const result = spawnSync(nodeBin, [scriptPath, "--source", "shared-inbox"], {
    env: { ...process.env, AI_MEMORY_STORE: tmpRoot },
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(result.status, 0, `CLI exited non-zero: ${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.recordsExported, 2);

  // Verify derived outputs
  assert.ok(fs.existsSync(path.join(derivedDir, "index.md")), "index.md missing");
  assert.ok(fs.existsSync(path.join(derivedDir, "by-scope", "user.md")), "by-scope/user.md missing");
  assert.ok(fs.existsSync(path.join(derivedDir, "by-scope", "project.md")), "by-scope/project.md missing");
  assert.ok(fs.existsSync(path.join(derivedDir, "by-id", "test-rec-A.md")), "by-id/test-rec-A.md missing");
  assert.ok(fs.existsSync(path.join(derivedDir, "by-id", "test-rec-B.md")), "by-id/test-rec-B.md missing");

  // Spot-check content
  const recA = fs.readFileSync(path.join(derivedDir, "by-id", "test-rec-A.md"), "utf8");
  assert.ok(recA.includes('title: "User Prefers Dark Mode"'));
  assert.ok(recA.includes("User likes dark mode everywhere."));
  assert.ok(recA.includes("#preference"));
  assert.ok(recA.includes("#ui"));

  // Index page lists both scopes
  const index = fs.readFileSync(path.join(derivedDir, "index.md"), "utf8");
  assert.ok(index.includes("Total records: **2**"));
  assert.ok(index.includes("`user` (1)"));
  assert.ok(index.includes("`project` (1)"));

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});