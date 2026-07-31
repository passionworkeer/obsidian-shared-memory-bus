import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSpawnPlan, selectServersForSpawn } from '../../../shared-mcp/spawn-plan.js';
import {
  MCP_SERVERS,
  getServerMetricsPort,
  getServerPort,
} from '../../../shared-mcp/port-registry.js';

describe('resolveSpawnPlan', () => {
  test('defaults to split mode', () => {
    const plan = resolveSpawnPlan({});
    assert.equal(plan.mode, 'split');
    assert.deepEqual(
      plan.entries.map((entry) => entry.id),
      ['memory-retrieval', 'memory-bridge', 'memory-dream', 'memory-mgmt'],
    );
  });

  test('accepts monolithic and all as legacy mode aliases', () => {
    for (const value of ['monolithic', 'all', ' MONOLITHIC ']) {
      const plan = resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: value });
      assert.equal(plan.mode, 'monolithic');
      assert.deepEqual(plan.entries.map((entry) => entry.id), ['memory']);
    }
  });

  test('falls back to split for unknown values', () => {
    assert.equal(
      resolveSpawnPlan({ AI_MEMORY_SERVER_MODE: 'retrieval-only' }).mode,
      'split',
    );
  });

  test('keeps child metrics separate from HTTP MCP proxy ports', () => {
    const plan = resolveSpawnPlan({});
    for (const entry of plan.entries) {
      assert.notEqual(entry.metricsPort, entry.port);
      assert.equal(entry.metricsPort - entry.port, 100);
      assert.equal(entry.env.AI_MEMORY_METRICS_PORT, String(entry.metricsPort));
    }
  });

  test('shifts MCP and metrics ports together with AI_MEMORY_BASE_PORT', () => {
    const plan = resolveSpawnPlan({ AI_MEMORY_BASE_PORT: '10000' });
    assert.deepEqual(
      plan.entries.map(({ port, metricsPort }) => [port, metricsPort]),
      [
        [10008, 10108],
        [10009, 10109],
        [10010, 10110],
        [10011, 10111],
      ],
    );
  });
});

describe('selectServersForSpawn', () => {
  test('keeps utility servers in split mode', () => {
    const ids = selectServersForSpawn(MCP_SERVERS, {}).map((server) => server.id);
    assert.deepEqual(ids, [
      'fetch',
      'time',
      'memory-retrieval',
      'memory-bridge',
      'memory-dream',
      'memory-mgmt',
    ]);
  });

  test('keeps utility servers and only legacy memory in monolithic mode', () => {
    const ids = selectServersForSpawn(MCP_SERVERS, {
      AI_MEMORY_SERVER_MODE: 'monolithic',
    }).map((server) => server.id);

    assert.deepEqual(ids, ['fetch', 'time', 'memory']);
  });

  test('never selects split and legacy memory together', () => {
    for (const env of [{}, { AI_MEMORY_SERVER_MODE: 'monolithic' }]) {
      const memoryIds = selectServersForSpawn(MCP_SERVERS, env)
        .map((server) => server.id)
        .filter((id) => id === 'memory' || id.startsWith('memory-'));
      const hasLegacy = memoryIds.includes('memory');
      const hasSplit = memoryIds.some((id) => id.startsWith('memory-'));
      assert.equal(hasLegacy && hasSplit, false);
    }
  });

  test('registry helpers return distinct shifted ports', () => {
    const server = MCP_SERVERS.find((candidate) => candidate.id === 'memory-retrieval');
    assert.equal(getServerPort(server, 10000), 10008);
    assert.equal(getServerMetricsPort(server, 10000), 10108);
  });
});
