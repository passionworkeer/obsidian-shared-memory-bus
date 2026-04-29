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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, 'shared-mcp');

// MCP servers configuration
const servers = [
  { id: 'fetch', port: 9332, command: 'python', args: ['-m', 'mcp_server_fetch'] },
  { id: 'time', port: 9333, command: 'python', args: ['-m', 'mcp_server_time'] },
  { id: 'obsidian', port: 9335, script: 'ops/run/run-obsidian-mcp.ps1' },
  { id: 'memory', port: 9338, command: 'node', args: ['--experimental-default-type=module', 'omni-memory-server.js'] },
];

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

  const child = spawn('node', [
    proxyScript,
    '--server-id', serverId,
    '--port', String(port),
    '--stdio-command-b64', encodedCommand,
  ], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, AI_MEMORY_ROOT: __dirname }
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
    const inUse = await isPortInUse(server.port);

    if (inUse) {
      console.log(`[${server.id}] port ${server.port} already in use, skipping`);
      continue;
    }

    console.log(`[${server.id}] starting on port ${server.port}...`);

    if (server.script) {
      const scriptPath = join(__dirname, server.script);
      if (existsSync(scriptPath)) {
        startPowerShellScript(scriptPath, server.id, server.port);
      } else {
        console.log(`[${server.id}] script not found: ${scriptPath}`);
      }
    } else {
      const stdioCommand = `${server.command} ${server.args.join(' ')}`;
      startSingletonProxy(server.id, server.port, stdioCommand);
    }
  }

  console.log('\nMCP servers started!');
  console.log('Memory: http://127.0.0.1:9338/mcp');
  console.log('Obsidian: http://127.0.0.1:9335/mcp');
  console.log('Fetch: http://127.0.0.1:9332/mcp');
  console.log('Time: http://127.0.0.1:9333/mcp');
}

// Run if called directly
main().catch(console.error);
