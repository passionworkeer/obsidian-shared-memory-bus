"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const USER_HOME = process.env.HOME || "";
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(USER_HOME, ".config");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(USER_HOME, ".local", "share");
const APP_SUPPORT = path.join(USER_HOME, "Library", "Application Support");

// ---------------------------------------------------------------------------
// resolveVaultRoot — macOS variant
// ---------------------------------------------------------------------------

let cachedVaultRoot = null;

function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function getObsidianConfigCandidates() {
  const candidates = [];
  candidates.push(path.join(APP_SUPPORT, "obsidian", "obsidian.json"));
  candidates.push(path.join(XDG_CONFIG_HOME, "obsidian", "obsidian.json"));
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

      if (vaults.length === 0) continue;

      const byRecent = [...vaults].sort((l, r) => r.ts - l.ts);
      const openVault = byRecent.find((e) => e.open);
      return openVault ? openVault.path : byRecent[0].path;
    } catch (_err) {
      // Malformed config
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
  if (cachedVaultRoot && !options.refresh) return cachedVaultRoot;

  for (const envKey of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT", "AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"]) {
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

  const fallback = getDefaultVaultCandidates().find((c) => isDirectory(c));
  if (fallback) {
    cachedVaultRoot = path.resolve(fallback);
    return cachedVaultRoot;
  }

  throw Object.assign(
    new Error("no-obsidian-vault: Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT, or open/create an Obsidian vault first."),
    { code: "ENOENT" }
  );
}

// ---------------------------------------------------------------------------
// Store root resolution
// ---------------------------------------------------------------------------

const DEFAULT_STORE_ROOT = path.join(USER_HOME, ".ai-memory");
let cachedStoreRoot = null;

function resolveStoreRoot(options = {}) {
  if (cachedStoreRoot && !options.refresh) return cachedStoreRoot;

  for (const envKey of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate) {
      cachedStoreRoot = path.resolve(candidate);
      return cachedStoreRoot;
    }
  }

  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || "";
  const fallback = aiMemoryRoot
    ? path.join(aiMemoryRoot, ".ai-memory")
    : DEFAULT_STORE_ROOT;

  cachedStoreRoot = fallback;
  return fallback;
}

function getInboxRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "inbox");
}

function getGeneratedRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "generated");
}

function getKgRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "kg");
}

// ---------------------------------------------------------------------------
// spawnPython — macOS always uses python3
// ---------------------------------------------------------------------------

function spawnPython(args, options = {}) {
  const { spawn: nodeSpawn } = require("node:child_process");
  return nodeSpawn("python3", args, {
    ...options,
    env: {
      ...(options.env || process.env),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
}

// ---------------------------------------------------------------------------
// makeWatchdogScript — bash version for macOS
// ---------------------------------------------------------------------------

function makeWatchdogScript(pidPath, callbackScript) {
  const safePidPath = String(pidPath || "/tmp/watchdog.pid").replace(/'/g, "'\\''");
  const safeCallback = String(callbackScript || "echo 'watchdog recovered'").replace(/'/g, "'\\''");
  const intervalSec = 15;

  return `\
#!/bin/bash
# AI Memory Watchdog Supervisor (bash)
# Generated by obsidian-shared-memory-bus bus/platform/darwin.js

PID_PATH='${safePidPath}'
CALLBACK='${safeCallback}'
INTERVAL=${intervalSec}

# Write our own PID so we can be identified
echo "$$" > "$PID_PATH"

is_running() {
    local pid="$1"
    if [ -z "$pid" ]; then
        return 1
    fi
    kill -0 "$pid" 2>/dev/null
}

while true; do
    sleep "$INTERVAL"

    # Read target PID (first non-empty line)
    TARGET_PID=""
    if [ -f "$PID_PATH" ]; then
        TARGET_PID=$(sed -n '1p' "$PID_PATH" | tr -d '[:space:]')
    fi

    if [ -n "$TARGET_PID" ]; then
        if ! is_running "$TARGET_PID"; then
            # Target died — invoke callback
            eval "$CALLBACK" &
            exit 0
        fi
    fi
done
`;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

let _adapter = null;

function getDarwinAdapter() {
  if (_adapter) return _adapter;

  _adapter = {
    name: "darwin",
    storeRootDefault: DEFAULT_STORE_ROOT,
    homeEnvVar: "HOME",
    pathSep: "/",
    executables: {
      python: "python3",
      node: "node",
      powershell: null,   // No native PowerShell on macOS
    },
    watchdog: {
      scriptExtension: ".sh",
      scriptPath: path.join(USER_HOME, ".ai-memory", "watchdog-darwin.sh"),
    },
    makeWatchdogScript,
    spawnPython,
    resolveVaultRoot,
    resolveStoreRoot,
    getInboxRoot,
    getGeneratedRoot,
    getKgRoot,
    // Utilities
    isDirectory,
  };

  return _adapter;
}

module.exports = { getDarwinAdapter };
