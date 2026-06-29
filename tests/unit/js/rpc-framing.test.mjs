// Unit tests for shared-mcp/proto/rpc.mjs — framing, inflight bounds, oversized body.
// Covers paths that previously had zero tests:
//   1. Half-packet reassembly in processChildStdout.
//   2. Oversized-body rejection in readJsonBody (10 MiB cap).
//   3. Malformed-JSON stdout logging without crashing.
//   4. Bounded pendingRequests (MAX_INFLIGHT) overflow rejection.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const rpc = await import(
  pathToFileURL(path.join(REPO_ROOT, "shared-mcp/proto/rpc.mjs")).href
);

const {
  defaultProtocolVersion,
  pendingRequests,
  MAX_INFLIGHT,
  sendRawRequest,
  handleChildMessage,
  processChildStdout,
  readJsonBody,
  rejectAllPending,
  setChild,
  setChildBuffer,
  setActiveInflight,
} = rpc;

// --- helpers --------------------------------------------------------------

function makeFakeChild() {
  const stdin = { write: () => true };
  return { stdin, killed: false };
}

async function resetRpcState() {
  // Clear any pending inflight + counter so tests are isolated.
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("test reset"));
  }
  pendingRequests.clear();
  setActiveInflight(0);
  setChildBuffer("");
}

// Capture stderr/stdout to assert logging without polluting test output.
function captureConsoleError(fn) {
  const original = console.error;
  const messages = [];
  console.error = (msg) => messages.push(String(msg));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return messages;
}

// --- tests ----------------------------------------------------------------

test("protocolVersion is sourced from manifest.json (no longer a hardcoded literal alone)", () => {
  // The manifest ships protocolVersion "2024-11-05". If manifest is the single
  // source, defaultProtocolVersion should equal that value when no CLI arg is set.
  assert.equal(defaultProtocolVersion, "2024-11-05");
});

test("processChildStdout reassembles a JSON message split across two chunks", async () => {
  await resetRpcStateStateCompat();
  setChildBuffer("");

  // First chunk: half a JSON line, no trailing newline yet.
  const message = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  const half = Math.floor(message.length / 2);
  const firstPart = message.slice(0, half);
  const secondPart = message.slice(half) + "\n";

  let resolved = null;
  // Pre-register a pending request so handleChildMessage can resolve it.
  pendingRequests.set("7", {
    resolve: (m) => { resolved = m; },
    reject: () => {},
    timeout: null,
  });

  processChildStdout(Buffer.from(firstPart, "utf8"));
  assert.equal(resolved, null, "partial line must not be parsed yet");
  processChildStdout(Buffer.from(secondPart, "utf8"));

  assert.equal(resolved?.id, 7, "reassembled message resolves the pending request");
  assert.deepEqual(resolved?.result, { ok: true });
  pendingRequests.delete("7");
});

test("processChildStdout logs non-JSON stdout without crashing", () => {
  setChildBuffer("");
  const errs = captureConsoleError(() => {
    processChildStdout(Buffer.from("this is not json\n", "utf8"));
  });
  assert.ok(
    errs.some((m) => m.includes("non-JSON stdout")),
    `expected non-JSON stdout log, got: ${JSON.stringify(errs)}`,
  );
});

test("readJsonBody rejects an 11 MiB body instead of buffering it fully", async () => {
  const req = new Readable({ read() {} });
  // Push a header-ish chunk that already exceeds the 10 MiB cap, then end.
  // The implementation must destroy + reject on the data handler.
  const elevenMiB = Buffer.alloc(11 * 1024 * 1024, 0x61); // 'a'
  process.nextTick(() => {
    req.push(elevenMiB);
    req.push(null);
  });
  await assert.rejects(
    () => readJsonBody(req),
    /request body too large/,
  );
});

test("sendRawRequest rejects with inflight-limit error when MAX_INFLIGHT is reached", async () => {
  await resetRpcState();
  setChild(makeFakeChild());

  // Pre-fill the pending map to the cap without touching real subprocess I/O.
  for (let i = 0; i < MAX_INFLIGHT; i += 1) {
    pendingRequests.set(`cap-${i}`, {
      resolve: () => {},
      reject: () => {},
      timeout: null,
    });
  }
  setActiveInflight(MAX_INFLIGHT);

  // Sanity: state is full.
  assert.equal(pendingRequests.size, MAX_INFLIGHT);

  await assert.rejects(
    () => sendRawRequest({ jsonrpc: "2.0", id: 9999, method: "ping" }),
    new RegExp(`RPC inflight limit exceeded \\(max ${MAX_INFLIGHT}\\)`),
  );

  // Overflow must NOT have added to the map.
  assert.equal(pendingRequests.size, MAX_INFLIGHT);
  assert.ok(!pendingRequests.has("9999"));

  await resetRpcState();
  setChild(null);
});

test("handleChildMessage decrements activeInflight on resolve", async () => {
  await resetRpcState();
  setActiveInflight(2);

  let resolved;
  pendingRequests.set("42", {
    resolve: (m) => { resolved = m; },
    reject: () => {},
    timeout: null,
  });

  handleChildMessage({ jsonrpc: "2.0", id: 42, result: { done: true } });
  assert.equal(rpc.activeInflight, 1, "activeInflight decremented after resolve");
  assert.equal(resolved?.id, 42);
  assert.ok(!pendingRequests.has("42"), "resolved entry removed from map");

  await resetRpcState();
});

test("rejectAllPending clears the map and resets activeInflight to 0", async () => {
  await resetRpcState();
  setActiveInflight(3);

  let rejectedCount = 0;
  for (let i = 0; i < 3; i += 1) {
    pendingRequests.set(`r-${i}`, {
      resolve: () => {},
      reject: () => { rejectedCount += 1; },
      timeout: null,
    });
  }

  rejectAllPending("teardown");
  assert.equal(rejectedCount, 3, "all pending rejected");
  assert.equal(pendingRequests.size, 0, "map cleared");
  assert.equal(rpc.activeInflight, 0, "counter reset on teardown");
});

// Compat shim: ensure childBuffer is a fresh empty string for tests that
// manipulate it. Kept separate so the half-packet test reads top-to-bottom.
async function resetRpcStateStateCompat() {
  setChildBuffer("");
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("test reset"));
  }
  pendingRequests.clear();
  setActiveInflight(0);
}
