import path from "node:path";
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

export default { resolveVaultRoot, getDefaultVaultCandidates };

