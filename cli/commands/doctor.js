/**
 * `doctor` command — environment, store, and active-port diagnostics.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  MCP_SERVERS,
  getServerPort,
  resolveBasePort,
} from '../../shared-mcp/port-registry.js';
import { selectServersForSpawn } from '../../shared-mcp/spawn-plan.js';
import { createCheckCollector } from '../lib/check.js';
import { resolveVaultRoot, AI_MEMORY_ROOT } from '../lib/resolve-vault-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NAMES = ['doctor'];

export function getCommand(name) {
  if (name === 'doctor') {
    return { run: runDoctorChecks, desc: 'Diagnose common setup problems' };
  }
  return null;
}

function detectPython() {
  return new Promise((resolve) => {
    const executable = process.env.AI_MEMORY_PYTHON || 'python';
    const child = spawn(executable, ['--version'], { shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', () => resolve(output.trim()));
    child.on('error', () => resolve(''));
  });
}

function detectPwsh() {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['--version'], { shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', () => resolve(output.trim()));
    child.on('error', () => resolve(''));
  });
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

export function activePorts(env = process.env) {
  const basePort = resolveBasePort(env);
  return [...new Set(
    selectServersForSpawn(MCP_SERVERS, env)
      .map((server) => getServerPort(server, basePort)),
  )];
}

export async function runDoctorChecks() {
  const collector = createCheckCollector();

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  collector.add(
    nodeMajor >= 22,
    `Node.js version >= 22 (found ${process.version})`,
    'Upgrade Node.js to 22 or later; the runtime uses the built-in node:sqlite module',
  );

  try {
    const python = await detectPython();
    if (python) {
      const match = python.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const pythonMajor = Number.parseInt(match[1], 10);
        const pythonMinor = Number.parseInt(match[2], 10);
        collector.add(
          pythonMajor > 3 || (pythonMajor === 3 && pythonMinor >= 10),
          `Python version >= 3.10 (found ${pythonMajor}.${pythonMinor})`,
          'Install Python 3.10+ for the fetch and time MCP services',
        );
      } else {
        collector.add(null, 'Python version detected', 'Could not parse Python version');
      }
    } else {
      collector.add(null, 'Python availability', 'Python not found — fetch and time services will not start');
    }
  } catch {
    collector.add(null, 'Python availability', 'Python not found — fetch and time services will not start');
  }

  try {
    const pwsh = await detectPwsh();
    collector.add(Boolean(pwsh), 'PowerShell Core (pwsh) available', 'Install PowerShell 7+ for operational scripts');
  } catch {
    collector.add(null, 'PowerShell Core (pwsh) available', 'PowerShell Core was not found');
  }

  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, '..', '..');
  collector.add(
    Boolean(process.env.AI_MEMORY_ROOT),
    `AI_MEMORY_ROOT is set (${aiMemoryRoot})`,
    'Set AI_MEMORY_ROOT for reliable operation outside the source tree',
  );

  let vaultRoot = null;
  try {
    vaultRoot = resolveVaultRoot([]);
    collector.add(
      fs.existsSync(vaultRoot),
      `Vault root exists (${vaultRoot})`,
      'Set AI_MEMORY_OBSIDIAN_VAULT to your Obsidian vault path',
    );
  } catch {
    collector.add(null, 'Vault root resolution', 'No Obsidian vault was resolved; the local store fallback may be used');
  }

  if (vaultRoot) {
    const requiredPaths = ['00-System/ai-memory', '02-KB/OBSIDIAN.md', '02-KB/MEMORY.md'];
    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(vaultRoot, relativePath.replace(/\//g, path.sep));
      collector.add(
        fs.existsSync(absolutePath),
        `Required vault path exists: ${relativePath}`,
        `Create ${relativePath} in your vault`,
      );
    }
  }

  const ports = activePorts(process.env);
  const portsInUse = [];
  for (const port of ports) {
    if (await isPortInUse(port)) portsInUse.push(port);
  }
  collector.add(
    portsInUse.length === 0,
    `Active MCP ports [${ports.join(', ')}] available (${portsInUse.length} in use: ${portsInUse.join(', ') || 'none'})`,
    portsInUse.length > 0 ? `Stop other services using ports ${portsInUse.join(', ')}` : undefined,
  );

  const homeAiMemory = path.join(os.homedir(), '.ai-memory');
  const isInstalled = fs.existsSync(homeAiMemory);
  const isSourceTree = fs.existsSync(path.join(AI_MEMORY_ROOT, 'bus', 'memory-bus.ps1'));
  collector.add(
    isInstalled || isSourceTree,
    `ai-memory installed (${isInstalled ? 'installed' : 'source tree'})`,
    'Run the installer to set up ai-memory properly',
  );

  collector.print();
  const { passed, failed, warnings } = collector.totals();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed, ${warnings} warnings\n\n`);

  if (failed === 0) {
    process.stdout.write("Your setup looks good. Run 'npm start' to start the core shared MCP services.\n");
  } else {
    process.stdout.write("Check docs/guides/TROUBLESHOOTING.md for fixes.\n");
  }

  process.exit(collector.exitCode());
}
