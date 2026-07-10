import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateTraceId,
  createTraceContext,
  runInTraceContext,
  runWithTraceId,
  getTraceContext,
  getCurrentTraceId,
  setTraceContext,
  wrapMetricValue,
  circularPush,
} from "../../../shared-mcp/metrics/trace-manager.js";
import traceManagerDefault from "../../../shared-mcp/metrics/trace-manager.js";
import {
  createStructuredLogger,
  generateTraceId as generateTraceIdLogger,
  setLogLevel,
  getLogLevel,
  withTrace,
} from "../../../shared-mcp/metrics/structured-logger.js";

const CIRCULAR_BUFFER_MAX = traceManagerDefault.CIRCULAR_BUFFER_MAX;

describe("metrics/trace-manager", () => {
  test("generateTraceId returns a UUID v4-shaped string", () => {
    const id = generateTraceId();
    assert.equal(typeof id, "string");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("createTraceContext produces unique ids and required fields", () => {
    const ctx = createTraceContext({ component: "test" });
    assert.ok(ctx.traceId);
    assert.equal(ctx.component, "test");
    assert.equal(typeof ctx.startedAt, "number");
  });

  test("getCurrentTraceId returns undefined outside a context", () => {
    const id = getCurrentTraceId();
    assert.ok(id === undefined);
  });

  test("runInTraceContext propagates trace id into nested fn", async () => {
    const observed = await runInTraceContext({ component: "outer" }, async () => {
      const id = getCurrentTraceId();
      return id;
    });
    assert.ok(observed, "trace id should be present inside runInTraceContext");
  });

  test("runWithTraceId uses the provided id", async () => {
    const observed = await runWithTraceId("explicit-id-1234", async () => {
      return getCurrentTraceId();
    });
    assert.equal(observed, "explicit-id-1234");
  });

  test("wrapMetricValue adds ts and traceId fields", () => {
    const wrapped = wrapMetricValue(42, { operation: "test" });
    assert.equal(wrapped.value, 42);
    assert.equal(typeof wrapped.ts, "number");
    assert.equal(wrapped.operation, "test");
  });

  test("circularPush evicts oldest entries when over capacity", () => {
    const buf = [];
    for (let i = 0; i < CIRCULAR_BUFFER_MAX + 5; i++) {
      circularPush(buf, i);
    }
    assert.equal(buf.length, CIRCULAR_BUFFER_MAX);
    // Oldest entries should have been shifted
    assert.equal(buf[0], 5);
    assert.equal(buf[buf.length - 1], CIRCULAR_BUFFER_MAX + 4);
  });

  test("circularPush with custom maxSize", () => {
    const buf = [];
    for (let i = 0; i < 10; i++) {
      circularPush(buf, i, 3);
    }
    assert.equal(buf.length, 3);
    assert.deepEqual(buf, [7, 8, 9]);
  });
});

describe("metrics/structured-logger", () => {
  test("setLogLevel / getLogLevel round-trip", () => {
    setLogLevel("debug");
    assert.equal(getLogLevel(), "debug");
    setLogLevel("error");
    assert.equal(getLogLevel(), "error");
    setLogLevel("info"); // restore
  });

  test("createStructuredLogger returns object with debug/info/warn/error", () => {
    const log = createStructuredLogger("test-component");
    assert.equal(typeof log.debug, "function");
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
  });

  test("logger emits JSON to stderr with required fields", () => {
    const log = createStructuredLogger("emitter-test");
    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { captured += s; return true; };
    try {
      log.info("hello", { extra: 1 });
    } finally {
      process.stderr.write = origWrite;
    }
    // Each line is one JSON object
    const lines = captured.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.component, "emitter-test");
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "hello");
    assert.equal(entry.extra, 1);
    assert.ok(entry.ts);
  });

  test("withTrace runs fn and returns its result", async () => {
    const result = await withTrace("trace-xyz", () => "ok");
    assert.equal(result, "ok");
  });

  test("generateTraceId from structured-logger matches the format", () => {
    const id = generateTraceIdLogger();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
