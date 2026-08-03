/**
 * shared-mcp/port-registry.js — single source of truth for MCP and metrics ports.
 */

export const DEFAULT_BASE_PORT = 9330;
export const DEFAULT_METRICS_PORT_OFFSET = 100;

export const MCP_SERVERS = [
  { id: 'fetch', port: 9332, command: 'python', args: ['-m', 'mcp_server_fetch'] },
  { id: 'time', port: 9333, command: 'python', args: ['-m', 'mcp_server_time'] },
  {
    id: 'memory-retrieval',
    port: 9338,
    metricsPort: 9438,
    command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'retrieval' },
  },
  {
    id: 'memory-bridge',
    port: 9339,
    metricsPort: 9439,
    command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'bridge' },
  },
  {
    id: 'memory-dream',
    port: 9340,
    metricsPort: 9440,
    command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'dream' },
  },
  {
    id: 'memory-mgmt',
    port: 9341,
    metricsPort: 9441,
    command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    env: { AI_MEMORY_SERVER_MODE: 'mgmt' },
  },
  {
    id: 'memory',
    port: 9338,
    metricsPort: 9438,
    command: 'node',
    args: ['--experimental-default-type=module', 'omni-memory-server.js'],
    legacy: true,
    onlyInMode: 'monolithic',
    env: { AI_MEMORY_SERVER_MODE: 'all' },
  },
];

export const SPLIT_MEMORY_SERVER_PORTS = Object.freeze({
  retrieval: 9338,
  bridge: 9339,
  dream: 9340,
  mgmt: 9341,
});

export const SPLIT_MEMORY_METRICS_PORTS = Object.freeze({
  retrieval: 9438,
  bridge: 9439,
  dream: 9440,
  mgmt: 9441,
});

export const CRITICAL_PORTS = [9331, 9332, 9333, 9334, 9335, 9338, 9339, 9340, 9341];

const MAX_PORT_OFFSET = Math.max(
  ...MCP_SERVERS.flatMap((server) => [server.port, server.metricsPort].filter(Number.isFinite)),
) - DEFAULT_BASE_PORT;

function validateBasePort(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid AI_MEMORY_BASE_PORT: ${value}`);
  }
  if (value + MAX_PORT_OFFSET > 65535) {
    throw new Error(
      `AI_MEMORY_BASE_PORT ${value} is too high; derived ports extend to ${value + MAX_PORT_OFFSET}`,
    );
  }
  return value;
}

function validateDerivedPort(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid ${label} port: ${value}`);
  }
  return value;
}

export function resolveBasePort(env = process.env) {
  const raw = String(env.AI_MEMORY_BASE_PORT || '').trim();
  if (!raw) {
    return DEFAULT_BASE_PORT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid AI_MEMORY_BASE_PORT: ${raw}`);
  }
  return validateBasePort(Number(raw));
}

export function getServerPort(server, basePort = resolveBasePort()) {
  validateBasePort(basePort);
  return validateDerivedPort(
    basePort + (server.port - DEFAULT_BASE_PORT),
    `${server?.id || 'server'} MCP`,
  );
}

export function getServerMetricsPort(server, basePort = resolveBasePort()) {
  if (!Number.isFinite(server?.metricsPort)) return null;
  validateBasePort(basePort);
  return validateDerivedPort(
    basePort + (server.metricsPort - DEFAULT_BASE_PORT),
    `${server?.id || 'server'} metrics`,
  );
}
