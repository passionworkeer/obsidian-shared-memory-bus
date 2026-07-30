// Unit tests for the blackboard Python extraction (Wave 3 / S3).
// Verifies runBlackboardPython invokes the .py file and that the extracted
// script preserves its JSON-over-stdio contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCRIPT_PATH = path.resolve(REPO_ROOT, "shared-mcp/scripts/blackboard_query.py");
const MODULE_SOURCE = fs.readFileSync(
  path.resolve(REPO_ROOT, "shared-mcp/memory-bridge.js"),
  "utf8",
);

const PYTHON_BIN = process.env.PYTHON
  || process.env.AI_MEMORY_PYTHON
  || (process.platform === "win32" ? "python" : "python3");

test("memory-bridge invokes blackboard_query.py by path, not `python -c`", () => {
  assert.match(
    MODULE_SOURCE,
    /withPythonArgs\(\s*PYTHON,\s*\[\s*BLACKBOARD_QUERY_SCRIPT\s*\]\s*\)/,
    "runBlackboardPython must pass the .py path as the only script arg",
  );
  assert.doesNotMatch(
    MODULE_SOURCE,
    /withPythonArgs\(\s*PYTHON,\s*\[\s*"-c"/,
    "runBlackboardPython must no longer use `-c`",
  );
  assert.doesNotMatch(MODULE_SOURCE, /import sqlite3/, "inline sqlite3 import must be gone");
  assert.doesNotMatch(MODULE_SOURCE, /SELECT id, repo, issue_number/, "inline SELECT must be gone");
  assert.doesNotMatch(MODULE_SOURCE, /INSERT INTO tasks/, "inline INSERT must be gone");
});

test("BLACKBOARD_QUERY_SCRIPT resolves to a real .py file under shared-mcp/scripts", () => {
  assert.equal(fs.existsSync(SCRIPT_PATH), true, `expected ${SCRIPT_PATH} to exist`);
  assert.match(
    MODULE_SOURCE,
    /new URL\("\.\/scripts\/blackboard_query\.py", import\.meta\.url\)/,
    "module must resolve the script via new URL() against import.meta.url",
  );
});

test("blackboard_query.py is syntactically valid Python (ast.parse)", () => {
  let out;
  try {
    out = execFileSync(
      PYTHON_BIN,
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", SCRIPT_PATH],
      { encoding: "utf8" },
    );
  } catch (error) {
    assert.fail(`python ast.parse failed: ${error.stderr || error.message}`);
  }
  assert.equal(out, "", "ast.parse produces no stdout on success");
});

test("blackboard_query.py preserves the SELECT/INSERT SQL with ? placeholders", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.match(
    source,
    /SELECT id, repo, issue_number, issue_title, state, assigned_agent,[\s\S]*?updated_at FROM tasks/,
  );
  assert.match(source, /INSERT INTO tasks[\s\S]*?VALUES \(\?, \?, \?, \?, \?\)/);
  assert.match(source, /WHERE state IN \(/);
});

test("blackboard_query.py preserves stdin-JSON-in / single-JSON-line-out contract", () => {
  const databasePath = path.join(os.tmpdir(), `bb-contract-${process.pid}-${Date.now()}.sqlite`);
  execFileSync(
    PYTHON_BIN,
    [
      "-c",
      "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, issue_number INTEGER, issue_title TEXT, state TEXT, assigned_agent TEXT, processor TEXT, updated_at TEXT)'); d.commit(); d.close()",
      databasePath,
    ],
    { encoding: "utf8" },
  );
  try {
    const payload = JSON.stringify({ op: "query", db: databasePath, limit: 5, states: [] });
    const out = execFileSync(PYTHON_BIN, [SCRIPT_PATH], { input: payload, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out.trim()), { ok: true, rows: [] });
  } finally {
    try {
      fs.unlinkSync(databasePath);
    } catch {
    }
  }
});
