import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment & paths
// ---------------------------------------------------------------------------

export const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ||
  path.resolve(__dirname, "..", "..");

// Load vault-root helper from bus/ so we get the full resolution chain
async function loadVaultRootHelper() {
  const { pathToFileURL } = await import("url");
  const candidates = [
    path.join(AI_MEMORY_ROOT, "bus", "vault-root.js"),
    path.join(AI_MEMORY_ROOT, "vault-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const mod = await import(pathToFileURL(c));
      return mod.default || mod;
    }
  }
  return null;
}

const vaultRootHelper = await loadVaultRootHelper();
const resolveVaultRootChain = vaultRootHelper && typeof vaultRootHelper.resolveVaultRootChain === "function"
  ? vaultRootHelper.resolveVaultRootChain
  : null;

// ---------------------------------------------------------------------------
// Vault root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Obsidian vault root using multiple strategies.
 * Delegates to bus/vault-root.js's resolveVaultRootChain so the CLI and
 * the platform adapter walk the same code path. The chain honors:
 *   1. --workspace flag
 *   2. AI_MEMORY_OBSIDIAN_VAULT env
 *   3. AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT env
 *   4. $AI_MEMORY_ROOT/config.json (vaultRoot field)
 *   5. ~/.ai-memory/vault-root.txt
 *   6. fallback: simple env-only resolver
 *
 * The chain is loaded from bus/vault-root.js when available, but a
 * missing helper is non-fatal — we still walk steps 1-5 inline. Only
 * when no source yields a path do we throw.
 *
 * @param {string[]} flags  - CLI flags (e.g. ["--workspace", "/path"])
 * @returns {string}
 */
export function resolveVaultRoot(flags) {
  const workspaceIdx = flags.indexOf("--workspace");
  const workspace = workspaceIdx !== -1 && flags[workspaceIdx + 1]
    ? flags[workspaceIdx + 1]
    : "";

  const configPath = path.join(AI_MEMORY_ROOT, "config.json");

  // 1. --workspace flag
  if (workspace && fs.existsSync(workspace)) {
    return path.resolve(workspace);
  }

  // 2. AI_MEMORY_OBSIDIAN_VAULT env
  const envVault = process.env.AI_MEMORY_OBSIDIAN_VAULT;
  if (envVault && fs.existsSync(envVault)) {
    return path.resolve(envVault);
  }

  // 3. AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT env
  const envStore = process.env.AI_MEMORY_STORE || process.env.AI_MEMORY_STORE_ROOT;
  if (envStore && fs.existsSync(envStore)) {
    return path.resolve(envStore);
  }

  // 4. $AI_MEMORY_ROOT/config.json (vaultRoot field)
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg && typeof cfg.vaultRoot === "string" && cfg.vaultRoot.trim() && fs.existsSync(cfg.vaultRoot)) {
        return path.resolve(cfg.vaultRoot);
      }
    } catch { /* malformed config — fall through */ }
  }

  // 5. ~/.ai-memory/vault-root.txt
  const homeVaultTxt = path.join(os.homedir(), ".ai-memory", "vault-root.txt");
  if (fs.existsSync(homeVaultTxt)) {
    try {
      const v = fs.readFileSync(homeVaultTxt, "utf8").trim();
      if (v && fs.existsSync(v)) {
        return path.resolve(v);
      }
    } catch { /* unreadable — fall through */ }
  }

  // 6. Fall back to the canonical chain helper when loadable, or its
  //    simple env-only resolver. The chain is preferred because it is the
  //    single source of truth shared with the platform adapters.
  if (resolveVaultRootChain) {
    const r = resolveVaultRootChain({ workspace: "", configPath: null, vaultRootTxt: "", fallback: () => "" });
    if (r) return r;
  } else if (vaultRootHelper && typeof vaultRootHelper.resolveVaultRoot === "function") {
    const r = vaultRootHelper.resolveVaultRoot();
    if (r) return r;
  }

  throw new Error(
    "no-obsidian-vault: Set AI_MEMORY_OBSIDIAN_VAULT, create " +
    "$AI_MEMORY_ROOT/config.json with vaultRoot, " +
    "create ~/.ai-memory/vault-root.txt, or open an Obsidian vault first."
  );
}
