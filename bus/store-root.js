
const path = require("path");
const fs = require("fs");

const IS_WINDOWS = process.platform === "win32";

function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function getObsidianConfigCandidates() {
  const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
  const APPDATA = process.env.APPDATA || (IS_WINDOWS ? path.join(USER_HOME, "AppData", "Roaming") : "");
  const candidates = [];
  if (APPDATA) candidates.push(path.join(APPDATA, "obsidian", "obsidian.json"));
  if (IS_WINDOWS && USER_HOME) {
    candidates.push(path.join(USER_HOME, ".config", "obsidian", "obsidian.json"));
  }
  return [...new Set(candidates)];
}

function resolveFromObsidianConfig() {
  for (const configPath of getObsidianConfigCandidates()) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const vaults = Object.values(payload?.vaults || {})
        .map((entry) => ({
          path: String(entry?.path || "").trim(),
          open: Boolean(entry?.open),
          ts: Number(entry?.ts || 0),
        }))
        .filter((entry) => isDirectory(entry.path))
        .map((entry) => ({ ...entry, path: path.resolve(entry.path) }));

      if (!vaults.length) continue;
      const byRecent = [...vaults].sort((l, r) => r.ts - l.ts);
      const openVault = byRecent.find((v) => v.open);
      return openVault ? openVault.path : byRecent[0].path;
    } catch {
      // malformed config — skip
    }
  }
  return "";
}

module.exports = {
  resolveStoreRoot() {
    // Explicit env vars take priority
    for (const key of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT", "OBSIDIAN_VAULT_ROOT", "AI_MEMORY_OBSIDIAN_VAULT"]) {
      const val = String(process.env[key] || "").trim();
      if (val) return path.resolve(val);
    }
    // Auto-detect from Obsidian config (most-recently-opened vault)
    const vaultPath = resolveFromObsidianConfig();
    if (vaultPath) return vaultPath;
    // Final fallback
    return "E:/desktop/.ai-memory";
  },
};
