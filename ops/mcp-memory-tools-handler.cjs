/**
 * ops/mcp-memory-tools-handler.js
 * =================================
 * MCP tool handlers for memory_boot and memory_query.
 *
 * Loaded by omni-memory-server.js via createRequire(), so CommonJS
 * require() works from the MCP server context.
 */

"use strict";

const { memory_boot: _boot, memory_query: _query } = require("./mcp-memory-tools.cjs");

/** Wrap a sync or async fn → MCP tool handler with error handling. */
function toolHandler(fn) {
  return async (args) => {
    try {
      // Most existing handlers accept a single `args` object.
      // memory_boot and memory_query both accept a single options object.
      const result = fn(args);

      // Support both sync (returned value) and async (Promise) handlers.
      const data = result instanceof Promise ? await result : result;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                ...(typeof data === "object" && data !== null ? data : { data }),
              },
              null,
              2
            ),
          },
        ],
        isError: false,
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };
}

module.exports = {
  handlers: {
    memory_boot: toolHandler((args = {}) => _boot(args)),
    memory_query: toolHandler((args = {}) => _query(args)),
  },
};
