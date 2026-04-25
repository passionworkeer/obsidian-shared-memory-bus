/**
 * IPC protocol for search worker isolation.
 *
 * Defines the message format for communication between the main MCP server
 * (omni-memory-server.js) and the isolated search worker process.
 *
 * Protocol: JSON over stdin/stdout with newline-delimited messages.
 * Each message has an `id` field for request/response correlation.
 */

export const IPC_ACTIONS = {
  SEARCH: "search",
  HEALTH: "health",
  CLEAR_CACHE: "clear_cache",
  GET_RECORDS: "get_records",
  TIMELINE: "timeline",
};

export const IPC_ERROR_CODES = {
  WORKER_UNAVAILABLE: "SEARCH_WORKER_UNAVAILABLE",
  CIRCUIT_OPEN: "SEARCH_WORKER_CIRCUIT_OPEN",
  BACKPRESSURE: "SEARCH_WORKER_BACKPRESSURE",
  TIMEOUT: "SEARCH_WORKER_TIMEOUT",
  MALFORMED_REQUEST: "MALFORMED_REQUEST",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * Build an IPC request message.
 * @param {string} id - Unique request ID
 * @param {string} action - One of IPC_ACTIONS
 * @param {object} params - Action-specific parameters
 * @returns {string} - JSON string with trailing newline
 */
export function buildRequest(id, action, params = {}) {
  return JSON.stringify({ id, action, ...params }) + "\n";
}

/**
 * Parse an IPC response message.
 * @param {string} line - Raw JSON line
 * @returns {object|null} - Parsed response or null on parse failure
 */
export function parseResponse(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

/**
 * Build an error response.
 * @param {string} id - Original request ID
 * @param {string} code - Error code from IPC_ERROR_CODES
 * @param {string} message - Human-readable error message
 * @returns {object}
 */
export function buildError(id, code, message) {
  return { id, ok: false, error: { code, message } };
}

/**
 * Validate an incoming IPC request payload.
 * @param {object} payload
 * @returns {{ok: boolean, error?: string}}
 */
export function validateRequest(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload must be an object" };
  }
  if (!payload.id || typeof payload.id !== "string") {
    return { ok: false, error: "id field is required and must be a string" };
  }
  if (!payload.action || typeof payload.action !== "string") {
    return { ok: false, error: "action field is required and must be a string" };
  }
  if (!Object.values(IPC_ACTIONS).includes(payload.action)) {
    return { ok: false, error: `unknown action: ${payload.action}` };
  }
  return { ok: true };
}