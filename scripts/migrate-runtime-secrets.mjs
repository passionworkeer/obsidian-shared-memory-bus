#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  containsPlaintextApiKey,
  loadRuntimeConfig,
  writeRuntimeConfig,
} from "../bus/runtime-config.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEnvName(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`invalid environment variable name: ${normalized || "(empty)"}`);
  }
  return normalized;
}

function migrateValue(value, apiKeyEnv) {
  if (Array.isArray(value)) {
    let migratedCount = 0;
    const next = value.map((item) => {
      const migrated = migrateValue(item, apiKeyEnv);
      migratedCount += migrated.migratedCount;
      return migrated.value;
    });
    return { value: next, migratedCount };
  }

  if (!isPlainObject(value)) {
    return { value, migratedCount: 0 };
  }

  const next = {};
  let migratedCount = 0;
  let removedDirectKey = false;

  for (const [key, child] of Object.entries(value)) {
    if (key === "apiKey") {
      if (String(child || "").trim()) {
        migratedCount += 1;
        removedDirectKey = true;
      }
      continue;
    }
    const migrated = migrateValue(child, apiKeyEnv);
    next[key] = migrated.value;
    migratedCount += migrated.migratedCount;
  }

  if (removedDirectKey && !String(next.apiKeyEnv || "").trim()) {
    next.apiKeyEnv = apiKeyEnv;
  }

  return { value: next, migratedCount };
}

function migrateRuntimeSecrets({
  rootPath = "",
  apiKeyEnv = "AI_MEMORY_EMBED_API_KEY",
  dryRun = false,
} = {}) {
  const safeEnvName = validateEnvName(apiKeyEnv);
  const loaded = loadRuntimeConfig(rootPath);
  if (loaded.error) {
    throw new Error(`runtime-config-invalid:${loaded.error}`);
  }

  if (!containsPlaintextApiKey(loaded.data)) {
    return {
      ok: true,
      changed: false,
      dryRun: Boolean(dryRun),
      migratedCount: 0,
      configPath: loaded.configPath,
      sourcePath: loaded.sourcePath || "",
      inheritedFromTemplate: Boolean(loaded.inheritedFromTemplate),
      apiKeyEnv: safeEnvName,
    };
  }

  const migrated = migrateValue(loaded.data, safeEnvName);
  if (!dryRun) {
    writeRuntimeConfig(rootPath, migrated.value);
  }

  return {
    ok: true,
    changed: migrated.migratedCount > 0,
    dryRun: Boolean(dryRun),
    migratedCount: migrated.migratedCount,
    configPath: loaded.configPath,
    sourcePath: loaded.sourcePath || "",
    inheritedFromTemplate: Boolean(loaded.inheritedFromTemplate),
    apiKeyEnv: safeEnvName,
  };
}

function parseArgs(argv) {
  const options = {
    rootPath: "",
    apiKeyEnv: "AI_MEMORY_EMBED_API_KEY",
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--root" || token === "--api-key-env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      if (token === "--root") options.rootPath = value;
      else options.apiKeyEnv = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return options;
}

async function main() {
  try {
    const result = migrateRuntimeSecrets(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}

export {
  migrateRuntimeSecrets,
  migrateValue,
  parseArgs,
  validateEnvName,
};
