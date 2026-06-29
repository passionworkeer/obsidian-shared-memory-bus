#!/usr/bin/env node
/**
 * setup-mcp.js - Configure any MCP-capable AI agent to connect to shared MCP servers
 *
 * Cross-platform (Node.js only, no PowerShell required).
 *
 * Usage:
 *   node setup-mcp.js                       # all known agents (default)
 *   node setup-mcp.js --target=claude        # one specific agent
 *   node setup-mcp.js --target=cursor,kiro   # multiple agents
 *   node setup-mcp.js --target=all           # explicit all
 *   node setup-mcp.js --dry-run              # show what would change, write nothing
 *   node setup-mcp.js --help                 # list supported targets
 *
 * Each agent's MCP config path, format, and entry shape live in AGENT_REGISTRY.
 * To support a new agent, add one entry to AGENT_REGISTRY — nothing else changes.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, 'shared-mcp/manifest.json');

// --- AGENT_REGISTRY -------------------------------------------------------
// Map of agentId -> { name, configPath(platform), format, docUrl, httpEntryShape }
// configPath returns an array of candidate paths; the first that exists wins.
// If none exists, setup prints a manual-config hint for that agent (no error).
//
// httpEntryShape: how this agent encodes one HTTP/streamable MCP endpoint.
//   'url-bare'     -> { url }                  (Claude Desktop, Cursor, Kiro, Windsurf)
//   'vscode-json'  -> mcpServers.{id}: { url } inside globalStorage JSON (Cline, Roo)
//   'goose-yaml'   -> extensions.{id} block in Goose config.yaml
//
// Verified via WebSearch (2026-06): see docUrl per agent.
// Format notes:
//   - Our endpoints are HTTP streamable (http://127.0.0.1:PORT/mcp), NOT stdio.
//   - Claude Desktop uses { url }; Cursor mcp.json uses { url }; Kiro mcp.json
//     supports { url } for streamable-http; Windsurf mcp_config.json uses { url }.
//   - Cline & Roo Code store mcpServers JSON in VS Code globalStorage.
//   - Goose uses config.yaml with an `extensions` block (Remote/streamable-http).
const AGENT_REGISTRY = {
  claude: {
    name: 'Claude Desktop',
    docUrl: 'https://modelcontextprotocol.io/quickstart/user-guide',
    configPath: () => ({
      darwin: [join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
      win32: [join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')],
      linux: [
        join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
        join(homedir(), 'config', 'Claude', 'claude_desktop_config.json'),
      ],
    }),
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  cursor: {
    name: 'Cursor',
    docUrl: 'https://docs.cursor.com/context/model-context-protocol',
    configPath: () => ({
      any: [join(homedir(), '.cursor', 'mcp.json')],
    }),
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  kiro: {
    name: 'Kiro',
    docUrl: 'https://kiro.dev/docs/mcp/configuration/',
    configPath: () => ({
      any: [join(homedir(), '.kiro', 'settings', 'mcp.json')],
    }),
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  windsurf: {
    name: 'Windsurf',
    docUrl: 'https://docs.codeium.com/windsurf/mcp',
    configPath: () => ({
      any: [join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')],
    }),
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  cline: {
    name: 'Cline',
    docUrl: 'https://docs.cline.bot/mcp/mcp-overview',
    // VS Code globalStorage; extension id = saoudrizwan.claude-dev
    // Code variants: 'Code' (stable) and 'Code - Insiders'. Both probed.
    configPath: () => {
      const base = {
        win32: join(homedir(), 'AppData', 'Roaming'),
        darwin: join(homedir(), 'Library', 'Application Support'),
        linux: join(homedir(), '.config'),
      };
      const root = base[process.platform];
      if (!root) return { any: [] };
      const variants = process.platform === 'darwin' ? ['Code', 'Code - Insiders'] : ['Code', 'Code - Insiders'];
      const any = variants.flatMap(v => [
        join(root, v, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      ]);
      return { any };
    },
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  roo: {
    name: 'Roo Code',
    docUrl: 'https://docs.roocode.com/features/mcp/overview',
    // VS Code globalStorage; extension id = rooveterinaryinc.roo-cline
    configPath: () => {
      const base = {
        win32: join(homedir(), 'AppData', 'Roaming'),
        darwin: join(homedir(), 'Library', 'Application Support'),
        linux: join(homedir(), '.config'),
      };
      const root = base[process.platform];
      if (!root) return { any: [] };
      const variants = ['Code', 'Code - Insiders'];
      const any = variants.flatMap(v => [
        join(root, v, 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
      ]);
      return { any };
    },
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
  },

  goose: {
    name: 'Goose',
    docUrl: 'https://goose-docs.ai/docs/getting-started/using-extensions/',
    configPath: () => ({
      any: [join(homedir(), '.config', 'goose', 'config.yaml')],
    }),
    // Goose uses a YAML `extensions` block with a Remote (streamable-http) entry.
    format: 'goose-yaml',
    httpEntryShape: 'goose-yaml',
  },

  qoder: {
    name: 'Qoder',
    docUrl: 'https://docs.qoder.com/user-guide/chat/model-context-protocol',
    // TODO: verify Qoder config file path/format (2026-06). Official docs route
    // through UI "+ Add"; on-disk path not confirmed. Hint-only, no auto-write.
    configPath: () => ({ any: [join(homedir(), '.qoder', 'mcp.json')] }),
    format: 'json-mcpServers',
    httpEntryShape: 'url-bare',
    unverified: true,
  },
};

// --- argv parsing ---------------------------------------------------------
function parseArgs(argv) {
  const out = { targets: null, dryRun: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--target=')) out.targets = a.slice('--target='.length);
    else if (a.startsWith('--target')) out.targets = a.split('=')[1] || '';
  }
  return out;
}

function resolveTargets(raw) {
  if (!raw || raw === 'all') return Object.keys(AGENT_REGISTRY);
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  const invalid = ids.filter(id => !AGENT_REGISTRY[id]);
  if (invalid.length) {
    console.error(`[setup-mcp] Unknown target(s): ${invalid.join(', ')}`);
    console.error(`[setup-mcp] Known targets: ${Object.keys(AGENT_REGISTRY).join(', ')}, all`);
    process.exit(2);
  }
  return ids;
}

function printHelp() {
  console.log('setup-mcp.js - register shared MCP servers with AI agents\n');
  console.log('Usage:');
  console.log('  node setup-mcp.js                       configure all known agents');
  console.log('  node setup-mcp.js --target=<agent|all>  configure one or several agents');
  console.log('  node setup-mcp.js --target=a,b          multiple agents');
  console.log('  node setup-mcp.js --dry-run             show changes, write nothing');
  console.log('  node setup-mcp.js --help                this message\n');
  console.log('Supported targets:');
  for (const [id, info] of Object.entries(AGENT_REGISTRY)) {
    const flag = info.unverified ? ' (path unverified)' : '';
    console.log(`  ${id.padEnd(11)} ${info.name}${flag}`);
  }
  console.log(`  ${'all'.padEnd(11)} every target above`);
}

// --- manifest + url helpers ----------------------------------------------
function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    console.error(`[setup-mcp] manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
}

function sharedServers(manifest) {
  // Expose shared HTTP endpoints only. pencil is isolated/UI-bound; skip.
  return manifest.servers.filter(s => s.mode === 'shared' && s.port && s.id !== 'pencil');
}

function makeUrl(manifest, server) {
  const host = manifest.defaults.host || '127.0.0.1';
  const path = manifest.defaults.path || '/mcp';
  return `http://${host}:${server.port}${path}`;
}

// --- per-agent config IO --------------------------------------------------
function candidatePaths(agent) {
  const byPlatform = typeof agent.configPath === 'function' ? agent.configPath() : agent.configPath;
  return [...(byPlatform[process.platform] || []), ...(byPlatform.any || [])];
}

function loadJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function saveJson(path, config) {
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function saveText(path, text) {
  writeFileSync(path, text, 'utf8');
}

// --- entry writers --------------------------------------------------------
// Returns { added:[ids], skipped:[ids], hint:<string|null> }
function writeJsonMcpServers(agent, settingsPath, manifest, { dryRun }) {
  let config = loadJson(settingsPath);
  if (!config) {
    return { added: [], skipped: [], hint: manualHintJson(agent, settingsPath, manifest) };
  }
  if (!config.mcpServers) config.mcpServers = {};

  const added = [];
  const skipped = [];
  for (const server of sharedServers(manifest)) {
    const url = makeUrl(manifest, server);
    if (!config.mcpServers[server.id]) {
      config.mcpServers[server.id] = { url };
      added.push(server.id);
    } else {
      skipped.push(server.id);
    }
  }

  if (added.length && !dryRun) saveJson(settingsPath, config);
  return { added, skipped, hint: null };
}

// Goose config.yaml: append/replace an `extensions` block per endpoint.
// We never parse YAML generically; we only manage our own markers so the
// operation is idempotent and never clobbers unrelated Goose config.
const GOOSE_BEGIN = '# >>> shared-memory-bus mcp >>>';
const GOOSE_END = '# <<< shared-memory-bus mcp <<<';

function gooseBlock(manifest) {
  const lines = [GOOSE_BEGIN];
  for (const server of sharedServers(manifest)) {
    const url = makeUrl(manifest, server);
    lines.push(`extensions:`);
    lines.push(`  ${server.id}:`);
    lines.push(`    type: remote`);
    lines.push(`    url: ${url}`);
    lines.push(`    enabled: true`);
  }
  lines.push(GOOSE_END);
  return lines.join('\n') + '\n';
}

function writeGooseYaml(agent, settingsPath, manifest, { dryRun }) {
  const existing = readText(settingsPath);
  const block = gooseBlock(manifest);
  if (existing == null) {
    return { added: [], skipped: [], hint: manualHintGoose(agent, settingsPath, manifest) };
  }

  let next;
  const beginIdx = existing.indexOf(GOOSE_BEGIN);
  const endIdx = existing.indexOf(GOOSE_END);
  const hasManaged = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  if (hasManaged) {
    // Replace the existing managed span in place. Counts as "skipped" since ids unchanged.
    next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + GOOSE_END.length);
    if (!dryRun) saveText(settingsPath, next);
    return { added: [], skipped: sharedServers(manifest).map(s => s.id), hint: null };
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  next = existing + sep + block;
  if (!dryRun) saveText(settingsPath, next);
  return { added: sharedServers(manifest).map(s => s.id), skipped: [], hint: null };
}

// --- manual hints (config file not found) ---------------------------------
function manualHintJson(agent, settingsPath, manifest) {
  const lines = [];
  lines.push(`[setup-mcp] ${agent.name} config not found at: ${settingsPath}`);
  lines.push(`[setup-mcp] Create it, then add these MCP servers under "mcpServers":`);
  lines.push('  {');
  lines.push('    "mcpServers": {');
  const servers = sharedServers(manifest);
  servers.forEach((s, i) => {
    const comma = i < servers.length - 1 ? ',' : '';
    lines.push(`      "${s.id}": { "url": "${makeUrl(manifest, s)}" }${comma}`);
  });
  lines.push('    }');
  lines.push('  }');
  if (agent.docUrl) lines.push(`[setup-mcp] Docs: ${agent.docUrl}`);
  return lines.join('\n');
}

function manualHintGoose(agent, settingsPath, manifest) {
  const lines = [];
  lines.push(`[setup-mcp] ${agent.name} config not found at: ${settingsPath}`);
  lines.push(`[setup-mcp] Add these Remote/streamable-http extensions (or run \`goose configure\`):`);
  lines.push('  extensions:');
  for (const s of sharedServers(manifest)) {
    lines.push(`    ${s.id}:`);
    lines.push(`      type: remote`);
    lines.push(`      url: ${makeUrl(manifest, s)}`);
    lines.push(`      enabled: true`);
  }
  if (agent.docUrl) lines.push(`[setup-mcp] Docs: ${agent.docUrl}`);
  return lines.join('\n');
}

// --- per-agent orchestration ---------------------------------------------
function configureAgent(agentId, manifest, opts) {
  const agent = AGENT_REGISTRY[agentId];
  const paths = candidatePaths(agent);
  const settingsPath = paths.find(existsSync) || paths[0] || null;

  console.log(`\n=== ${agent.name} (${agentId}) ===`);

  if (agent.unverified && !existsSync(settingsPath || '')) {
    // Path not confirmed upstream; only ever hint, never auto-create.
    console.log(`[setup-mcp] ${agent.name} on-disk config path is unverified upstream (${agent.docUrl}).`);
    console.log(manualHintJson(agent, settingsPath, manifest));
    return { agentId, added: [], skipped: [], hinted: true };
  }

  if (!settingsPath || !existsSync(settingsPath)) {
    const hint = agent.format === 'goose-yaml'
      ? manualHintGoose(agent, settingsPath, manifest)
      : manualHintJson(agent, settingsPath, manifest);
    console.log(hint);
    return { agentId, added: [], skipped: [], hinted: true };
  }

  let result;
  if (agent.format === 'goose-yaml') {
    result = writeGooseYaml(agent, settingsPath, manifest, opts);
  } else {
    result = writeJsonMcpServers(agent, settingsPath, manifest, opts);
  }

  for (const id of result.added) {
    console.log(`[setup-mcp] + ${id}: ${makeUrl(manifest, { port: portForId(manifest, id) })}`);
  }
  for (const id of result.skipped) console.log(`[setup-mcp] ~ ${id}: already configured, skipping`);
  if (result.hint) console.log(result.hint);

  const verb = opts.dryRun ? '[dry-run] would update' : 'Updated';
  if (result.added.length && !opts.dryRun) {
    console.log(`[setup-mcp] ${verb} ${settingsPath}`);
    console.log(`[setup-mcp] Restart ${agent.name} to activate the MCP servers.`);
  } else if (opts.dryRun) {
    console.log(`[setup-mcp] [dry-run] no file written for ${settingsPath}`);
  }
  return { agentId, ...result, hinted: !!result.hint };
}

function portForId(manifest, id) {
  const s = manifest.servers.find(x => x.id === id);
  return s ? s.port : 0;
}

// --- main -----------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const manifest = loadManifest();
  const targets = resolveTargets(args.targets);
  const opts = { dryRun: args.dryRun };

  console.log(`[setup-mcp] targets: ${targets.join(', ')}${opts.dryRun ? '  (dry-run)' : ''}`);

  let totalAdded = 0;
  let totalHinted = 0;
  for (const id of targets) {
    const r = configureAgent(id, manifest, opts);
    totalAdded += r.added.length;
    totalHinted += r.hinted ? 1 : 0;
  }

  console.log(`\n[setup-mcp] done. ${totalAdded} server(s) added/refreshed, ${totalHinted} agent(s) need manual setup.`);
  if (totalAdded > 0 && !opts.dryRun) {
    console.log('[setup-mcp] Restart the updated agents to activate MCP servers.');
  }
}

main();
