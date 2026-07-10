/**
 * shared-mcp/port-registry.js — single source of truth for MCP server ports.
 *
 * Both start.js (which spawns the servers) and cli/ai-memory.js (which
 * reports on shared MCP port availability) used to keep their own port
 * lists in sync via a code comment. The ai-memory.js copy drifted
 * (9331/9334/9335 were never reflected in start.js) — this module
 * collapses both copies into one.
 *
 * Consumers:
 *   - start.js — server list + port resolution
 *   - cli/ai-memory.js — port availability probe
 */

export const DEFAULT_BASE_PORT = 9330;

// I-HIGH-1 stage 3 (PR17): 4-server split 默认形态。
// start.js 默认按 AI_MEMORY_SERVER_MODE=split (默认) 决策,monolithic 是
// `AI_MEMORY_SERVER_MODE=monolithic` 显式回退路径。spawn-plan.js 决策互斥:
//   split 模式 → memory-retrieval/bridge/dream/mgmt 4 条
//   monolithic 模式 → memory legacy 单条
// 各 server 的 AI_MEMORY_METRICS_PORT 与 MCP port 同端口 (每 server 独立进程,
// 无端口冲突);预留 SPLIT_MEMORY_METRICS_PORTS mapping 供后续独立 metrics 端口配置。
export const MCP_SERVERS = [
  { id: 'fetch',  port: 9332, command: 'python', args: ['-m', 'mcp_server_fetch'] },
  { id: 'time',   port: 9333, command: 'python', args: ['-m', 'mcp_server_time'] },
  // 4-server split entries — 默认形态。共享同一份 entry 文件,通过 env 区分工具子集
  // (stage 1 commit 5079e8e 已实现 env 切子集;stage 3 真正独立进程)。
  { id: 'memory-retrieval', port: 9338, command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'retrieval', AI_MEMORY_METRICS_PORT: '9338' } },
  { id: 'memory-bridge',    port: 9339, command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'bridge',    AI_MEMORY_METRICS_PORT: '9339' } },
  { id: 'memory-dream',     port: 9340, command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'dream',     AI_MEMORY_METRICS_PORT: '9340' } },
  { id: 'memory-mgmt',      port: 9341, command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'mgmt',      AI_MEMORY_METRICS_PORT: '9341' } },
  // Legacy monolithic entry — only spawned when AI_MEMORY_SERVER_MODE=monolithic/all。
  // 保留向后兼容,SERVER-SPLIT.md §8.2 承诺 "omni-memory-server.js 作为兼容入口永不删除"。
  { id: 'memory', port: 9338, command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    legacy: true, onlyInMode: 'monolithic',
    env: { AI_MEMORY_SERVER_MODE: 'all', AI_MEMORY_METRICS_PORT: '9338' } },
];

// 与 MCP_SERVERS 中 memory-* 条目同步的端口快照。
// 供 manifest.json loader + spawn-plan.js 决策 + doctor 探测 共用。
// 实际启用阶段端口以 MCP_SERVERS 为准;此处只是便于快速查表。
export const SPLIT_MEMORY_SERVER_PORTS = Object.freeze({
  retrieval: 9338, // monolithic 兼容层,retrieval 子集
  bridge:    9339,
  dream:     9340,
  mgmt:      9341,
});

// 默认 metrics 与 mcp 同端口 (每 server 独立进程,无端口冲突)。
// 预留 mapping 供未来独立 metrics 端口配置覆盖 (e.g. 9338+10 = 9348)。
export const SPLIT_MEMORY_METRICS_PORTS = Object.freeze({
  retrieval: 9338,
  bridge:    9339,
  dream:     9340,
  mgmt:      9341,
});

// Critical ports that ai-memory doctor probes for shared-MCP availability.
// Includes every port referenced by MCP_SERVERS (port field) and a small
// margin of additional integration ports that start.js may grow into.
export const CRITICAL_PORTS = [9331, 9332, 9333, 9334, 9335, 9338, 9339, 9340, 9341];

export function resolveBasePort(env = process.env) {
  const configured = Number.parseInt(env.AI_MEMORY_BASE_PORT || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BASE_PORT;
}

export function getServerPort(server, basePort = resolveBasePort()) {
  return basePort + (server.port - DEFAULT_BASE_PORT);
}
