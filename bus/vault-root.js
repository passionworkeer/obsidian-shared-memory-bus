
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function getVaultRoot() {
  const envVault = process.env.OBSIDIAN_VAULT_ROOT || process.env.AI_MEMORY_OBSIDIAN_VAULT;
  if (envVault) {
    return resolve(envVault);
  }
  // Fallback to platform-specific defaults for testing
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const defaultPath = resolve(userHome, "Desktop", "Obsidian Vault");
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  return resolve(userHome, "Obsidian Vault");
}

export function resolveVaultRoot() {
  return getVaultRoot();
}
export function getDefaultVaultCandidates() {
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  return [
    resolve(userHome, "Desktop", "Obsidian Vault"),
    resolve(userHome, "Obsidian Vault"),
  ];
}
export default { resolveVaultRoot, getDefaultVaultCandidates };
