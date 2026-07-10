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

export const MCP_SERVERS = [
  { id: 'fetch',  port: 9332, command: 'python', args: ['-m', 'mcp_server_fetch'] },
  { id: 'time',   port: 9333, command: 'python', args: ['-m', 'mcp_server_time'] },
  { id: 'memory', port: 9338, command: 'node',   args: ['--experimental-default-type=module', 'omni-memory-server.js'] },
];

// I-HIGH-1 (PR16): server-split 实施预留端口。
// 当前 monolithic omni-memory-server 仍是单进程,通过
// AI_MEMORY_SERVER_MODE=retrieval/bridge/dream/mgmt env 切工具子集 (commit 5079e8e)。
// 未来拆分 4 个独立进程时,start.js 应同时 spawn 这 4 个 entry,
// 每个指定 mode + port,各自 metric/handler 独立。
//
// 当前 MCP_SERVERS 仅注册 monolithic memory server (port 9338),
// 这 4 个新端口作为预留 (port-registry 同步让 doctor 探测它们
// 可用,以便用户在迁移前确认基础设施就位)。
//
// 实际启用需额外 PR:为每个 mode 写独立 entry stub (e.g.
// shared-mcp/servers/retrieval-server.js thin wrapper) + 修改
// start.js 改为按 server-split 决策 spawn N 个。
export const SPLIT_MEMORY_SERVER_PORTS = Object.freeze({
  retrieval: 9338, // monolithic 兼容层,retrieval 子集
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
