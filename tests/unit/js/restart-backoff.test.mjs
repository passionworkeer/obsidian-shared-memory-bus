// Unit tests for shared-mcp/proto/restart.mjs — exponential backoff + cap.
// Also covers the child-process.mjs shouldRestart contract test seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const {
  computeBackoffDelay,
  computeBaseDelay,
  shouldRestart,
  DEFAULT_BACKOFF,
  getAttemptCount,
  resetAttemptCount,
} = await import(
  pathToFileURL(path.join(REPO_ROOT, "shared-mcp/proto/restart.mjs")).href
);

// ----- computeBaseDelay -----

test("computeBaseDelay returns baseDelay at attempt 0", () => {
  assert.equal(computeBaseDelay(0), DEFAULT_BACKOFF.baseDelay);
});

test("computeBaseDelay grows exponentially with attempt (monotonic, deterministic)", () => {
  const d0 = computeBaseDelay(0);
  const d1 = computeBaseDelay(1);
  const d2 = computeBaseDelay(2);
  const d3 = computeBaseDelay(3);
  assert.equal(d1, d0 * 2, "attempt 1 doubles");
  assert.equal(d2, d0 * 4, "attempt 2 quadruples");
  assert.equal(d3, d0 * 8, "attempt 3 octuples");
  assert.ok(d3 > d2 && d2 > d1 && d1 > d0, "monotonic increase");
});

test("computeBaseDelay caps at maxDelay for large attempts", () => {
  const cap = DEFAULT_BACKOFF.maxDelay;
  assert.equal(computeBaseDelay(20), cap, "very large attempt clamps to cap");
  assert.equal(computeBaseDelay(100), cap);
  // Find the exact attempt where it first hits the cap (2^a * baseDelay >= cap).
  // baseDelay=500, cap=30000 → 2^a * 500 >= 30000 → 2^a >= 60 → a >= 6 (2^6=64, 64*500=32000>30000)
  assert.equal(computeBaseDelay(5), 500 * 32, "attempt 5 = 16000ms (still under cap)");
  assert.equal(computeBaseDelay(6), cap, "attempt 6 first hits cap");
});

// ----- computeBackoffDelay (with jitter) -----

test("computeBackoffDelay with zero jitter equals baseDelay", () => {
  const opts = { ...DEFAULT_BACKOFF, jitter: 0 };
  assert.equal(computeBackoffDelay(0, opts), DEFAULT_BACKOFF.baseDelay);
  assert.equal(computeBackoffDelay(3, opts), DEFAULT_BACKOFF.baseDelay * 8);
});

test("computeBackoffDelay adds bounded jitter", () => {
  // jitterFn that always returns 1.0 → max jitter added.
  const opts = { ...DEFAULT_BACKOFF, jitter: 250 };
  const full = computeBackoffDelay(0, opts, () => 1);
  const none = computeBackoffDelay(0, opts, () => 0);
  assert.equal(none, DEFAULT_BACKOFF.baseDelay, "jitter=0 → baseDelay");
  assert.equal(full, DEFAULT_BACKOFF.baseDelay + 250, "jitter=1.0 → +250ms");
  // In the wild, random() ∈ [0,1) so delay ∈ [base, base+250).
  for (let i = 0; i < 50; i++) {
    const d = computeBackoffDelay(0, opts);
    assert.ok(d >= DEFAULT_BACKOFF.baseDelay, "jittered delay never below base");
    assert.ok(d < DEFAULT_BACKOFF.baseDelay + 250, "jittered delay strictly below base+jitter");
  }
});

test("computeBackoffDelay respects custom jitterFn for determinism", () => {
  const opts = { ...DEFAULT_BACKOFF, jitter: 1000 };
  // A jitterFn returning 0.5 should add exactly 500ms.
  const d = computeBackoffDelay(2, opts, () => 0.5);
  assert.equal(d, DEFAULT_BACKOFF.baseDelay * 4 + 500);
});

// ----- shouldRestart (max-attempts cap) -----

test("shouldRestart permits restarts up to maxAttempts-1", () => {
  for (let i = 0; i < DEFAULT_BACKOFF.maxAttempts; i++) {
    assert.equal(shouldRestart(i), true, `attempt ${i} allowed`);
  }
});

test("shouldRestart denies restart at maxAttempts and beyond", () => {
  assert.equal(shouldRestart(DEFAULT_BACKOFF.maxAttempts), false);
  assert.equal(shouldRestart(DEFAULT_BACKOFF.maxAttempts + 5), false);
});

test("shouldRestart honors custom maxAttempts opts", () => {
  assert.equal(shouldRestart(2, { ...DEFAULT_BACKOFF, maxAttempts: 3 }), true);
  assert.equal(shouldRestart(3, { ...DEFAULT_BACKOFF, maxAttempts: 3 }), false);
});

// ----- attempt counter (module state, observable) -----

test("attempt counter starts at 0 and can be reset", () => {
  resetAttemptCount();
  assert.equal(getAttemptCount(), 0);
  // We don't call scheduleRestart here (it sets real timers); we only verify
  // the exported counter primitives.
  resetAttemptCount();
  assert.equal(getAttemptCount(), 0);
});

// ----- DEFAULT_BACKOFF shape -----

test("DEFAULT_BACKOFF exposes expected tunables", () => {
  assert.equal(typeof DEFAULT_BACKOFF.baseDelay, "number");
  assert.equal(typeof DEFAULT_BACKOFF.maxDelay, "number");
  assert.equal(typeof DEFAULT_BACKOFF.jitter, "number");
  assert.equal(typeof DEFAULT_BACKOFF.maxAttempts, "number");
  assert.ok(DEFAULT_BACKOFF.baseDelay > 0);
  assert.ok(DEFAULT_BACKOFF.maxDelay >= DEFAULT_BACKOFF.baseDelay);
  assert.ok(DEFAULT_BACKOFF.maxAttempts > 0);
});

// ----- child-process.mjs contract: shouldRestart seam -----

const cp = await import(
  pathToFileURL(path.join(REPO_ROOT, "shared-mcp/proto/child-process.mjs")).href
);

test("child-process.mjs exports the expected public surface", () => {
  // Contract: these names must exist and be functions (or appropriate shape).
  assert.equal(typeof cp.shouldRestart, "function", "shouldRestart is exported");
  assert.equal(typeof cp.handleChildExit, "function", "handleChildExit is exported");
  assert.equal(typeof cp.killTree, "function", "killTree is exported");
  assert.equal(typeof cp.teardownChild, "function", "teardownChild is exported");
  assert.equal(typeof cp.spawnChildProcess, "function", "spawnChildProcess is exported");
  assert.equal(typeof cp.bootstrapChild, "function", "bootstrapChild is exported");
});

test("child-process.mjs shouldRestart returns true for any exit (current policy)", () => {
  // The current policy treats every child exit as restart-eligible; the cap
  // lives in restart.mjs. If/when policy changes (e.g. skip on clean SIGTERM),
  // this test must be updated alongside shouldRestart.
  assert.equal(cp.shouldRestart(0), true, "clean exit code 0 still restarts");
  assert.equal(cp.shouldRestart(1), true, "non-zero exit restarts");
  assert.equal(cp.shouldRestart(null), true, "null exit restarts");
  assert.equal(cp.shouldRestart(0, "SIGTERM"), true, "with signal arg");
});
