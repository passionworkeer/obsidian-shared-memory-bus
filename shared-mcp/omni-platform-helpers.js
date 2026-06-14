// Windows env / registry probing helpers for the omni-memory-server.
//
// This module owns:
//   - The shared WINDOWS_ENV_CACHE that backs firstNonEmptyEnv / buildMergedEnv.
//   - The watchdogSupervisorCache that throttles isWatchdogSupervisorAlive.
//   - All pure PowerShell-probe helpers (no class instances, no MCP server state).
//
// Everything in here is safe to call on any platform; non-Windows paths return
// empty / false values rather than throwing.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { IS_WINDOWS, USER_HOME, PROJECT_ROOT, AI_MEMORY_ROOT } from "./omni-store.js";

const WINDOWS_ENV_CACHE = new Map();

// Names of env vars that the merged-env helper should look up in the registry
// when not present in process.env. Kept here next to its sole consumer.
const RUNTIME_ENV_NAMES = [
  "AI_MEMORY_ROOT",
  "AI_MEMORY_RUNTIME_CONFIG_PATH",
  "AI_MEMORY_PYTHON",
  "AI_MEMORY_OBSIDIAN_VAULT",
  "OBSIDIAN_VAULT_ROOT",
  "CLAUDE_MEM_BASE",
  "OPENCLAW_HOME",
  "OPENCLAW_BLACKBOARD_DB",
  "AI_MEMORY_EMBED_ADAPTER",
  "AI_MEMORY_EMBED_BACKEND",
  "AI_MEMORY_EMBED_BASE_URL",
  "AI_MEMORY_EMBED_API_KEY",
  "AI_MEMORY_EMBED_API_KEY_ENV",
  "AI_MEMORY_EMBED_MODEL",
  "AI_MEMORY_EMBED_PROFILE",
  "AI_MEMORY_EMBED_PROVIDER",
  "AI_MEMORY_EMBED_TIMEOUT_MS",
  "AI_MEMORY_EMBED_TIMEOUT_SECONDS",
  "AI_MEMORY_EMBED_REQUEST_DELAY_MS",
  "AI_MEMORY_EMBED_DELAY_MS",
  "AI_MEMORY_EMBED_BATCH_SIZE",
  "AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK",
];

export function resolveRuntimePath(...candidates) {
  // First try PROJECT_ROOT (project dir), then AI_MEMORY_ROOT (data dir)
  for (const root of [PROJECT_ROOT, AI_MEMORY_ROOT]) {
    for (const relativePath of candidates) {
      const fullPath = path.join(root, relativePath);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return path.join(PROJECT_ROOT, candidates[0]);
}

/**
 * Batch-read multiple Windows registry environment variables in a single
 * PowerShell call. Falls back to User scope, then Machine scope per variable.
 * Returns a map of name -> value for vars that have values.
 * One spawnSync call instead of N, drastically reducing startup time.
 */
function batchReadWindowsRegistryVars(names) {
  if (!IS_WINDOWS || names.length === 0) {
    return new Map();
  }

  // PowerShell: build a JSON object from the name/value pairs
  // Use plain strings + array join (avoids JS template-literal $/$-interpretation)
  const psLines = ["$result = @{}"];
  for (const name of names) {
    const e = name.replace(/'/g, "''");
    psLines.push(
      "try { $v = [Environment]::GetEnvironmentVariable('" + e + "', 'User'); " +
      "if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable('" + e + "', 'Machine') }; " +
      "if (-not [string]::IsNullOrWhiteSpace($v)) { $result['" + e + "'] = $v } } catch {}"
    );
  }
  psLines.push("$result | ConvertTo-Json -Compress");
  const psScript = psLines.join("\n");

  let raw = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    if (!result.error && result.status === 0) {
      raw = String(result.stdout || "").trim();
    }
  } catch (_e) {
    return new Map();
  }

  // Parse JSON result
  const results = new Map();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      for (const name of names) {
        if (parsed[name]) {
          results.set(name, String(parsed[name]).trim());
          WINDOWS_ENV_CACHE.set(name, String(parsed[name]).trim());
        }
      }
    } catch (_e) {
      // JSON parse failed, fall through to empty results
    }
  }
  return results;
}

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  // Batch-read all non-found names in one PowerShell call
  const notFound = names.filter((n) => !WINDOWS_ENV_CACHE.has(n));
  if (notFound.length > 0) {
    const cached = batchReadWindowsRegistryVars(notFound);
    for (const name of names) {
      const cachedVal = WINDOWS_ENV_CACHE.get(name);
      if (cachedVal) return cachedVal;
    }
  }
  for (const name of names) {
    const cachedVal = WINDOWS_ENV_CACHE.get(name);
    if (cachedVal) return cachedVal;
  }
  return "";
}

function buildMergedEnv(baseEnv = process.env, names = RUNTIME_ENV_NAMES) {
  const merged = { ...(baseEnv || {}) };
  // Fast path: check process.env first
  const missing = [];
  for (const name of names) {
    const current = merged[name];
    if (typeof current !== "string" || !current.trim()) {
      missing.push(name);
    }
  }
  // Batch-fetch all missing in one PowerShell call
  if (missing.length > 0) {
    batchReadWindowsRegistryVars(missing);
  }
  // Merge resolved values
  for (const name of names) {
    const current = merged[name];
    if (typeof current === "string" && current.trim()) {
      continue;
    }
    const cached = WINDOWS_ENV_CACHE.get(name);
    if (cached) {
      merged[name] = cached;
    }
  }
  return merged;
}

function resolvePowerShellCommand() {
  if (IS_WINDOWS) {
    return "powershell.exe";
  }

  for (const candidate of [
    firstNonEmptyEnv("AI_MEMORY_PWSH"),
    "pwsh",
    "/usr/local/bin/pwsh",
    "/opt/homebrew/bin/pwsh",
  ]) {
    if (!candidate) {
      continue;
    }
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
    try {
      const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    } catch (_error) {
      // Keep probing fallbacks.
    }
  }

  return firstNonEmptyEnv("AI_MEMORY_PWSH") || "pwsh";
}

function runWindowsPowerShellProbe(scriptLines = []) {
  if (!IS_WINDOWS || !Array.isArray(scriptLines) || scriptLines.length === 0) {
    return { ok: false, stdout: "", stderr: "", status: null };
  }
  try {
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", scriptLines.join("\n")], {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: !probe.error && probe.status === 0,
      stdout: String(probe.stdout || "").trim(),
      stderr: String(probe.stderr || "").trim(),
      status: probe.status,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: String(error || ""),
      status: null,
    };
  }
}

function isHiddenWindowsScriptAlive(scriptPath, processFilter, commandMatchLines = []) {
  if (!IS_WINDOWS || !scriptPath || !fs.existsSync(scriptPath)) {
    return false;
  }
  const target = scriptPath.replace(/'/g, "''").toLowerCase();
  const probe = runWindowsPowerShellProbe([
    "$selfPid = $PID",
    `$target = '${target}'`,
    `$proc = Get-CimInstance Win32_Process -Filter "${processFilter}" -ErrorAction SilentlyContinue |`,
    "  Where-Object {",
    "    $cmd = [string]$_.CommandLine;",
    "    $_.ProcessId -ne $selfPid -and",
    "    -not [string]::IsNullOrWhiteSpace($cmd) -and",
    ...commandMatchLines,
    "  } | Select-Object -First 1",
    "if ($proc) { [Console]::Out.Write('1') }",
  ]);
  return probe.ok && probe.stdout === "1";
}

let watchdogSupervisorCache = {
  checkedAt: 0,
  alive: false,
};

function isWatchdogSupervisorAlive() {
  if (!IS_WINDOWS) {
    return false;
  }
  if (Date.now() - watchdogSupervisorCache.checkedAt < 3000) {
    return watchdogSupervisorCache.alive;
  }
  const vbsAlive = isHiddenWindowsScriptAlive(
    path.join(
      process.env.APPDATA || path.join(USER_HOME, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "AI Memory Watchdog.vbs",
    ),
    "Name='wscript.exe'",
    ["$cmd.ToLowerInvariant().Contains($target)"],
  );
  const scriptAlive = isHiddenWindowsScriptAlive(
    resolveRuntimePath(
      "memory-watchdog-supervisor.ps1",
      path.join("bus", "memory-watchdog-supervisor.ps1"),
    ),
    "Name='powershell.exe' or Name='pwsh.exe'",
    ["$cmd.ToLowerInvariant().Contains('-file') -and", "$cmd.ToLowerInvariant().Contains($target)"],
  );
  const alive = vbsAlive || scriptAlive;
  watchdogSupervisorCache = { checkedAt: Date.now(), alive };
  return alive;
}

export {
  WINDOWS_ENV_CACHE,
  RUNTIME_ENV_NAMES,
  firstNonEmptyEnv,
  buildMergedEnv,
  resolvePowerShellCommand,
  runWindowsPowerShellProbe,
  isHiddenWindowsScriptAlive,
  isWatchdogSupervisorAlive,
};