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
import { MCP_SERVERS, getServerPort, resolveBasePort } from './shared-mcp/port-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, 'shared-mcp');
const BASE_PORT = resolveBasePort();

// MCP servers configuration lives in shared-mcp/port-registry.js.

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
  };
  // Only forward explicit store env vars. Do NOT force ~/.ai-memory (the old
  // DEFAULT_STORE_ROOT fallback) — that would bypass resolveStoreRoot()'s vault
  // bridge and point the server at an empty store. When no store is set
  // explicitly, resolveStoreRoot() bridges to the Obsidian vault's
  // 00-System/ai-memory (canonical location per CLAUDE.md).
  if (process.env.AI_MEMORY_STORE) env.AI_MEMORY_STORE = process.env.AI_MEMORY_STORE;
  if (process.env.AI_MEMORY_STORE_ROOT) env.AI_MEMORY_STORE_ROOT = process.env.AI_MEMORY_STORE_ROOT;

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

  for (const server of MCP_SERVERS) {
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
  for (const server of MCP_SERVERS) {
    if (server.command === 'node' && server.id === 'memory') {
      console.log(`Memory: http://127.0.0.1:${getServerPort(server)}/mcp`);
    } else if (server.id === 'fetch') {
      console.log(`Fetch: http://127.0.0.1:${getServerPort(server)}/mcp`);
    } else if (server.id === 'time') {
      console.log(`Time: http://127.0.0.1:${getServerPort(server)}/mcp`);
    }
  }
}

// Run if called directly
main().catch(console.error);
