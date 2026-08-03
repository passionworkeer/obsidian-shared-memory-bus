/**
 * Resolve the set of core MCP servers started by start.js.
 *
 * Utility servers are always included. Only the memory topology is selected:
 *   - split (default): retrieval, bridge, dream, and management processes
 *   - monolithic/all: the legacy all-in-one memory process
 */

import {
  DEFAULT_BASE_PORT,
  SPLIT_MEMORY_SERVER_PORTS,
  SPLIT_MEMORY_METRICS_PORTS,
  resolveBasePort,
} from './port-registry.js';

const SUBSETS = Object.freeze(['retrieval', 'bridge', 'dream', 'mgmt']);
const VALID_MODES = new Set(['split', 'monolithic', 'all']);

function shiftedPort(defaultPort, basePort) {
  return basePort + (defaultPort - DEFAULT_BASE_PORT);
}

export function resolveSpawnPlan(env = process.env) {
  const raw = String(env.AI_MEMORY_SERVER_MODE || 'split').trim().toLowerCase() || 'split';
  if (!VALID_MODES.has(raw)) {
    throw new Error(
      `invalid AI_MEMORY_SERVER_MODE: ${raw}; expected split, monolithic, or all`,
    );
  }
  const mode = raw === 'monolithic' || raw === 'all' ? 'monolithic' : 'split';
  const basePort = resolveBasePort(env);

  if (mode === 'monolithic') {
    return {
      mode,
      entries: [{
        id: 'memory',
        port: shiftedPort(9338, basePort),
        metricsPort: shiftedPort(9438, basePort),
        args: ['--experimental-default-type=module', 'omni-memory-server.js'],
        env: {
          AI_MEMORY_SERVER_MODE: 'all',
          AI_MEMORY_METRICS_PORT: String(shiftedPort(9438, basePort)),
        },
      }],
    };
  }

  return {
    mode,
    entries: SUBSETS.map((subset) => ({
      id: `memory-${subset}`,
      port: shiftedPort(SPLIT_MEMORY_SERVER_PORTS[subset], basePort),
      metricsPort: shiftedPort(SPLIT_MEMORY_METRICS_PORTS[subset], basePort),
      args: ['--experimental-default-type=module', 'omni-memory-server.js'],
      env: {
        AI_MEMORY_SERVER_MODE: subset,
        AI_MEMORY_METRICS_PORT: String(
          shiftedPort(SPLIT_MEMORY_METRICS_PORTS[subset], basePort),
        ),
      },
    })),
  };
}

/**
 * Return all utility servers plus exactly one memory topology.
 */
export function selectServersForSpawn(mcpServers, env = process.env) {
  const plan = resolveSpawnPlan(env);
  const selectedMemoryIds = new Set(plan.entries.map((entry) => entry.id));

  return mcpServers.filter((server) => {
    const isMemoryServer = server.id === 'memory' || server.id.startsWith('memory-');
    return !isMemoryServer || selectedMemoryIds.has(server.id);
  });
}
