/**
 * scripts/env-check.js
 * Cross-platform environment health check.
 * Verifies Node.js, Python, and required directories.
 *
 * Usage: node scripts/env-check.js
 * Exit code: 0 = all pass, 1 = one or more fail
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { platform } = require('../bus/platform/index.js');
const { resolveStoreRoot } = require('../bus/store-root.js');

const checks = [];

function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, status: 'PASS', detail: result });
  } catch (e) {
    checks.push({ name, status: 'FAIL', detail: e.message });
  }
}

function exe(name, args, extraEnv) {
  return execFileSync(name, Array.isArray(args) ? args : [args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  }).trim();
}

const nodeExe = platform.executables?.node || 'node';
const pyExe = platform.executables?.python || (platform.name === 'win32' ? 'python' : 'python3');

// Node.js
check('Node.js', () => exe(nodeExe, ['--version']));

// Python — try multiple names since 'python' may not be in PATH on Windows
check('Python', () => {
  const candidates = [
    { command: process.env.AI_MEMORY_PYTHON, argsPrefix: [] },
    { command: process.env.PYTHON_EXE, argsPrefix: [] },
    { command: process.env.PYTHON, argsPrefix: [] },
    { command: pyExe, argsPrefix: [] },
    { command: 'python', argsPrefix: [] },
    { command: 'python3', argsPrefix: [] },
    ...(platform.name === 'win32'
      ? [
          { command: 'py', argsPrefix: ['-3'] },
          { command: 'py', argsPrefix: [] },
        ]
      : []),
  ].filter((candidate) => candidate.command);
  const tried = [];
  for (const candidate of candidates) {
    try {
      return exe(candidate.command, [...candidate.argsPrefix, '--version'], { PYTHONIOENCODING: 'utf-8' });
    } catch {
      tried.push([candidate.command, ...candidate.argsPrefix].join(' '));
    }
  }
  throw new Error(`none of [${tried.join(', ')}] found`);
});

// Platform identity
check('Platform detection', () => `${platform.name} (${process.platform})`);

// Store root resolution
check('Store root', () => {
  const root = resolveStoreRoot();
  if (!fs.existsSync(path.dirname(root))) {
    // just verify it is a string and the parent is creatable
    return `${root} (parent ok)`;
  }
  return root;
});

// Store root parent writable
check('Store root parent writable', () => {
  const storeRoot = resolveStoreRoot();
  const parent = path.dirname(storeRoot);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    return parent;
  } catch {
    throw new Error(`Cannot write to ${parent}`);
  }
});

// Obsidian vault detection (best-effort)
check('Obsidian vault (via platform)', () => {
  if (typeof platform.resolveVaultRoot === 'function') {
    try {
      return platform.resolveVaultRoot();
    } catch {
      return '(not set)';
    }
  }
  return '(not available)';
});

// Platform-specific executables
check('Python executable', () => platform.executables?.python || 'unknown');
check('Node executable', () => platform.executables?.node || 'unknown');
if (platform.executables?.powershell) {
  check('PowerShell executable', () => platform.executables.powershell);
}

// Print results
const maxNameLen = Math.max(...checks.map((c) => c.name.length), 12);
console.log('\n  Environment Check');
console.log('─'.repeat(maxNameLen + 36));
for (const c of checks) {
  const icon = c.status === 'PASS' ? 'PASS' : 'FAIL';
  const name = c.name.padEnd(maxNameLen);
  console.log(`  [${icon}]  ${name}  ${c.detail}`);
}
console.log('');

const failed = checks.filter((c) => c.status === 'FAIL');
process.exit(failed.length > 0 ? 1 : 0);
