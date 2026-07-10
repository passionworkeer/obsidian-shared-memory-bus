/**
 * spawn-plan.js — I-HIGH-1 stage 3 (PR17 commit 3)
 *
 * 根据 AI_MEMORY_SERVER_MODE 环境变量,决策 start.js 应 spawn 哪几个 server 进程。
 *
 * 决策矩阵:
 *   - 显式 "monolithic" / "all"  → 1 个 legacy memory 单进程 (端口 9338, 全部 29 个工具)
 *   - 显式 "split" / 未设 / 其它  → 4 个独立 server (retrieval/bridge/dream/mgmt, 端口 9338-9341)
 *   - 显式 "split,no-bridge" 形式 → 后续 wave 可扩展;当前只支持 monolithic / split 二选一
 *
 * 互斥保证:split 模式不 spawn legacy memory 条目;monolithic 模式不 spawn 4 个
 * memory-* 条目。两组共用 9338 端口,start.js 同一时刻只会 spawn 一组。
 *
 * 与 MCP_SERVERS 的关系:本文件是决策层,MCP_SERVERS 是元数据;spawnPlan 返回的
 * id 都在 MCP_SERVERS 中存在(legacy / memory-{retrieval,bridge,dream,mgmt}),
 * start.js 据此从 MCP_SERVERS 拿 port + command + args。
 */

import { SPLIT_MEMORY_SERVER_PORTS, SPLIT_MEMORY_METRICS_PORTS } from "./port-registry.js";

const SUBSETS = Object.freeze(["retrieval", "bridge", "dream", "mgmt"]);

/**
 * @typedef {Object} SpawnEntry
 * @property {string} id         - 与 MCP_SERVERS 中的 id 对齐
 * @property {number} port       - MCP 端口
 * @property {string[]} args     - 启动命令参数
 * @property {Object} env        - 注入到子进程的环境变量
 */

/**
 * 决策 start.js 应 spawn 哪些 server。
 * @param {Object} env - 通常传 process.env
 * @returns {{ mode: 'split'|'monolithic', entries: SpawnEntry[] }}
 */
export function resolveSpawnPlan(env = process.env) {
  const raw = String(env.AI_MEMORY_SERVER_MODE || "split").trim().toLowerCase();
  const mode = (raw === "monolithic" || raw === "all") ? "monolithic" : "split";

  if (mode === "monolithic") {
    return {
      mode,
      entries: [{
        id: "memory",
        port: 9338,
        args: ["--experimental-default-type=module", "omni-memory-server.js"],
        env: { AI_MEMORY_SERVER_MODE: "all", AI_MEMORY_METRICS_PORT: "9338" },
      }],
    };
  }

  // split mode (default)
  return {
    mode,
    entries: SUBSETS.map((sub) => ({
      id: `memory-${sub}`,
      port: SPLIT_MEMORY_SERVER_PORTS[sub],
      args: ["--experimental-default-type=module", "omni-memory-server.js"],
      env: {
        AI_MEMORY_SERVER_MODE: sub,
        AI_MEMORY_METRICS_PORT: String(SPLIT_MEMORY_METRICS_PORTS[sub]),
      },
    })),
  };
}

/**
 * 按决策结果过滤 MCP_SERVERS,返回 start.js 实际要 spawn 的子集。
 * 默认 split 模式 → 4 条 memory-*;monolithic 模式 → 1 条 legacy memory。
 *
 * @param {Array} mcpServers - port-registry.js 的 MCP_SERVERS
 * @param {Object} env - 通常传 process.env
 * @returns {Array} MCP_SERVERS 的子集(原对象引用)
 */
export function selectServersForSpawn(mcpServers, env = process.env) {
  const plan = resolveSpawnPlan(env);
  const allowedIds = new Set(plan.entries.map((e) => e.id));
  return mcpServers.filter((s) => allowedIds.has(s.id));
}