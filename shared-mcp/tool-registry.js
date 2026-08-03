/**
 * tool-registry.js
 * Split MCP tools into four responsibility-focused service subsets.
 *
 * The union of all subsets must equal TOOLS with no duplicates. This invariant
 * is guarded by tests/unit/js/tool-registry.test.js.
 */

import { TOOLS } from "./memory-tools.js";

// Subset 1: retrieval + status (read-only)
export const RETRIEVAL_TOOLS = Object.freeze([
  "memory_status",
  "get_memory_overview",
  "memory_wake_up",
  "search_shared_memory",
  "get_memory_records",
  "refine_memory_selection",
  "get_memory_timeline",
  "clear_shared_memory_search_cache",
  "get_entity_info",
  "search_by_entity",
  "memory_boot",
  "memory_search",
  "memory_query",
]);

// Subset 2: cross-tool bridges
export const BRIDGE_TOOLS = Object.freeze([
  "query_claude_mem",
  "insert_claude_mem",
  "get_blackboard_tasks",
  "write_blackboard_task",
  "build_handoff_pack",
  "rebuild_memory_layers",
]);

// Subset 3: asynchronous rebuild + dream
export const DREAM_TOOLS = Object.freeze([
  "run_memory_dream",
  "rebuild_memory_embeddings",
  "rebuild_shared_embeddings",
]);

// Subset 4: writes, index/runtime management, and KG queries
export const MGMT_TOOLS = Object.freeze([
  "memory_write",
  "list_embedding_runtimes",
  "set_embedding_runtime",
  "get_kg_stats",
  "query_kg",
  "get_entities",
  "get_relationships",
]);

export const ALL_TOOLS = Object.freeze([
  ...RETRIEVAL_TOOLS,
  ...BRIDGE_TOOLS,
  ...DREAM_TOOLS,
  ...MGMT_TOOLS,
]);

export function pickTools(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return TOOLS;
  }
  const wanted = new Set(names);
  return TOOLS.filter((tool) => wanted.has(tool.name));
}

export function pickHandlers(allHandlers, names) {
  if (!Array.isArray(names) || names.length === 0) {
    return allHandlers;
  }
  const wanted = new Set(names);
  const filtered = {};
  for (const [name, handler] of Object.entries(allHandlers)) {
    if (wanted.has(name)) {
      filtered[name] = handler;
    }
  }
  return filtered;
}

export const SERVER_DEFINITIONS = Object.freeze({
  retrieval: Object.freeze({
    serverName: "omni-memory-retrieval",
    port: 9338,
    tools: RETRIEVAL_TOOLS,
    description: "read-only retrieval + status",
  }),
  bridge: Object.freeze({
    serverName: "omni-memory-bridge",
    port: 9339,
    tools: BRIDGE_TOOLS,
    description: "claude-mem / blackboard bridge",
  }),
  dream: Object.freeze({
    serverName: "omni-memory-dream",
    port: 9340,
    tools: DREAM_TOOLS,
    description: "async rebuild + nightly dream",
  }),
  mgmt: Object.freeze({
    serverName: "omni-memory-mgmt",
    port: 9341,
    tools: MGMT_TOOLS,
    description: "writes, index, embedding runtime, and KG management",
  }),
});
