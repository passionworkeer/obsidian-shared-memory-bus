import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnProcess } from "../../../shared-mcp/proto/child-process.mjs";

test("spawnProcess captures normal output and input", async () => {
  const result = await spawnProcess(
    process.execPath,
    [
      "-e",
      "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(data.toUpperCase()));",
    ],
    { input: "hello", timeoutMs: 5000, maxOutputBytes: 1024 },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "HELLO");
  assert.equal(result.stderr, "");
});

test("spawnProcess rejects oversized input before launching useful work", async () => {
  await assert.rejects(
    spawnProcess(process.execPath, ["-e", "process.exit(0)"], {
      input: "x".repeat(2048),
      maxInputBytes: 1024,
    }),
    /input limit exceeded/,
  );
});

test("spawnProcess kills helpers that exceed the combined output cap", async () => {
  await assert.rejects(
    spawnProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(64 * 1024))"],
      { timeoutMs: 5000, maxOutputBytes: 1024 },
    ),
    /output limit exceeded/,
  );
});

test("spawnProcess kills helpers that exceed the timeout", async () => {
  await assert.rejects(
    spawnProcess(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 50, maxOutputBytes: 1024 },
    ),
    /timed out after 50ms/,
  );
});

test("spawnProcess rejects invalid resource limits", async () => {
  await assert.rejects(
    spawnProcess(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 0 }),
    /timeoutMs must be a positive integer/,
  );
  await assert.rejects(
    spawnProcess(process.execPath, ["-e", "process.exit(0)"], { maxOutputBytes: -1 }),
    /maxOutputBytes must be a positive integer/,
  );
});
