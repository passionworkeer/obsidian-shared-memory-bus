/**
 * bus/text-utility.js — small text + Windows-env helpers used by
 * generate-embeddings.js (Q-HIGH-1 step 4 — split from 759-line file).
 *
 * No state. Safe to import anywhere.
 */

import { spawnSync } from "node:child_process";

const WINDOWS_ENV_CACHE = new Map();

/**
 * Read a Windows User/Machine env var via PowerShell.
 * No-op on non-Windows. Returns "" on error or invalid name.
 * Env-var names are allowlisted to identifiers — defends against
 * PowerShell injection if a future caller passes a crafted name.
 */
export function readWindowsEnvironmentVariable(name) {
  if (process.platform !== "win32") {
    return "";
  }
  if (!/^[A-Za-z0-9_]+$/.test(String(name || ""))) {
    return "";
  }
  if (WINDOWS_ENV_CACHE.has(name)) {
    return WINDOWS_ENV_CACHE.get(name);
  }

  const escapedName = String(name || "").replace(/'/g, "''");
  const command = [
    `$value = [Environment]::GetEnvironmentVariable('${escapedName}', 'User')`,
    "if ([string]::IsNullOrWhiteSpace($value)) {",
    `  $value = [Environment]::GetEnvironmentVariable('${escapedName}', 'Machine')`,
    "}",
    "if (-not [string]::IsNullOrWhiteSpace($value)) { [Console]::Out.Write($value) }",
  ].join("; ");

  let value = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      value = String(result.stdout || "").trim();
    }
  } catch {
    value = "";
  }

  WINDOWS_ENV_CACHE.set(name, value);
  return value;
}

/**
 * First non-empty env var across the given names, falling back to
 * Windows User/Machine env if process.env is missing.
 */
export function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const name of names) {
    const value = readWindowsEnvironmentVariable(name);
    if (value) {
      return value;
    }
  }
  return "";
}

/**
 * Populate process.env from Windows User/Machine for any names not
 * already set. No-op on non-Windows.
 */
export function hydrateProcessEnvFromWindows(names) {
  if (process.platform !== "win32" || !Array.isArray(names)) {
    return;
  }

  for (const name of names) {
    const normalized = String(name || "").trim();
    if (!normalized || firstNonEmptyEnv(normalized)) {
      continue;
    }

    const value = readWindowsEnvironmentVariable(normalized);
    if (value) {
      process.env[normalized] = value;
    }
  }
}

/**
 * Resolve embed timeout from AI_MEMORY_EMBED_TIMEOUT_MS or
 * AI_MEMORY_EMBED_TIMEOUT_SECONDS (default 120s, min 1s).
 */
export function resolveEmbedTimeoutMs() {
  const timeoutMs = Number(firstNonEmptyEnv("AI_MEMORY_EMBED_TIMEOUT_MS") || "0") || 0;
  if (timeoutMs > 0) {
    return Math.max(1000, timeoutMs);
  }

  const timeoutSeconds = Number(firstNonEmptyEnv("AI_MEMORY_EMBED_TIMEOUT_SECONDS") || "120") || 120;
  return Math.max(1000, timeoutSeconds * 1000);
}

/** Collapse runs of whitespace to a single space and trim ends. */
export function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
