/**
 * `watch` / service-control family — long-running or interactive processes.
 *
 * - mcp:start, start  — start the shared memory service
 * - mcp:stop,  stop   — stop the shared memory service
 * - search            — search shared memory
 */
import { COMMANDS } from "../lib/registry.js";

export const NAMES = ["start", "stop", "mcp:start", "mcp:stop", "search"];

const ALIAS_TARGETS = {
  start: "mcp:start",
  stop: "mcp:stop",
};

export function getCommand(name) {
  const target = ALIAS_TARGETS[name] || name;
  return COMMANDS[target] || null;
}
