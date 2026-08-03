#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const targetRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/smoke-installed-memory-services.mjs <target-root>');
  process.exit(2);
}
const server = path.join(targetRoot, 'shared-mcp', 'omni-memory-server.js');
if (!fs.existsSync(server)) throw new Error(`Missing installed server: ${server}`);
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-memory-smoke-'));
for (const directory of ['structured', 'generated', 'embeddings', 'state']) fs.mkdirSync(path.join(store, directory), { recursive: true });
fs.writeFileSync(path.join(store, 'structured', 'shared-inbox.jsonl'), `${JSON.stringify({
  schemaVersion: 2,
  id: 'installed-smoke',
  t: new Date().toISOString(),
  tool: 'ci',
  type: 'summary',
  project: 'installed-smoke',
  title: 'Installed runtime smoke',
  content: 'Installed memory runtime can initialize and serve tools.',
  source: 'shared-inbox',
  scope: 'project',
  visibility: 'shared',
  source_kind: 'writeback',
  memory_level: 'durable',
  workspace: 'installed-smoke',
  task_state: '',
  freshness: 'warm',
  confidence: 0.8,
  metadata: {},
})}\n`, 'utf8');

const cases = [
  ['retrieval', 'memory_status', {}],
  ['bridge', 'get_blackboard_tasks', { limit: 1 }],
  ['dream', 'run_memory_dream', { force: false }],
  ['mgmt', 'list_embedding_runtimes', {}],
];
for (const [mode, toolName, args] of cases) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-default-type=module', server],
    env: {
      ...process.env,
      AI_MEMORY_ROOT: targetRoot,
      AI_MEMORY_STORE: store,
      AI_MEMORY_STORE_ROOT: store,
      AI_MEMORY_SERVER_MODE: mode,
      AI_MEMORY_METRICS_PORT: '0',
      AI_MEMORY_PY_METRICS_PORT: '0',
      AI_MEMORY_RUNTIME_CONFIG_PATH: path.join(store, 'runtime.json'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'installed-runtime-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!listed.tools.some((tool) => tool.name === toolName)) throw new Error(`${mode} did not expose ${toolName}`);
    const response = await client.callTool({ name: toolName, arguments: args });
    if (!response || !Array.isArray(response.content)) throw new Error(`${mode}/${toolName} returned an invalid MCP response`);
    console.log(`${mode}: initialized, listed ${listed.tools.length} tools, called ${toolName}`);
  } finally {
    await client.close().catch(() => {});
  }
}
