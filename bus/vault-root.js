"use strict";

const fs = require("fs");
const path = require("path");

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const APP_DATA = process.env.APPDATA || (IS_WINDOWS ? path.join(USER_HOME, "AppData", "Roaming") : "");
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(USER_HOME, ".config");

let cachedVaultRoot = null;

function isDirectory(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    return fs.statSync(candidate).isDirectory();
  } catch (_error) {
    return false;
  }
}

function getObsidianConfigCandidates() {
  const candidates = [];
  if (APP_DATA) {
    candidates.push(path.join(APP_DATA, "obsidian", "obsidian.json"));
  }
  if (IS_MACOS) {
    candidates.push(path.join(USER_HOME, "Library", "Application Support", "obsidian", "obsidian.json"));
  }
  candidates.push(path.join(XDG_CONFIG_HOME, "obsidian", "obsidian.json"));
  return [...new Set(candidates)];
}

function resolveFromObsidianConfig() {
  for (const configPath of getObsidianConfigCandidates()) {
    if (!fs.existsSync(configPath)) {
      continue;
    }

    try {
      const payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const vaults = Object.values(payload?.vaults || {})
        .map((entry) => ({
          path: String(entry?.path || "").trim(),
          open: Boolean(entry?.open),
          ts: Number(entry?.ts || 0),
        }))
        .filter((entry) => isDirectory(entry.path))
        .map((entry) => ({
          ...entry,
          path: path.resolve(entry.path),
        }));

      if (vaults.length === 0) {
        continue;
      }

      const byRecent = [...vaults].sort((left, right) => right.ts - left.ts);
      const openVault = byRecent.find((entry) => entry.open);
      return openVault ? openVault.path : byRecent[0].path;
    } catch (_error) {
      // Ignore malformed config and continue to other candidates.
    }
  }

  return "";
}

function getDefaultVaultCandidates() {
  return [
    path.join(USER_HOME, "Obsidian Vault"),
    path.join(USER_HOME, "Documents", "Obsidian Vault"),
    path.join(USER_HOME, "Desktop", "Obsidian Vault"),
  ];
}

function resolveVaultRoot(options = {}) {
  if (cachedVaultRoot && !options.refresh) {
    return cachedVaultRoot;
  }

  for (const envKey of ["AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"]) {
    const candidate = String(process.env[envKey] || "").trim();
    if (isDirectory(candidate)) {
      cachedVaultRoot = path.resolve(candidate);
      return cachedVaultRoot;
    }
  }

  const obsidianVault = resolveFromObsidianConfig();
  if (obsidianVault) {
    cachedVaultRoot = obsidianVault;
    return cachedVaultRoot;
  }

  const fallback = getDefaultVaultCandidates().find((candidate) => isDirectory(candidate));
  if (fallback) {
    cachedVaultRoot = path.resolve(fallback);
    return cachedVaultRoot;
  }

  throw new Error(
    "no-obsidian-vault: Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT, or open/create an Obsidian vault first."
  );
}

module.exports = {
  resolveVaultRoot,
  getDefaultVaultCandidates,
};
