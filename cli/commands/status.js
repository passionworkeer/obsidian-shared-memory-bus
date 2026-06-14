/**
 * `status` commands — read-only views into bus / embeddings / MCP state.
 *
 * - status (alias) -> bus:status
 * - bus:status:    what's in shared memory right now
 * - embeddings:status: search index health (JSON)
 * - mcp:status:    is the shared memory service running?
 */
import { COMMANDS } from "../lib/registry.js";

export const NAMES = ["status", "bus:status", "embeddings:status", "mcp:status"];

export function getCommand(name) {
  switch (name) {
    case "status":
      return COMMANDS["bus:status"];
    case "bus:status":
      return COMMANDS["bus:status"];
    case "embeddings:status":
      return COMMANDS["embeddings:status"];
    case "mcp:status":
      return COMMANDS["mcp:status"];
    default:
      return null;
  }
}
