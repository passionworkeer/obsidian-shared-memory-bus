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

// Critical ports that ai-memory doctor probes for shared-MCP availability.
// Includes every port referenced by MCP_SERVERS (port field) and a small
// margin of additional integration ports that start.js may grow into.
export const CRITICAL_PORTS = [9331, 9332, 9333, 9334, 9335, 9338];

export function resolveBasePort(env = process.env) {
  const configured = Number.parseInt(env.AI_MEMORY_BASE_PORT || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BASE_PORT;
}

export function getServerPort(server, basePort = resolveBasePort()) {
  return basePort + (server.port - DEFAULT_BASE_PORT);
}
