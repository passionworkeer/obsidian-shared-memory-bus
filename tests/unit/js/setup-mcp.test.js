import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { activeServers, gooseBlock, makeUrl, parseArgs } from '../../../setup-mcp.js';

describe('setup-mcp argument parsing', () => {
  test('supports target, mode, and dry-run arguments', () => {
    assert.deepEqual(
      parseArgs(['node', 'setup-mcp.js', '--target=cursor,claude', '--mode', 'monolithic', '--dry-run']),
      {
        targets: 'cursor,claude',
        mode: 'monolithic',
        dryRun: true,
        help: false,
      },
    );
  });
});

describe('setup-mcp endpoint selection', () => {
  test('uses the split startup plan by default', () => {
    assert.deepEqual(
      activeServers({}).map((server) => server.id),
      ['fetch', 'time', 'memory-retrieval', 'memory-bridge', 'memory-dream', 'memory-mgmt'],
    );
  });

  test('uses the monolithic startup plan when requested', () => {
    assert.deepEqual(
      activeServers({ AI_MEMORY_SERVER_MODE: 'monolithic' }).map((server) => server.id),
      ['fetch', 'time', 'memory'],
    );
  });

  test('applies the configured base-port offset', () => {
    const fetchServer = activeServers({}).find((server) => server.id === 'fetch');
    assert.equal(
      makeUrl(fetchServer, { AI_MEMORY_BASE_PORT: '10000' }),
      'http://127.0.0.1:10002/mcp',
    );
  });
});

describe('Goose YAML generation', () => {
  test('generates one extensions key for all endpoints', () => {
    const yaml = gooseBlock({});
    assert.equal((yaml.match(/^extensions:$/gm) || []).length, 1);
    for (const id of ['fetch', 'time', 'memory-retrieval', 'memory-bridge', 'memory-dream', 'memory-mgmt']) {
      assert.match(yaml, new RegExp(`^  ${id}:$`, 'm'));
    }
  });
});
