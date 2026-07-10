/**
 * Structured JSON logger for the memory bus system.
 *
 * All log output goes to stderr as JSON so stdout is reserved for the MCP
 * protocol.  Each entry includes a timestamp, level, component name, and
 * optionally a trace ID that is propagated via AsyncLocalStorage.
 *
 * Levels: debug < info < warn < error
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// AsyncLocalStorage for trace ID propagation
// ---------------------------------------------------------------------------

/** @type {import('node:async_hooks').AsyncLocalStorage<string>|null} */
let _als = null;

try {
  // Node >= 14.5
  const { AsyncLocalStorage } = require("node:async_hooks");
  _als = new AsyncLocalStorage();
} catch {
  // Node < 14.5 — no-op fallback
}

function _getStore() {
  if (_als) return _als.getStore();
  // Polyfill: callers are expected to call runAsync for actual propagation
  return undefined;
}

function runAsync(storeValue, fn, ...args) {
  if (_als) return _als.run(storeValue, fn, ...args);
  return fn(...args); // best-effort: run without propagation
}

// ---------------------------------------------------------------------------
// Current trace ID (fast path — avoids ALS overhead)
// ---------------------------------------------------------------------------

let _currentTraceId = undefined;

/**
 * Returns the currently active trace ID or undefined.
 * @returns {string|undefined}
 */
export function getCurrentTraceId() {
  const alsId = _getStore();
  if (alsId !== undefined) return alsId;
  return _currentTraceId;
}

/**
 * Sets the current trace ID for the current synchronous execution frame.
 * Prefer `withTrace()` for async call chains.
 *
 * Q-HIGH-10: 同步镜像 trace id 到 process.env.AI_MEMORY_TRACE_ID;
 * Python 子进程自动继承 env,后续 os.environ.get('AI_MEMORY_TRACE_ID')
 * 可在 Python worker 日志中打印 trace id,跨 Node→Python 边界追踪。
 * @param {string|undefined} id
 */
export function setCurrentTraceId(id) {
  _currentTraceId = id;
  if (id) {
    process.env.AI_MEMORY_TRACE_ID = id;
  } else {
    delete process.env.AI_MEMORY_TRACE_ID;
  }
}

// ---------------------------------------------------------------------------
// Level constants
// ---------------------------------------------------------------------------

const LEVELS = {
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
};

const LOG_LEVEL_NAME = {
  10: "debug",
  20: "info",
  30: "warn",
  40: "error",
};

// Minimum level to emit (default: info)
let _minLevel = LEVELS.info;

export function setLogLevel(level) {
  if (typeof level === "string" && LEVELS[level] !== undefined) {
    _minLevel = LEVELS[level];
  } else if (typeof level === "number" && LEVELS[LOG_LEVEL_NAME[level]] !== undefined) {
    _minLevel = level;
  }
}

export function getLogLevel() {
  return LOG_LEVEL_NAME[_minLevel] ?? "info";
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

/**
 * Emit a structured JSON log entry to stderr.
 * @param {string} level  — "debug" | "info" | "warn" | "error"
 * @param {string} component
 * @param {string} msg
 * @param {Record<string,unknown>} [extra]
 */
function emit(level, component, msg, extra = {}) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < _minLevel) return;

  const entry = {
    ts:        new Date().toISOString(),
    level,
    component,
    traceId:   getCurrentTraceId(),
    msg,
    ...extra,
  };

  // Write to stderr to avoid polluting MCP stdout
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Create a component-scoped logger.
 *
 * @param {string} component — identifier shown as `component` field in every entry
 * @returns {{ debug(msg: string, extra?: Record<string,unknown>): void,
 *             info(msg: string, extra?: Record<string,unknown>): void,
 *             warn(msg: string, extra?: Record<string,unknown>): void,
 *             error(msg: string, extra?: Record<string,unknown>): void }}
 */
export function createStructuredLogger(component) {
  return {
    debug(msg, extra = {}) { emit("debug", component, msg, extra); },
    info(msg,  extra = {}) { emit("info",  component, msg, extra); },
    warn(msg,  extra = {}) { emit("warn",  component, msg, extra); },
    error(msg, extra = {}) { emit("error", component, msg, extra); },
  };
}

// ---------------------------------------------------------------------------
// withTrace — run an async function with a specific trace ID propagated
// ---------------------------------------------------------------------------

/**
 * Run an async function with `traceId` available via `getCurrentTraceId()`.
 * When inside a Node.js AsyncLocalStorage context, the ID is also propagated
 * automatically through `await` boundaries.
 *
 * @param {string}   traceId
 * @param {Function} fn
 * @param {...any}   args
 * @returns {Promise<any>}
 */
export function withTrace(traceId, fn, ...args) {
  return runAsync(traceId, async (...a) => {
    const prev = _currentTraceId;
    const prevEnv = process.env.AI_MEMORY_TRACE_ID;
    _currentTraceId = traceId;
    process.env.AI_MEMORY_TRACE_ID = traceId;
    try {
      return await fn(...a);
    } finally {
      _currentTraceId = prev;
      if (prevEnv === undefined) delete process.env.AI_MEMORY_TRACE_ID;
      else process.env.AI_MEMORY_TRACE_ID = prevEnv;
    }
  }, ...args);
}

/**
 * Generate a new trace ID (UUID v4) using Node.js built-in crypto.
 * @returns {string}
 */
export function generateTraceId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Execute `fn` inside a new trace context, returning { traceId, result }.
 *
 * @param {Function} fn — async or sync function to execute under a new trace
 * @param {...any}   args
 * @returns {Promise<{ traceId: string, result: any }>}
 */
export async function traced(tag, fn, ...args) {
  const traceId = generateTraceId();
  const result  = await withTrace(traceId, fn, ...args);
  return { traceId, result };
}

// ---------------------------------------------------------------------------
// Default module-level exports
// ---------------------------------------------------------------------------

export default { createStructuredLogger, withTrace, getCurrentTraceId, setCurrentTraceId, generateTraceId, setLogLevel, getLogLevel };
