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
} from "./mcp-memory-tools.js";
import { writeCanonicalMemory } from "./canonical-memory-write.js";

/** Wrap a sync or async fn → MCP tool handler with error handling. */
function toolHandler(fn) {
  return async (args) => {
    try {
      const result = fn(args);
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
  memory_write: toolHandler((args = {}) => writeCanonicalMemory(args)),
};
