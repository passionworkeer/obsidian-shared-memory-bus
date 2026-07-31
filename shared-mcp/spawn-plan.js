/**
 * Resolve the set of core MCP servers started by start.js.
 *
 * Utility servers are always included. Only the memory topology is selected:
 *   - split (default): retrieval, bridge, dream, and management processes
 *   - monolithic/all: the legacy all-in-one memory process
 */

import { SPLIT_MEMORY_SERVER_PORTS, SPLIT_MEMORY_METRICS_PORTS } from './port-registry.js';

const SUBSETS = Object.freeze(['retrieval', 'bridge', 'dream', 'mgmt']);

export function resolveSpawnPlan(env = process.env) {
  const raw = String(env.AI_MEMORY_SERVER_MODE || 'split').trim().toLowerCase();
  const mode = raw === 'monolithic' || raw === 'all' ? 'monolithic' : 'split';

  if (mode === 'monolithic') {
    return {
      mode,
      entries: [{
        id: 'memory',
        port: 9338,
        args: ['--experimental-default-type=module', 'omni-memory-server.js'],
        env: { AI_MEMORY_SERVER_MODE: 'all', AI_MEMORY_METRICS_PORT: '9338' },
      }],
    };
  }

  return {
    mode,
    entries: SUBSETS.map((subset) => ({
      id: `memory-${subset}`,
      port: SPLIT_MEMORY_SERVER_PORTS[subset],
      args: ['--experimental-default-type=module', 'omni-memory-server.js'],
      env: {
        AI_MEMORY_SERVER_MODE: subset,
        AI_MEMORY_METRICS_PORT: String(SPLIT_MEMORY_METRICS_PORTS[subset]),
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
