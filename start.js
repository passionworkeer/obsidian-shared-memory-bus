#!/usr/bin/env node
/**
 * start.js - One-click start for all MCP servers
 *
 * Usage: node start.js
 *
 * Or use directly: npm start
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, 'shared-mcp');
const DEFAULT_STORE_ROOT = join(os.homedir(), '.ai-memory');
const DEFAULT_BASE_PORT = 9330;
const configuredBasePort = Number.parseInt(process.env.AI_MEMORY_BASE_PORT || '', 10);
const BASE_PORT = Number.isFinite(configuredBasePort) && configuredBasePort > 0
  ? configuredBasePort
  : DEFAULT_BASE_PORT;

// MCP servers configuration
const servers = [
  { id: 'fetch', port: 9332, command: 'python', args: ['-m', 'mcp_server_fetch'] },
  { id: 'time', port: 9333, command: 'python', args: ['-m', 'mcp_server_time'] },
  { id: 'memory', port: 9338, command: 'node', args: ['--experimental-default-type=module', 'omni-memory-server.js'] },
];

function getServerPort(server) {
  return BASE_PORT + (server.port - DEFAULT_BASE_PORT);
}

// Check if port is in use
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// Start a singleton stdio MCP proxy
function startSingletonProxy(serverId, port, stdioCommand) {
  const proxyScript = join(PROJECT_ROOT, 'singleton-stdio-mcp-proxy.mjs');

  // Base64 encode the stdio command
  const encodedCommand = Buffer.from(stdioCommand).toString('base64');
  const env = {
    ...process.env,
    AI_MEMORY_ROOT: process.env.AI_MEMORY_ROOT || __dirname,
    AI_MEMORY_STORE: process.env.AI_MEMORY_STORE || process.env.AI_MEMORY_STORE_ROOT || DEFAULT_STORE_ROOT,
  };

  const child = spawn('node', [
    proxyScript,
    '--server-id', serverId,
    '--port', String(port),
    '--stdio-command-b64', encodedCommand,
  ], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env,
  });

  child.on('error', (err) => {
    console.error(`[${serverId}] Error:`, err.message);
  });

  return child;
}

// Start PowerShell script
function startPowerShellScript(scriptPath, serverId, port) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], {
    stdio: 'inherit'
  });

  child.on('error', (err) => {
    console.error(`[${serverId}] Error:`, err.message);
  });

  return child;
}

async function main() {
  console.log('Starting AI Memory Bus MCP servers...\n');

  for (const server of servers) {
    const port = getServerPort(server);
    const inUse = await isPortInUse(port);

    if (inUse) {
      console.log(`[${server.id}] port ${port} already in use, skipping`);
      continue;
    }

    console.log(`[${server.id}] starting on port ${port}...`);

    if (server.script) {
      const scriptPath = join(__dirname, server.script);
      if (existsSync(scriptPath)) {
        startPowerShellScript(scriptPath, server.id, port);
      } else {
        console.log(`[${server.id}] script not found: ${scriptPath}`);
      }
    } else {
      const stdioCommand = `${server.command} ${server.args.join(' ')}`;
      startSingletonProxy(server.id, port, stdioCommand);
    }
  }

  console.log('\nMCP servers started!');
  console.log(`Memory: http://127.0.0.1:${getServerPort(servers.find((server) => server.id === 'memory'))}/mcp`);
  console.log(`Fetch: http://127.0.0.1:${getServerPort(servers.find((server) => server.id === 'fetch'))}/mcp`);
  console.log(`Time: http://127.0.0.1:${getServerPort(servers.find((server) => server.id === 'time'))}/mcp`);
}

// Run if called directly
main().catch(console.error);
