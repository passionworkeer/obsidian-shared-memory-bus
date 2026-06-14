/**
 * `sync` family — write/build commands that move memory forward.
 *
 * - sync, bus:sync          — sync all sources into shared memory
 * - bus:generate            — regenerate memory summaries
 * - dream:run, dream:dry-run, dream-writeback, dream:writeback
 *                            — dream consolidation
 * - embeddings:build, embeddings:force, embeddings:rebuild
 *                            — search index lifecycle
 * - layers, layers:build    — memory layers
 * - handoff, handoff:build  — handoff pack
 * - hygiene, hygiene:report — memory hygiene report
 * - check, integrity:check  — memory integrity validation
 */
import { COMMANDS } from "../lib/registry.js";

export const NAMES = [
  "sync",
  "bus:sync",
  "dream:run",
  "dream:dry-run",
  "dream-writeback",
  "dream:writeback",
  "embeddings:build",
  "embeddings:force",
  "embeddings:rebuild",
  "layers",
  "layers:build",
  "handoff",
  "handoff:build",
  "hygiene",
  "hygiene:report",
  "check",
  "integrity:check",
];

const ALIAS_TARGETS = {
  sync: "bus:sync",
  "dream-dry-run": "dream:dry-run",
  "dream-writeback": "dream:writeback",
  "embeddings:rebuild": "embeddings:force",
  layers: "layers:build",
  handoff: "handoff:build",
  hygiene: "hygiene:report",
  "integrity:check": "check",
};

export function getCommand(name) {
  const target = ALIAS_TARGETS[name] || name;
  return COMMANDS[target] || null;
}
