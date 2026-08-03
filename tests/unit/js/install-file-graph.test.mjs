import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildInstallGraph, validateImportClosure } from '../../../scripts/generate-install-file-graph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('generated install graph is deterministic and complete', () => {
  const first = buildInstallGraph();
  const second = buildInstallGraph();
  assert.deepEqual(first, second);
  assert.ok(first.entries.length > 200);
  validateImportClosure(first.entries);

  const destinations = new Set(first.entries.map((entry) => entry.destination));
  for (const required of [
    'memory-bus.ps1',
    'memory-bus-cache.ps1',
    'memory-bus-sync-time.ps1',
    'bus/embedding-providers/openai-compatible-provider.js',
    'ops/mcp/canonical-memory-write.js',
    'ops/util/safe-realpath.js',
    'retrieval/search_server.py',
    'cli/commands/doctor.js',
    'shared-mcp/proto/rpc.mjs',
    'shared-mcp/metrics/server.js',
    'shared-mcp/scripts/blackboard_query.py',
  ]) {
    assert.ok(destinations.has(required), `missing ${required}`);
  }

  for (const excluded of [
    'ops/bench/bench-detect-conflicts.js',
    'ops/extract/extraction-stress-test.mjs',
    'retrieval/semantic-search-cli.test.js',
  ]) {
    assert.equal(destinations.has(excluded), false, `legacy/dev file installed: ${excluded}`);
  }
});

test('committed install graph matches generated graph', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/install-files.json'), 'utf8'));
  assert.deepEqual(committed, buildInstallGraph());
});
