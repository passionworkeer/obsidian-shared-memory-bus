/**
 * tool-registry.js
 * 把 29 个 MCP 工具按职责切成 4 个子集,用于 server-split (债项 #1)。
 *
 * 4 个 server 进程的端口和职责:
 *   - omni-memory-retrieval (9338): 只读检索 + 状态查询
 *   - omni-memory-bridge    (9339): claude-mem / blackboard 跨工具桥接
 *   - omni-memory-dream     (9340): 异步重建 + nightly dream
 *   - omni-memory-mgmt      (9341): 索引/embedding runtime 管理
 *
 * 重要:子集名集合的并集必须等于 TOOLS 全集且无重复 —— 由
 * tests/unit/js/tool-registry.test.js 守护。
 */

import { TOOLS } from "./memory-tools.js";

// 子集 1: 检索 + 状态查询 (14 个,只读)
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
  "memory_write",
]);

// 子集 2: 跨工具桥接 (6 个)
export const BRIDGE_TOOLS = Object.freeze([
  "query_claude_mem",
  "insert_claude_mem",
  "get_blackboard_tasks",
  "write_blackboard_task",
  "build_handoff_pack",
  "rebuild_memory_layers",
]);

// 子集 3: 异步重建 + dream (3 个)
export const DREAM_TOOLS = Object.freeze([
  "run_memory_dream",
  "rebuild_memory_embeddings",
  "rebuild_shared_embeddings",
]);

// 子集 4: 索引 / runtime 管理 + KG 查询 (6 个)
export const MGMT_TOOLS = Object.freeze([
  "list_embedding_runtimes",
  "set_embedding_runtime",
  "get_kg_stats",
  "query_kg",
  "get_entities",
  "get_relationships",
]);

// 全集 (向后兼容,所有 29 个工具,用于 omni-memory-server.js 兼容入口)
export const ALL_TOOLS = Object.freeze([
  ...RETRIEVAL_TOOLS,
  ...BRIDGE_TOOLS,
  ...DREAM_TOOLS,
  ...MGMT_TOOLS,
]);

/**
 * 按工具名集合过滤 TOOLS 数组。
 * @param {readonly string[]} names - 工具名列表
 * @returns {object[]} 仅包含指定工具名的 TOOLS 子集
 */
export function pickTools(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return TOOLS;
  }
  const wanted = new Set(names);
  return TOOLS.filter((tool) => wanted.has(tool.name));
}

/**
 * 同样按工具名集合过滤 handler 表。
 * @param {Record<string, Function>} allHandlers - buildHandlerRegistry 输出
 * @param {readonly string[]} names - 工具名列表
 * @returns {Record<string, Function>} 仅包含指定工具名的 handler 子集
 */
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

/**
 * 元信息: 每个 server 的标准命名 + 端口 + 工具子集。
 * 供 server-bootstrap.js 和 manifest.json 共同消费。
 */
export const SERVER_DEFINITIONS = Object.freeze({
  retrieval: Object.freeze({
    serverName: "omni-memory-retrieval",
    port: 9338,
    tools: RETRIEVAL_TOOLS,
    description: "只读检索 + 状态查询",
  }),
  bridge: Object.freeze({
    serverName: "omni-memory-bridge",
    port: 9339,
    tools: BRIDGE_TOOLS,
    description: "claude-mem / blackboard 桥接",
  }),
  dream: Object.freeze({
    serverName: "omni-memory-dream",
    port: 9340,
    tools: DREAM_TOOLS,
    description: "异步重建 + nightly dream",
  }),
  mgmt: Object.freeze({
    serverName: "omni-memory-mgmt",
    port: 9341,
    tools: MGMT_TOOLS,
    description: "索引 / embedding runtime 管理",
  }),
});
