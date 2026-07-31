/**
 * port-registry-split.test.js
 *
 * Guards the split memory registry contract:
 *   - four split memory entries plus one mutually-exclusive legacy entry
 *   - HTTP MCP proxy ports and child metrics ports are distinct
 *   - both port sets remain aligned by subset
 *   - legacy memory shares the retrieval MCP port only because the modes are exclusive
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_SERVERS,
  SPLIT_MEMORY_SERVER_PORTS,
  SPLIT_MEMORY_METRICS_PORTS,
  CRITICAL_PORTS,
} from '../../../shared-mcp/port-registry.js';

describe('MCP_SERVERS — four-server split integrity', () => {
  test('contains retrieval, bridge, dream, and management entries', () => {
    const memoryServers = MCP_SERVERS.filter((server) => server.id.startsWith('memory-'));
    assert.equal(memoryServers.length, 4);
    assert.deepEqual(
      memoryServers.map((server) => server.id),
      ['memory-retrieval', 'memory-bridge', 'memory-dream', 'memory-mgmt'],
    );
  });

  test('uses HTTP MCP proxy ports 9338 through 9341', () => {
    const ports = MCP_SERVERS
      .filter((server) => server.id.startsWith('memory-'))
      .map((server) => server.port)
      .sort((left, right) => left - right);
    assert.deepEqual(ports, [9338, 9339, 9340, 9341]);
  });

  test('each split entry declares its mode and a separate metrics port', () => {
    const memoryServers = MCP_SERVERS.filter((server) => server.id.startsWith('memory-'));
    for (const server of memoryServers) {
      assert.ok(server.env, `${server.id} should have an env object`);
      const expectedMode = server.id.replace('memory-', '');
      assert.equal(server.env.AI_MEMORY_SERVER_MODE, expectedMode);
      assert.equal(typeof server.metricsPort, 'number');
      assert.equal(server.metricsPort - server.port, 100);
      assert.notEqual(server.metricsPort, server.port);
    }
  });

  test('retains the mutually-exclusive legacy memory entry', () => {
    const legacy = MCP_SERVERS.find((server) => server.id === 'memory');
    assert.ok(legacy, 'legacy memory entry should remain available');
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.onlyInMode, 'monolithic');
    assert.equal(legacy.port, SPLIT_MEMORY_SERVER_PORTS.retrieval);
    assert.equal(legacy.metricsPort, SPLIT_MEMORY_METRICS_PORTS.retrieval);
  });
});

describe('split MCP and metrics port registries', () => {
  test('freezes the HTTP MCP port registry', () => {
    assert.ok(Object.isFrozen(SPLIT_MEMORY_SERVER_PORTS));
    assert.deepEqual(
      { ...SPLIT_MEMORY_SERVER_PORTS },
      { retrieval: 9338, bridge: 9339, dream: 9340, mgmt: 9341 },
    );
  });

  test('keeps child metrics on dedicated ports', () => {
    assert.ok(Object.isFrozen(SPLIT_MEMORY_METRICS_PORTS));
    assert.deepEqual(
      { ...SPLIT_MEMORY_METRICS_PORTS },
      { retrieval: 9438, bridge: 9439, dream: 9440, mgmt: 9441 },
    );
    for (const subset of Object.keys(SPLIT_MEMORY_SERVER_PORTS)) {
      assert.equal(
        SPLIT_MEMORY_METRICS_PORTS[subset] - SPLIT_MEMORY_SERVER_PORTS[subset],
        100,
      );
    }
  });

  test('matches each registry entry to its split server metadata', () => {
    const memoryServers = MCP_SERVERS.filter((server) => server.id.startsWith('memory-'));
    for (const server of memoryServers) {
      const subset = server.id.replace('memory-', '');
      assert.equal(server.port, SPLIT_MEMORY_SERVER_PORTS[subset]);
      assert.equal(server.metricsPort, SPLIT_MEMORY_METRICS_PORTS[subset]);
    }
  });
});

describe('CRITICAL_PORTS', () => {
  test('contains every externally exposed split MCP port', () => {
    for (const port of Object.values(SPLIT_MEMORY_SERVER_PORTS)) {
      assert.ok(CRITICAL_PORTS.includes(port), `CRITICAL_PORTS should include ${port}`);
    }
  });

  test('does not expose internal child metrics as client endpoints', () => {
    for (const port of Object.values(SPLIT_MEMORY_METRICS_PORTS)) {
      assert.equal(CRITICAL_PORTS.includes(port), false);
    }
  });
});
