import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeServers,
  gooseBlock,
  makeUrl,
  normalizeLoopbackHost,
  parseArgs,
} from '../../../setup-mcp.js';

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

describe('setup-mcp host validation', () => {
  test('accepts only loopback host spellings', () => {
    assert.equal(normalizeLoopbackHost('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeLoopbackHost('LOCALHOST'), 'localhost');
    assert.equal(normalizeLoopbackHost('::1'), '[::1]');
    assert.equal(normalizeLoopbackHost('[::1]'), '[::1]');
  });

  test('rejects remote, credentialed, and control-character hosts', () => {
    for (const host of [
      'evil.example',
      '192.168.1.50',
      '127.0.0.1.evil.example',
      'user@127.0.0.1',
      '127.0.0.1/path',
      '127.0.0.1\nmalicious: true',
    ]) {
      assert.throws(() => normalizeLoopbackHost(host), /AI_MEMORY_HOST/);
    }
  });

  test('cannot redirect generated agent endpoints to a remote host', () => {
    const fetchServer = activeServers({}).find((server) => server.id === 'fetch');
    assert.throws(
      () => makeUrl(fetchServer, { AI_MEMORY_HOST: 'attacker.example' }),
      /must be loopback/,
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

  test('quotes generated URLs as YAML scalars', () => {
    const yaml = gooseBlock({ AI_MEMORY_HOST: 'localhost' });
    assert.match(yaml, /^    url: "http:\/\/localhost:\d+\/mcp"$/m);
  });
});
