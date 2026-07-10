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

// JSON-RPC 2.0 server-error range (-32000 to -32099) reserved for
// implementation-defined errors. Pick stable codes so MCP clients that
// branch on numeric code can dispatch cleanly.
export const IPC_ERROR_CODES = {
  WORKER_UNAVAILABLE: -32001,
  CIRCUIT_OPEN: -32002,
  BACKPRESSURE: -32003,
  TIMEOUT: -32004,
  MALFORMED_REQUEST: -32600, // JSON-RPC 2.0 standard: Invalid Request
  INTERNAL_ERROR: -32603,    // JSON-RPC 2.0 standard: Internal error
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