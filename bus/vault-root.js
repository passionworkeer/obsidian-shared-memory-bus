
import os from "node:os";
import path from "node:path";

const FALLBACK_VAULT = path.join(os.homedir(), "Documents", "Obsidian Vault");

export function resolveVaultRoot() {
  return process.env.AI_MEMORY_OBSIDIAN_VAULT ||
    process.env.OBSIDIAN_VAULT_ROOT ||
    FALLBACK_VAULT;
}
export function getDefaultVaultCandidates() { return [FALLBACK_VAULT]; }
export default { resolveVaultRoot, getDefaultVaultCandidates };
