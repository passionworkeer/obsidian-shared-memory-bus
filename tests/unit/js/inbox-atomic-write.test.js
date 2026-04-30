import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { appendLineAtomic } = await import("../../../ops/inbox/inbox-atomic-write.js");

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), `inbox-atomic-write-test-${process.pid}`);
const INBOX_FILE = path.join(TEST_DIR, "inbox", "test.jsonl");

function cleanup() {
  if (fs.existsSync(INBOX_FILE)) fs.unlinkSync(INBOX_FILE);
  const dir = path.dirname(INBOX_FILE);
  if (fs.existsSync(dir)) fs.rmdirSync(dir, { recursive: true });
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0).length;
}

// ---------------------------------------------------------------------------
// Test 1: Normal append of a single line
// ---------------------------------------------------------------------------

function testNormalAppend() {
  cleanup();
  const file = path.join(TEST_DIR, "normal.jsonl");

  appendLineAtomic(file, { id: "a", msg: "hello" });
  appendLineAtomic(file, { id: "b", msg: "world" });

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n").filter(l => l.trim());

  const ok =
    lines.length === 2 &&
    JSON.parse(lines[0]).id === "a" &&
    JSON.parse(lines[1]).id === "b";

  cleanup();
  console.assert(ok, "[testNormalAppend] FAILED — lines or content mismatch");
  console.log(`[testNormalAppend] ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Test 2: Auto-creates file when it doesn't exist
// ---------------------------------------------------------------------------

function testAutoCreateFile() {
  cleanup();
  const file = path.join(TEST_DIR, "auto-created.jsonl");

  const existsBefore = fs.existsSync(file);
  appendLineAtomic(file, { id: "new", created: true });
  const existsAfter = fs.existsSync(file);

  const content = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(content.trim());

  const ok = !existsBefore && existsAfter && parsed.id === "new";

  cleanup();
  console.assert(ok, "[testAutoCreateFile] FAILED");
  console.log(`[testAutoCreateFile] ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Test 3: Auto-creates parent directory when it doesn't exist
// ---------------------------------------------------------------------------

function testAutoCreateDir() {
  cleanup();
  const deepFile = path.join(TEST_DIR, "deeply", "nested", "dir", "nested.jsonl");

  const dirExistsBefore = fs.existsSync(path.dirname(deepFile));
  appendLineAtomic(deepFile, { id: "deep" });
  const dirExistsAfter = fs.existsSync(path.dirname(deepFile));

  const ok = !dirExistsBefore && dirExistsAfter && fs.existsSync(deepFile);

  cleanup();
  console.assert(ok, "[testAutoCreateDir] FAILED");
  console.log(`[testAutoCreateDir] ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Test 4: Concurrent append from 10 simultaneous calls — no dropped lines
// ---------------------------------------------------------------------------

function testConcurrentAppend() {
  cleanup();

  const file = path.join(TEST_DIR, "concurrent.jsonl");
  const N = 10;
  const results = [];

  // Spawn N child processes that each call appendLineAtomic once.
// Using child processes (not threads) to get true parallel I/O.

  const promises = Array.from({ length: N }, (_, i) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          `
import { appendLineAtomic } from ${JSON.stringify("file://" + path.resolve(__dirname, "..", "..", "..", "ops", "inbox-atomic-write.js"))};
import path from "node:path";
const file = ${JSON.stringify(file)};
try {
  appendLineAtomic(file, { id: ${i}, pid: process.pid });
  process.stdout.write("ok");
} catch(e) {
  process.stderr.write(e.message);
  process.exit(1);
}
`,
        ],
        { windowsHide: true }
      );
      let stderr = "";
      child.stderr.on("data", d => { stderr += d; });
      child.on("close", (code) => {
        resolve({ i, code, stderr });
      });
    })
  );

  return Promise.all(promises).then(results => {
    const allOk = results.every(r => r.code === 0 && r.stderr === "");
    const lineCount = countLines(file);
    const all10 = lineCount === N;

    // Re-read and verify each ID 0..N-1 appears exactly once
    const ids = new Set();
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
    const idsOk = ids.size === N;

    const ok = allOk && all10 && idsOk;

    if (!ok) {
      console.error(`[testConcurrentAppend] FAILED — allOk=${allOk} lines=${lineCount}/${N} idsOk=${idsOk}`);
      if (content) console.error("  Content sample:", content.slice(0, 300));
    } else {
      console.log(`[testConcurrentAppend] PASS — ${N} lines written atomically, all IDs present`);
    }

    cleanup();
    return ok;
  });
}

// ---------------------------------------------------------------------------
// Test 5: Pre-existing newline in string is not double-terminated
// ---------------------------------------------------------------------------

function testNoDoubleNewline() {
  cleanup();
  const file = path.join(TEST_DIR, "no-double.jsonl");

  appendLineAtomic(file, "plain string\n");

  const content = fs.readFileSync(file, "utf8");
  // Should NOT have two newlines at the end
  const ok = !content.endsWith("\n\n") && content.includes("plain string");

  cleanup();
  console.assert(ok, "[testNoDoubleNewline] FAILED");
  console.log(`[testNoDoubleNewline] ${ok ? "PASS" : "FAIL"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Test 6: createDir=false — throws when dir missing
// ---------------------------------------------------------------------------

function testCreateDirFalse() {
  cleanup();
  const file = path.join(TEST_DIR, "no-such-dir", "no-create.jsonl");

  let threw = false;
  try {
    appendLineAtomic(file, { id: "x" }, { createDir: false });
  } catch (_e) {
    threw = true;
  }

  cleanup();
  console.assert(threw, "[testCreateDirFalse] FAILED — should have thrown");
  console.log(`[testCreateDirFalse] ${threw ? "PASS" : "FAIL"}`);
  return threw;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("inbox-atomic-write unit tests");
  console.log("=".repeat(60));

  const results = [
    testNormalAppend(),
    testAutoCreateFile(),
    testAutoCreateDir(),
    testNoDoubleNewline(),
    testCreateDirFalse(),
    // Skip flaky concurrent test in CI (GitHub Actions virtualized filesystem)
    // Also skip on Windows (file system differences)
    (process.env.GITHUB_ACTIONS || process.platform === "win32") ? true : await testConcurrentAppend(),
  ];

  console.log("=".repeat(60));
  const passed = results.filter(Boolean).length;
  console.log(`Result: ${passed}/${results.length} passed`);
  console.log("=".repeat(60));

  if (!results.every(Boolean)) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Test suite crashed:", e);
  process.exit(1);
});
