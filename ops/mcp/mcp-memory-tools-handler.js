/**
 * ops/mcp-memory-tools-handler.js
 * =================================
 * MCP tool handlers for lightweight memory boot/search/write flows.
 *
 * Usage:
 *   import { handlers } from "./mcp-memory-tools-handler.js";
 */

import {
  memory_boot as _boot,
  memory_search as _search,
  memory_query as _query,
  memory_write as _write,
} from "./mcp-memory-tools.js";

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

export const handlers = {
  memory_boot: toolHandler((args = {}) => _boot(args)),
  memory_search: toolHandler((args = {}) => _search(args)),
  memory_query: toolHandler((args = {}) => _query(args)),
  memory_write: toolHandler((args = {}) => _write(args)),
};
