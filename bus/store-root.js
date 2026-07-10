
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  resolveVaultRoot,
  getDefaultVaultCandidates,
  resolveFromObsidianConfig,
} from "./vault-root.js";

// ---------------------------------------------------------------------------
// resolveStoreRoot
//
// Canonical .ai-memory store root, mirroring Python's
// retrieval/runtime_support.py:resolve_store_root. Priority:
//
//   1. AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT (explicit, highest)
//   2. vault bridge: resolveVaultPathForBridge() + "00-System/ai-memory",
//      used only when that directory exists
//   3. AI_MEMORY_ROOT (legacy, demoted below the vault bridge)
//   4. ~/.ai-memory (pure file fallback)
//
// The vault bridge makes the Obsidian vault's ``00-System/ai-memory`` the
// canonical store when it exists, so retrieval reads real data without any
// extra config. CLAUDE.md declares Obsidian the canonical long-term memory;
// this code now matches that intent.
//
// No circular-import risk: vault-root.js does not import store-root.js.
// ---------------------------------------------------------------------------

function homedir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Mirror Python resolve_vault_root(): env vars, then default candidates.
// Returns "" when no vault path resolves so callers can fall through safely.
function resolveVaultPathForBridge() {
  const envVault = resolveVaultRoot();
  if (envVault && fs.existsSync(envVault)) {
    return path.resolve(envVault);
  }
  // Read Obsidian's obsidian.json: records every vault the user opened, on any
  // drive. This is how a vault on E:\ is discovered when the hard-coded
  // default candidates (all under the home dir) don't match.
  const obsidianVault = resolveFromObsidianConfig();
  if (obsidianVault) {
    return path.resolve(obsidianVault);
  }
  for (const candidate of getDefaultVaultCandidates()) {
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return "";
}

export function resolveStoreRoot() {
  const explicit = nonEmptyEnv("AI_MEMORY_STORE") || nonEmptyEnv("AI_MEMORY_STORE_ROOT");
  if (explicit) {
    return path.resolve(explicit);
  }

  const vaultPath = resolveVaultPathForBridge();
  if (vaultPath) {
    const vaultAiMemory = path.join(vaultPath, "00-System", "ai-memory");
    if (fs.existsSync(vaultAiMemory) && fs.statSync(vaultAiMemory).isDirectory()) {
      return path.resolve(vaultAiMemory);
    }
  }

  const legacyRoot = nonEmptyEnv("AI_MEMORY_ROOT");
  if (legacyRoot) {
    return path.resolve(legacyRoot);
  }

  return path.resolve(path.join(homedir(), ".ai-memory"));
}

export function getProjectsRoot(storeRoot) {
  return path.join(storeRoot, "projects");
}
export function getContextPath(storeRoot) {
  return path.join(storeRoot, "CONTEXT.md");
}
export function getDefaultStoreCandidates() {
  return [path.join(homedir(), ".ai-memory")];
}
export default { resolveStoreRoot, getProjectsRoot, getContextPath, getDefaultStoreCandidates };
