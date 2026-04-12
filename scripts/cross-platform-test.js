/**
 * scripts/cross-platform-test.js
 * Smoke test to verify cross-platform adapters load correctly.
 *
 * Usage: node scripts/cross-platform-test.js
 * Exit code: 0 = all pass, 1 = one or more fail
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { platform, isWindows, isMac, isLinux } = require('../bus/platform/index.js');
const { resolveStoreRoot } = require('../bus/store-root.js');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message });
  }
}

console.log(`\n  Platform: ${platform.name} (${process.platform})`);
console.log(`  Node.js:  ${process.version}`);
console.log('─'.repeat(54));

// 1. platform.adapter.loaded
test('platform.adapter.loaded', () => {
  if (!platform.name) throw new Error('platform.name is empty');
  if (!['windows', 'darwin', 'linux'].includes(platform.name)) {
    throw new Error(`Unknown platform: ${platform.name}`);
  }
});

// 2. platform identity booleans match process.platform
test('platform.identity.booleans', () => {
  const expected = {
    win32: isWindows,
    darwin: isMac,
    linux: isLinux,
  };
  const actual = {
    win32: platform.name === 'win32' || platform.name === 'windows',
    darwin: platform.name === 'darwin',
    linux: platform.name === 'linux',
  };
  if (expected[process.platform] !== actual[process.platform]) {
    throw new Error(`Identity mismatch: expected ${expected[process.platform]} for ${process.platform}`);
  }
});

// 3. platform.storeRootDefault is non-empty
test('platform.storeRootDefault.format', () => {
  const root = platform.storeRootDefault;
  if (!root) throw new Error('storeRootDefault is empty');
  // Path separator must match platform
  const expectedSep = platform.pathSep || (platform.name === 'win32' ? '\\' : '/');
  if (!root.includes(expectedSep)) {
    throw new Error(`Default root "${root}" does not contain platform separator "${expectedSep}"`);
  }
});

// 4. platform.executables has required keys
test('platform.executables', () => {
  const exe = platform.executables;
  if (!exe) throw new Error('executables is undefined');
  if (!exe.node) throw new Error('No node executable');
  if (!exe.python) throw new Error('No python executable');
});

// 5. platform.resolveVaultRoot exists and is a function
test('platform.resolveVaultRoot', () => {
  if (typeof platform.resolveVaultRoot !== 'function') {
    throw new Error('resolveVaultRoot is not a function');
  }
  // Should either return a path or throw ENOENT
  try {
    const vault = platform.resolveVaultRoot();
    if (typeof vault !== 'string' || !vault) {
      throw new Error(`resolveVaultRoot returned invalid value: ${vault}`);
    }
    console.log(`   vault root: ${vault}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('   vault root: (not found — set OBSIDIAN_VAULT_ROOT)');
    } else {
      throw e;
    }
  }
});

// 6. store-root.resolveStoreRoot returns a valid path
test('store-root.resolveStoreRoot', () => {
  const root = resolveStoreRoot();
  if (!root) throw new Error('resolveStoreRoot returned empty');
  console.log(`   store root: ${root}`);
});

// 7. platform.makeWatchdogScript generates valid script
test('platform.makeWatchdogScript', () => {
  if (typeof platform.makeWatchdogScript !== 'function') {
    throw new Error('makeWatchdogScript is not a function');
  }
  const script = platform.makeWatchdogScript('/tmp/test.pid', 'echo ok');
  if (!script || typeof script !== 'string') {
    throw new Error('Generated watchdog script is not a non-empty string');
  }
  // Should contain a shebang (bash/sh) or VBScript header
  const hasShebang = script.includes('#!/bin/bash') || script.includes('#!/bin/sh');
  const hasVbs = script.toLowerCase().includes('vbscript') || script.includes("' AI Memory Watchdog");
  if (!hasShebang && !hasVbs) {
    throw new Error(`Generated watchdog script looks invalid:\n${script.slice(0, 200)}`);
  }
  console.log(`   script length: ${script.length} chars`);
});

// 8. platform.isDirectory helper
test('platform.isDirectory', () => {
  if (typeof platform.isDirectory !== 'function') {
    throw new Error('isDirectory is not a function');
  }
  // Should return false for non-existent path
  if (platform.isDirectory('/nonexistent/path/that/cannot/exist')) {
    throw new Error('isDirectory returned true for non-existent path');
  }
  // Should return true for root (always exists)
  const root = platform.name === 'win32' ? 'C:\\' : '/';
  if (!platform.isDirectory(root)) {
    throw new Error(`isDirectory returned false for platform root: ${root}`);
  }
});

// Print summary
console.log('');
const maxNameLen = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
  const name = r.name.padEnd(maxNameLen);
  console.log(`  [${icon}]  ${name}  ${r.error || ''}`);
}

const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\n${failed.length === 0 ? 'All tests passed.' : `${failed.length} test(s) failed.`}\n`);
process.exit(failed.length > 0 ? 1 : 0);
