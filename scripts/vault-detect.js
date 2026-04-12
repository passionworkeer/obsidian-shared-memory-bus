/**
 * scripts/vault-detect.js
 * Cross-platform Obsidian vault detection.
 * Replaces the PowerShell probe with a Node.js implementation.
 *
 * Usage: node scripts/vault-detect.js
 * Output: vault path to stdout, or exits with code 1
 *
 * Resolution order:
 *   1. OBSIDIAN_VAULT_ROOT / AI_MEMORY_OBSIDIAN_VAULT env vars
 *   2. Obsidian config (most-recent-vault) — win32 only (most-recent-vault.json)
 *   3. Obsidian config (obsidian.json vaults list) — all platforms
 *   4. Default candidates on each platform
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { platform } = require('../bus/platform/index.js');

const APPDATA = process.env.APPDATA || '';
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOCALAPPDATA = process.env.LOCALAPPDATA || '';

/**
 * Check if a path exists and is a directory.
 * @param {string} candidate
 * @returns {boolean}
 */
function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the Obsidian config directory for the current platform.
 * @returns {string|null}
 */
function resolveObsidianConfigDir() {
  if (platform.name === 'windows') {
    const dirs = [
      path.join(APPDATA, 'obsidian'),
      path.join(LOCALAPPDATA, 'obsidian'),
      path.join(HOME, 'AppData', 'Roaming', 'obsidian'),
    ];
    for (const d of dirs) {
      if (fs.existsSync(d)) return d;
    }
    return null;
  }

  if (platform.name === 'darwin') {
    const dirs = [
      path.join(HOME, 'Library', 'Application Support', 'obsidian'),
      path.join(HOME, '.config', 'obsidian'),
    ];
    for (const d of dirs) {
      if (fs.existsSync(d)) return d;
    }
    return null;
  }

  // linux
  const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  const dirs = [
    path.join(xdg, 'obsidian'),
    path.join(HOME, '.config', 'obsidian'),
  ];
  for (const d of dirs) {
    if (fs.existsSync(d)) return d;
  }
  return null;
}

/**
 * Read vaults from obsidian.json config (all platforms).
 * @returns {string|null}
 */
function resolveFromObsidianJson() {
  const configDir = resolveObsidianConfigDir();
  if (!configDir) return null;

  const configPath = path.join(configDir, 'obsidian.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const vaults = Object.values(payload?.vaults || {})
      .map((entry) => ({
        path: String(entry?.path || '').trim(),
        open: Boolean(entry?.open),
        ts: Number(entry?.ts || 0),
      }))
      .filter((entry) => isDirectory(entry.path))
      .map((entry) => path.resolve(entry.path));

    if (vaults.length === 0) return null;

    // Prefer the vault that is currently open, else the most-recently used
    const openVault = vaults.find((v) => v.open);
    return openVault || vaults[0];
  } catch {
    return null;
  }
}

/**
 * Windows-only: read most-recent-vault.json.
 * @returns {string|null}
 */
function resolveFromMostRecentVault() {
  if (platform.name !== 'windows') return null;

  const dirs = [
    path.join(APPDATA, 'obsidian'),
    path.join(LOCALAPPDATA, 'obsidian'),
  ];

  for (const dir of dirs) {
    const configPath = path.join(dir, 'most-recent-vault.json');
    if (fs.existsSync(configPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const vaultPath = data?.path;
        if (vaultPath && isDirectory(vaultPath)) {
          return path.resolve(vaultPath);
        }
      } catch {
        // malformed config — skip
      }
    }
  }
  return null;
}

/**
 * Default vault candidates for each platform.
 * @returns {string[]}
 */
function getDefaultCandidates() {
  if (platform.name === 'windows') {
    return [
      path.join(HOME, 'Obsidian Vault'),
      path.join(HOME, 'Desktop', 'Obsidian Vault'),
      path.join(HOME, 'Documents', 'Obsidian Vault'),
      'E:\\Obsidian Vault',
      'D:\\Obsidian Vault',
    ];
  }
  if (platform.name === 'darwin') {
    return [
      path.join(HOME, 'Obsidian Vault'),
      path.join(HOME, 'Documents', 'Obsidian Vault'),
      path.join(HOME, 'Desktop', 'Obsidian Vault'),
    ];
  }
  // linux
  return [
    path.join(HOME, 'Obsidian Vault'),
    path.join(HOME, 'Documents', 'Obsidian Vault'),
    path.join(HOME, 'Desktop', 'Obsidian Vault'),
  ];
}

/**
 * Resolve the vault path using the full priority chain.
 * @returns {string|null}
 */
function resolveVaultPath() {
  // Priority 1: environment variables
  for (const envKey of ['OBSIDIAN_VAULT_ROOT', 'AI_MEMORY_OBSIDIAN_VAULT',
                         'AI_MEMORY_STORE', 'AI_MEMORY_STORE_ROOT']) {
    const val = process.env[envKey];
    if (val && isDirectory(val)) {
      return path.resolve(val);
    }
  }

  // Priority 2: Windows most-recent-vault.json
  const mostRecent = resolveFromMostRecentVault();
  if (mostRecent) return mostRecent;

  // Priority 3: obsidian.json vaults list
  const fromObsidianJson = resolveFromObsidianJson();
  if (fromObsidianJson) return fromObsidianJson;

  // Priority 4: default candidates
  const fallback = getDefaultCandidates().find((c) => isDirectory(c));
  if (fallback) return path.resolve(fallback);

  return null;
}

const vaultPath = resolveVaultPath();
if (vaultPath) {
  console.log(vaultPath);
  process.exit(0);
} else {
  console.error('Error: No Obsidian vault found. Set OBSIDIAN_VAULT_ROOT environment variable.');
  process.exit(1);
}
