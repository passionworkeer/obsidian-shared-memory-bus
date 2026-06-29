import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function homedir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// resolveVaultRoot
//
// Resolves the Obsidian vault root from explicit environment variables only.
// Returns "" when no vault env is set; callers must fall back to their own
// detection (e.g. scripts/vault-detect.js) in that case.
//
// Store env vars (AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT / AI_MEMORY_ROOT)
// are intentionally NOT consulted: they describe the data store, not the
// vault. Falling through to them produced the wrong vault path in setups
// where the store and vault differ (e.g. store at ~/.ai-memory, vault at
// ~/Documents/Obsidian Vault).
// ---------------------------------------------------------------------------

export function resolveVaultRoot() {
  return (
    nonEmptyEnv("AI_MEMORY_OBSIDIAN_VAULT") ||
    nonEmptyEnv("OBSIDIAN_VAULT_ROOT") ||
    ""
  );
}

/**
 * resolveVaultRootChain — the full CLI 6-step resolution chain.
 * Hoisted here so that the CLI and platform adapter agree on the answer.
 *
 * Steps:
 *   1. workspace (--workspace flag, CLI-only)
 *   2. AI_MEMORY_OBSIDIAN_VAULT env
 *   2b. AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT env
 *   3. config.json (path supplied by caller, e.g. AI_MEMORY_ROOT/config.json)
 *   4. vault-root.txt (path supplied by caller, default ~/.ai-memory/vault-root.txt)
 *   5. fallback resolver (default: the simple env-only `resolveVaultRoot`)
 *
 * @param {object} [opts]
 * @param {string} [opts.workspace]      - explicit workspace path (from --workspace)
 * @param {string} [opts.configPath]     - path to a config.json with a vaultRoot field
 * @param {string} [opts.vaultRootTxt]   - path to a vault-root.txt file
 * @param {Function} [opts.fallback]     - last-resort resolver; default: this module's resolveVaultRoot
 * @returns {string} resolved absolute path (never empty when at least one source is set)
 */
export function resolveVaultRootChain({
  workspace = "",
  configPath = null,
  vaultRootTxt = null,
  fallback = resolveVaultRoot,
} = {}) {
  if (workspace && fs.existsSync(workspace)) {
    return path.resolve(workspace);
  }

  const envVault = nonEmptyEnv("AI_MEMORY_OBSIDIAN_VAULT");
  if (envVault && fs.existsSync(envVault)) {
    return path.resolve(envVault);
  }

  const envStore = nonEmptyEnv("AI_MEMORY_STORE") || nonEmptyEnv("AI_MEMORY_STORE_ROOT");
  if (envStore && fs.existsSync(envStore)) {
    return path.resolve(envStore);
  }

  if (configPath && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg && typeof cfg.vaultRoot === "string" && cfg.vaultRoot.trim() && fs.existsSync(cfg.vaultRoot)) {
        return path.resolve(cfg.vaultRoot);
      }
    } catch {
      /* malformed config.json — fall through */
    }
  }

  if (vaultRootTxt === null) {
    vaultRootTxt = path.join(homedir(), ".ai-memory", "vault-root.txt");
  }
  if (vaultRootTxt && fs.existsSync(vaultRootTxt)) {
    try {
      const v = fs.readFileSync(vaultRootTxt, "utf8").trim();
      if (v && fs.existsSync(v)) {
        return path.resolve(v);
      }
    } catch {
      /* unreadable — fall through */
    }
  }

  return fallback();
}

// Obsidian config file locations per platform (mirrors Python
// platform.py:get_obsidian_config_candidates). Used to discover vaults the
// user has actually opened in Obsidian, which may live on any drive — not
// just the hard-coded default candidates below.
function getObsidianConfigCandidates() {
  const home = homedir();
  const candidates = [];
  if (nonEmptyEnv("APPDATA")) {
    candidates.push(path.join(nonEmptyEnv("APPDATA"), "obsidian", "obsidian.json"));
  }
  candidates.push(path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"));
  const xdg = nonEmptyEnv("XDG_CONFIG_HOME") || path.join(home, ".config");
  candidates.push(path.join(xdg, "obsidian", "obsidian.json"));
  return candidates;
}

// Mirror Python resolve_from_obsidian_config(): read obsidian.json, pick the
// most recently used open vault. Returns "" when no vault is recorded.
// Exported so bus/store-root.js can vault-bridge to a real (any-drive) vault.
export function resolveFromObsidianConfig() {
  for (const configPath of getObsidianConfigCandidates()) {
    if (!fs.existsSync(configPath)) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      continue;
    }
    const vaultsObj = (payload && payload.vaults) || {};
    const vaults = [];
    for (const rawEntry of Object.values(vaultsObj)) {
      const v = String((rawEntry && rawEntry.path) || "").trim();
      if (!v || !fs.existsSync(v)) continue;
      vaults.push({
        path: path.resolve(v),
        open: !!(rawEntry && rawEntry.open),
        ts: Number((rawEntry && rawEntry.ts) || 0),
      });
    }
    if (vaults.length === 0) continue;
    const byRecent = vaults.sort((a, b) => b.ts - a.ts);
    const openVault = byRecent.find((item) => item.open);
    return (openVault || byRecent[0]).path;
  }
  return "";
}

// Default *vault* candidates — these are common Obsidian vault locations.
// They do NOT include the data store root or the Obsidian config directory.
export function getDefaultVaultCandidates() {
  const home = homedir();
  return [
    path.join(home, "Documents", "Obsidian Vault"),
    path.join(home, "Obsidian Vault"),
    path.join(home, "Desktop", "Obsidian Vault"),
  ];
}

export default { resolveVaultRoot, resolveVaultRootChain, getDefaultVaultCandidates };


