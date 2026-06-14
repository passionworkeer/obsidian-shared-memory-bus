/**
 * `init` and one-time setup commands.
 *
 * - setup: interactive setup wizard
 * - generate: regenerate memory summaries
 */
import { COMMANDS } from "../lib/registry.js";

export const NAMES = ["setup", "generate"];

export function getCommand(name) {
  if (name === "setup") return COMMANDS["setup"];
  if (name === "generate") return COMMANDS["bus:generate"];
  return null;
}
