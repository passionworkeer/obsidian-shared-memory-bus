#!/usr/bin/env node
/**
 * setup-mcp.js - Configure Claude Code to connect to shared MCP servers
 *
 * Cross-platform (Node.js only, no PowerShell required)
 * Usage: node setup-mcp.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, 'shared-mcp/manifest.json');

// Platform-specific Claude Code settings paths
function findSettingsPath() {
  const home = homedir();
  const candidates = {
    darwin: [
      join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    ],
    win32: [
      join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    ],
    linux: [
      join(home, 'config', 'Claude', 'claude_desktop_config.json'),
      join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    ],
  };
  return candidates[process.platform] || [];
}

function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    console.error(`[setup-mcp] manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
}

function loadSettings(settingsPath) {
  try {
    if (!existsSync(settingsPath)) {
      return null;
    }
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
}

function saveSettings(settingsPath, config) {
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function makeUrl(manifest, server) {
  const host = manifest.defaults.host || '127.0.0.1';
  const path = manifest.defaults.path || '/mcp';
  return `http://${host}:${server.port}${path}`;
}

function main() {
  const manifest = loadManifest();

  // Find Claude Code settings
  const candidates = findSettingsPath();
  let settingsPath = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      settingsPath = p;
      break;
    }
  }

  if (!settingsPath) {
    console.log('[setup-mcp] Claude Code config not found.');
    console.log('[setup-mcp] Please add these MCP servers to your Claude Code settings:');
    console.log();
    for (const server of manifest.servers) {
      if (server.mode === 'shared') {
        console.log(`  ${server.id}: ${makeUrl(manifest, server)}`);
      }
    }
    return;
  }

  let config = loadSettings(settingsPath);
  if (!config) {
    console.error(`[setup-mcp] Could not read ${settingsPath}`);
    return;
  }

  // Ensure mcpServers object exists
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add shared servers
  const sharedServers = manifest.servers.filter(s =>
    s.mode === 'shared' && s.port && s.id !== 'pencil'
  );

  let added = 0;
  for (const server of sharedServers) {
    const url = makeUrl(manifest, server);
    if (!config.mcpServers[server.id]) {
      config.mcpServers[server.id] = { url };
      added++;
      console.log(`[setup-mcp] + ${server.id}: ${url}`);
    } else {
      console.log(`[setup-mcp] ~ ${server.id}: already configured, skipping`);
    }
  }

  if (added === 0) {
    console.log('[setup-mcp] All servers already configured.');
    return;
  }

  saveSettings(settingsPath, config);
  console.log(`\n[setup-mcp] Updated ${settingsPath}`);
  console.log('[setup-mcp] Restart Claude Code to activate the MCP servers.');
}

main();
