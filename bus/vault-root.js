import path from "node:path";
import os from "node:os";

function homedir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function resolveVaultRoot() {
  return (
    nonEmptyEnv("AI_MEMORY_OBSIDIAN_VAULT") ||
    nonEmptyEnv("OBSIDIAN_VAULT_ROOT") ||
    nonEmptyEnv("AI_MEMORY_STORE") ||
    nonEmptyEnv("AI_MEMORY_STORE_ROOT") ||
    nonEmptyEnv("AI_MEMORY_ROOT") ||
    path.join(homedir(), ".ai-memory")
  );
}

export function getDefaultVaultCandidates() {
  const home = homedir();
  return [
    path.join(home, ".ai-memory"),
    path.join(home, ".obsidian"),
    path.join(home, "Documents", "Obsidian Vault"),
  ];
}

export default { resolveVaultRoot, getDefaultVaultCandidates };
