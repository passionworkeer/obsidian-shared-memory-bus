/**
 * Trace manager — lightweight wrapper around AsyncLocalStorage for request
 * correlation across the memory bus.
 *
 * Responsibilities:
 * - Generate UUID v4 trace IDs
 * - Propagate trace context through async call chains
 * - Wrap existing circular metric buffers with trace-aware metadata
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

let _als = null;

try {
  const { AsyncLocalStorage } = require("node:async_hooks");
  _als = new AsyncLocalStorage();
} catch {
  // Node < 14.5 — trace propagation via ALS silently degraded
}

/**
 * @typedef {Object} TraceContext
 * @property {string}         traceId
 * @property {number}         startedAt  — Date.now() ms timestamp
 * @property {string}          component
 * @property {string|undefined} parentId  — optional parent span
 */

/** @type {TraceContext|undefined} */
let _currentContext = undefined;

function _getStore() {
  if (_als) return _als.getStore();
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new trace ID using Node.js built-in crypto (UUID v4).
 * @returns {string}
 */
export function generateTraceId() {
  return crypto.randomUUID();
}

/**
 * Create a new trace context (does NOT activate it — use runInTraceContext).
 *
 * @param {object}        [options]
 * @param {string}        [options.component]  — initial component label
 * @param {string|undefined} [options.parentId]  — parent span ID for linking
 * @returns {TraceContext}
 */
export function createTraceContext(options = {}) {
  return {
    traceId:   generateTraceId(),
    startedAt: Date.now(),
    component: options.component ?? "unknown",
    parentId:  options.parentId,
  };
}

/**
 * Run a synchronous or async function inside a newly created trace context.
 * The trace ID is automatically propagated via AsyncLocalStorage so all
 * nested `getTraceContext()` calls see the same context.
 *
 * @param {object}        options
 * @param {string}        [options.component]
 * @param {string|undefined} [options.parentId]
 * @param {Function}      fn
 * @param {...any}        args
 * @returns {Promise<any>}
 */
export function runInTraceContext(options, fn, ...args) {
  const ctx = createTraceContext(options);
  return runAsync(ctx.traceId, async (...a) => {
    const prev = _currentContext;
    _currentContext = ctx;
    try {
      return await fn(...a);
    } finally {
      _currentContext = prev;
    }
  }, ...args);
}

/**
 * Run a function inside a trace context seeded with an explicit trace ID.
 * Use this when the trace ID arrived from an incoming request header.
 *
 * @param {string}   traceId
 * @param {Function} fn
 * @param {...any}   args
 * @returns {Promise<any>}
 */
export function runWithTraceId(traceId, fn, ...args) {
  return runAsync(traceId, async (...a) => {
    const prev = _currentContext;
    _currentContext = { traceId, startedAt: Date.now(), component: "unknown" };
    try {
      return await fn(...a);
    } finally {
      _currentContext = prev;
    }
  }, ...args);
}

/**
 * Return the currently active trace context, or undefined if none is active.
 *
 * Priority:
 *   1. AsyncLocalStorage store (automatic propagation across await boundaries)
 *   2. Current synchronous frame's manually assigned context
 *
 * @returns {TraceContext|undefined}
 */
export function getTraceContext() {
  const storeId = _getStore();
  if (storeId !== undefined) {
    // Store only holds the traceId string; reconstruct minimal context
    return {
      traceId:   storeId,
      startedAt: Date.now(),
      component: "unknown",
    };
  }
  return _currentContext;
}

/**
 * Return only the current trace ID string, or undefined.
 * Faster than getTraceContext() when only the ID is needed.
 *
 * @returns {string|undefined}
 */
export function getCurrentTraceId() {
  const ctx = getTraceContext();
  return ctx?.traceId;
}

/**
 * Set the trace context for the current synchronous frame only.
 * Prefer runWithTraceId() for async call chains.
 *
 * @param {TraceContext|undefined} ctx
 */
export function setTraceContext(ctx) {
  _currentContext = ctx;
}

// ---------------------------------------------------------------------------
// Helpers for wrapping metric buffers with trace metadata
// ---------------------------------------------------------------------------

const CIRCULAR_BUFFER_MAX = 100;

/**
 * Wrap a numeric value with trace metadata for enriched metric entries.
 *
 * @param {number}                            value
 * @param {object}                            [extra]
 * @param {string|undefined}                  [extra.component]
 * @param {string|undefined}                  [extra.operation]
 * @param {string|undefined}                  [extra.requestId]
 * @returns {{ value: number, traceId?: string, ts: number, component?: string, operation?: string, requestId?: string }}
 */
export function wrapMetricValue(value, extra = {}) {
  const traceId = getCurrentTraceId();
  return {
    value,
    ts:        Date.now(),
    traceId,
    ...(extra.component  ? { component:  extra.component  } : {}),
    ...(extra.operation  ? { operation:  extra.operation  } : {}),
    ...(extra.requestId ? { requestId:  extra.requestId   } : {}),
  };
}

/**
 * Push a value to a circular buffer (side-effect: mutates the array).
 * Returns the trimmed array.
 *
 * @template T
 * @param {T[]}        buffer
 * @param {T}          value
 * @param {number}     [maxSize]
 * @returns {T[]}
 */
export function circularPush(buffer, value, maxSize = CIRCULAR_BUFFER_MAX) {
  if (buffer.length >= maxSize) {
    buffer.shift();
  }
  buffer.push(value);
  return buffer;
}

// ---------------------------------------------------------------------------
// Internal AsyncLocalStorage run helper
// ---------------------------------------------------------------------------

function runAsync(storeValue, fn, ...args) {
  if (_als) return _als.run(storeValue, fn, ...args);
  return fn(...args); // best-effort without ALS
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  generateTraceId,
  createTraceContext,
  runInTraceContext,
  runWithTraceId,
  getTraceContext,
  getCurrentTraceId,
  setTraceContext,
  wrapMetricValue,
  circularPush,
  CIRCULAR_BUFFER_MAX,
};
