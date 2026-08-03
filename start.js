#!/usr/bin/env node
/**
 * Start the core shared MCP services.
 *
 * Utility services (fetch and time) are always started. Memory services use
 * split mode by default and can be switched to the legacy monolithic process
 * with AI_MEMORY_SERVER_MODE=monolithic.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveStoreRoot } from './bus/store-root.js';
import {
  MCP_SERVERS,
  getServerMetricsPort,
  getServerPort,
} from './shared-mcp/port-registry.js';
import { resolveSpawnPlan, selectServersForSpawn } from './shared-mcp/spawn-plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, 'shared-mcp');
const children = new Set();

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

async function probeExistingService(serverId, port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    const payload = await response.json();
    return {
      ok: response.ok && payload?.ok === true && payload?.serverId === serverId,
      payload,
      status: response.status,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function trackChild(child, serverId) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', (error) => {
    console.error(`[${serverId}] failed to start: ${error.message}`);
  });
  return child;
}

function startSingletonProxy(serverId, port, stdioCommand, envOverrides = {}) {
  const proxyScript = join(PROJECT_ROOT, 'singleton-stdio-mcp-proxy.mjs');
  const encodedCommand = Buffer.from(stdioCommand).toString('base64');
  const child = spawn(process.execPath, [
    proxyScript,
    '--server-id', serverId,
    '--port', String(port),
    '--stdio-command-b64', encodedCommand,
  ], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
  });

  return trackChild(child, serverId);
}

function startPowerShellScript(scriptPath, serverId) {
  const executable = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  const child = spawn(executable, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], { stdio: 'inherit' });

  return trackChild(child, serverId);
}

function stopChildren(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

async function main() {
  const plan = resolveSpawnPlan(process.env);
  const serversToSpawn = selectServersForSpawn(MCP_SERVERS, process.env);
  const activeServers = [];
  const runtimeConfigPath = process.env.AI_MEMORY_RUNTIME_CONFIG_PATH ||
    join(resolveStoreRoot(), 'config', 'runtime.json');

  console.log(`Starting core MCP services (memory mode=${plan.mode})...\n`);

  for (const server of serversToSpawn) {
    const port = getServerPort(server);
    if (await isPortInUse(port)) {
      const probe = await probeExistingService(server.id, port);
      if (!probe.ok) {
        throw new Error(
          `[${server.id}] port ${port} is occupied by an unknown or unhealthy service: ${JSON.stringify(probe)}`,
        );
      }
      console.warn(`[${server.id}] healthy matching service already owns port ${port}; adopting`);
      activeServers.push(server);
      continue;
    }

    console.log(`[${server.id}] starting on port ${port}...`);

    if (server.script) {
      const scriptPath = join(__dirname, server.script);
      if (!existsSync(scriptPath)) {
        throw new Error(`[${server.id}] script not found: ${scriptPath}`);
      }
      startPowerShellScript(scriptPath, server.id);
      activeServers.push(server);
      continue;
    }

    const env = {
      ...process.env,
      ...(server.env || {}),
      AI_MEMORY_ROOT: process.env.AI_MEMORY_ROOT || __dirname,
      AI_MEMORY_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    };
    const metricsPort = getServerMetricsPort(server);
    if (metricsPort !== null) env.AI_MEMORY_METRICS_PORT = String(metricsPort);
    if (process.env.AI_MEMORY_STORE) env.AI_MEMORY_STORE = process.env.AI_MEMORY_STORE;
    if (process.env.AI_MEMORY_STORE_ROOT) env.AI_MEMORY_STORE_ROOT = process.env.AI_MEMORY_STORE_ROOT;

    const stdioCommand = [server.command, ...server.args].join(' ');
    startSingletonProxy(server.id, port, stdioCommand, env);
    activeServers.push(server);
  }

  console.log('\nCore MCP endpoints:');
  for (const server of activeServers) {
    console.log(`- ${server.id}: http://127.0.0.1:${getServerPort(server)}/mcp`);
  }
}

process.once('SIGINT', () => {
  stopChildren('SIGINT');
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopChildren('SIGTERM');
  process.exit(143);
});

main().catch((error) => {
  console.error(error);
  stopChildren('SIGTERM');
  process.exitCode = 1;
});
