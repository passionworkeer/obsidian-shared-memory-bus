#!/usr/bin/env node
/**
 * Configure supported MCP clients to use the same core endpoints as start.js.
 *
 * Usage:
 *   node setup-mcp.js
 *   node setup-mcp.js --target=cursor,claude
 *   node setup-mcp.js --mode=monolithic
 *   node setup-mcp.js --dry-run
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MCP_SERVERS, getServerPort, resolveBasePort } from './shared-mcp/port-registry.js';
import { selectServersForSpawn } from './shared-mcp/spawn-plan.js';

const __filename = fileURLToPath(import.meta.url);

const AGENT_REGISTRY = {
  claude: {
    name: 'Claude Desktop',
    docUrl: 'https://modelcontextprotocol.io/quickstart/user-guide',
    configPath: () => ({
      darwin: [join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
      win32: [join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')],
      linux: [join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')],
    }),
    format: 'json',
  },
  cursor: {
    name: 'Cursor',
    docUrl: 'https://docs.cursor.com/context/model-context-protocol',
    configPath: () => ({ any: [join(homedir(), '.cursor', 'mcp.json')] }),
    format: 'json',
  },
  kiro: {
    name: 'Kiro',
    docUrl: 'https://kiro.dev/docs/mcp/configuration/',
    configPath: () => ({ any: [join(homedir(), '.kiro', 'settings', 'mcp.json')] }),
    format: 'json',
  },
  windsurf: {
    name: 'Windsurf',
    docUrl: 'https://docs.codeium.com/windsurf/mcp',
    configPath: () => ({ any: [join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')] }),
    format: 'json',
  },
  cline: {
    name: 'Cline',
    docUrl: 'https://docs.cline.bot/mcp/mcp-overview',
    configPath: vscodeExtensionPaths('saoudrizwan.claude-dev', 'settings/cline_mcp_settings.json'),
    format: 'json',
  },
  roo: {
    name: 'Roo Code',
    docUrl: 'https://docs.roocode.com/features/mcp/overview',
    configPath: vscodeExtensionPaths('rooveterinaryinc.roo-cline', 'settings/mcp_settings.json'),
    format: 'json',
  },
  goose: {
    name: 'Goose',
    docUrl: 'https://goose-docs.ai/docs/getting-started/using-extensions/',
    configPath: () => ({ any: [join(homedir(), '.config', 'goose', 'config.yaml')] }),
    format: 'goose-yaml',
  },
  qoder: {
    name: 'Qoder',
    docUrl: 'https://docs.qoder.com/user-guide/chat/model-context-protocol',
    configPath: () => ({ any: [join(homedir(), '.qoder', 'mcp.json')] }),
    format: 'json',
    unverified: true,
  },
};

const GOOSE_BEGIN = '# >>> shared-memory-bus mcp >>>';
const GOOSE_END = '# <<< shared-memory-bus mcp <<<';

function vscodeExtensionPaths(extensionId, relativePath) {
  return () => {
    const platformRoot = {
      win32: join(homedir(), 'AppData', 'Roaming'),
      darwin: join(homedir(), 'Library', 'Application Support'),
      linux: join(homedir(), '.config'),
    }[process.platform];
    if (!platformRoot) return { any: [] };

    return {
      any: ['Code', 'Code - Insiders'].map((variant) =>
        join(platformRoot, variant, 'User', 'globalStorage', extensionId, relativePath),
      ),
    };
  };
}

export function parseArgs(argv) {
  const result = { targets: null, dryRun: false, help: false, mode: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') result.help = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg.startsWith('--target=')) result.targets = arg.slice('--target='.length);
    else if (arg === '--target') result.targets = argv[++index] || '';
    else if (arg.startsWith('--mode=')) result.mode = arg.slice('--mode='.length);
    else if (arg === '--mode') result.mode = argv[++index] || '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function resolveTargets(raw) {
  if (!raw || raw === 'all') return Object.keys(AGENT_REGISTRY);
  const ids = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const invalid = ids.filter((id) => !AGENT_REGISTRY[id]);
  if (invalid.length) {
    throw new Error(`Unknown target(s): ${invalid.join(', ')}. Known targets: ${Object.keys(AGENT_REGISTRY).join(', ')}`);
  }
  return ids;
}

export function activeServers(env = process.env) {
  return selectServersForSpawn(MCP_SERVERS, env);
}

export function normalizeLoopbackHost(value) {
  const raw = String(value || '127.0.0.1').trim().toLowerCase();
  if (!raw || /[\s\r\n/?#@]/.test(raw)) {
    throw new Error(`Invalid AI_MEMORY_HOST: ${value}`);
  }
  if (raw === '127.0.0.1' || raw === 'localhost') return raw;
  if (raw === '::1' || raw === '[::1]') return '[::1]';
  throw new Error(`AI_MEMORY_HOST must be loopback: ${value}`);
}

export function makeUrl(server, env = process.env) {
  const host = normalizeLoopbackHost(env.AI_MEMORY_HOST || '127.0.0.1');
  const basePort = resolveBasePort(env);
  return `http://${host}:${getServerPort(server, basePort)}/mcp`;
}

function candidatePaths(agent) {
  const byPlatform = agent.configPath();
  return [...(byPlatform[process.platform] || []), ...(byPlatform.any || [])];
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Refusing to overwrite invalid JSON at ${path}: ${error.message}`);
  }
}

function writeJsonConfig(path, env, { dryRun }) {
  const config = loadJson(path);
  if (config.mcpServers == null) config.mcpServers = {};
  if (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    throw new Error(`Expected mcpServers to be an object in ${path}`);
  }

  const result = { added: [], updated: [], skipped: [], hinted: false };
  for (const server of activeServers(env)) {
    const next = { url: makeUrl(server, env) };
    const current = config.mcpServers[server.id];
    if (!current) {
      config.mcpServers[server.id] = next;
      result.added.push(server.id);
    } else if (current.url !== next.url || Object.keys(current).length !== 1) {
      config.mcpServers[server.id] = next;
      result.updated.push(server.id);
    } else {
      result.skipped.push(server.id);
    }
  }

  if (!dryRun && (result.added.length || result.updated.length || !existsSync(path))) {
    writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return result;
}

export function gooseBlock(env = process.env) {
  const lines = [GOOSE_BEGIN, 'extensions:'];
  for (const server of activeServers(env)) {
    lines.push(`  ${server.id}:`);
    lines.push('    type: remote');
    lines.push(`    url: ${JSON.stringify(makeUrl(server, env))}`);
    lines.push('    enabled: true');
  }
  lines.push(GOOSE_END);
  return `${lines.join('\n')}\n`;
}

function writeGooseConfig(path, env, { dryRun }) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const block = gooseBlock(env);
  const beginIndex = existing.indexOf(GOOSE_BEGIN);
  const endIndex = existing.indexOf(GOOSE_END);
  const hasManagedBlock = beginIndex !== -1 && endIndex > beginIndex;

  let next;
  if (hasManagedBlock) {
    next = existing.slice(0, beginIndex) + block + existing.slice(endIndex + GOOSE_END.length).replace(/^\r?\n/, '');
  } else if (/^extensions:\s*$/m.test(existing)) {
    return {
      added: [],
      updated: [],
      skipped: [],
      hinted: true,
      hint: `Goose already has an unmanaged extensions block in ${path}; merge the generated block manually to avoid duplicate YAML keys.`,
    };
  } else {
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = existing + separator + block;
  }

  if (!dryRun && next !== existing) writeAtomic(path, next);
  const ids = activeServers(env).map((server) => server.id);
  return {
    added: hasManagedBlock ? [] : ids,
    updated: hasManagedBlock ? ids : [],
    skipped: [],
    hinted: false,
  };
}

function manualHint(agent, path, env) {
  const entries = Object.fromEntries(
    activeServers(env).map((server) => [server.id, { url: makeUrl(server, env) }]),
  );
  return [
    `${agent.name} config path is not verified, so it was not modified: ${path}`,
    JSON.stringify({ mcpServers: entries }, null, 2),
    agent.docUrl ? `Docs: ${agent.docUrl}` : '',
  ].filter(Boolean).join('\n');
}

function configureAgent(agentId, env, options) {
  const agent = AGENT_REGISTRY[agentId];
  const paths = candidatePaths(agent);
  const settingsPath = paths.find((path) => existsSync(path)) || paths[0];
  if (!settingsPath) throw new Error(`No config path is available for ${agent.name} on ${process.platform}`);

  console.log(`\n=== ${agent.name} (${agentId}) ===`);
  if (agent.unverified && !existsSync(settingsPath)) {
    const hint = manualHint(agent, settingsPath, env);
    console.log(hint);
    return { added: [], updated: [], skipped: [], hinted: true };
  }

  const result = agent.format === 'goose-yaml'
    ? writeGooseConfig(settingsPath, env, options)
    : writeJsonConfig(settingsPath, env, options);

  for (const id of result.added) console.log(`[setup-mcp] + ${id}`);
  for (const id of result.updated) console.log(`[setup-mcp] ~ ${id}: endpoint refreshed`);
  for (const id of result.skipped) console.log(`[setup-mcp] = ${id}: already correct`);
  if (result.hint) console.warn(`[setup-mcp] ${result.hint}`);

  if (!result.hinted && (result.added.length || result.updated.length)) {
    console.log(options.dryRun ? `[setup-mcp] [dry-run] would update ${settingsPath}` : `[setup-mcp] Updated ${settingsPath}`);
  }
  return result;
}

function printHelp() {
  console.log('setup-mcp.js - register the core shared MCP endpoints\n');
  console.log('Usage:');
  console.log('  node setup-mcp.js [--target=<agent|all>] [--mode=<split|monolithic>] [--dry-run]');
  console.log('\nSupported targets:');
  for (const [id, agent] of Object.entries(AGENT_REGISTRY)) {
    console.log(`  ${id.padEnd(11)} ${agent.name}${agent.unverified ? ' (manual unless path exists)' : ''}`);
  }
}

export function main(argv = process.argv, baseEnv = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const env = { ...baseEnv };
  if (args.mode) {
    const normalized = args.mode.trim().toLowerCase();
    if (!['split', 'monolithic', 'all'].includes(normalized)) {
      throw new Error(`Unsupported mode: ${args.mode}`);
    }
    env.AI_MEMORY_SERVER_MODE = normalized;
  }

  const targets = resolveTargets(args.targets);
  console.log(`[setup-mcp] targets: ${targets.join(', ')}${args.dryRun ? ' (dry-run)' : ''}`);
  console.log(`[setup-mcp] endpoints: ${activeServers(env).map((server) => `${server.id}=${makeUrl(server, env)}`).join(', ')}`);

  let changed = 0;
  let hinted = 0;
  for (const id of targets) {
    const result = configureAgent(id, env, { dryRun: args.dryRun });
    changed += result.added.length + result.updated.length;
    hinted += result.hinted ? 1 : 0;
  }
  console.log(`\n[setup-mcp] done. ${changed} endpoint(s) added/refreshed; ${hinted} target(s) require manual review.`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (error) {
    console.error(`[setup-mcp] ${error.message}`);
    process.exitCode = 1;
  }
}
