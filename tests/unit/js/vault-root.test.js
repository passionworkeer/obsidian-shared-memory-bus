import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const VAULT_ROOT_JS = path.join(REPO_ROOT, "bus", "vault-root.js");

async function importFresh(envSnapshot) {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import(pathToFileURL(VAULT_ROOT_JS).href + `?t=${Date.now()}-${Math.random()}`);
  return mod;
}

function snapshotEnv() {
  return {
    AI_MEMORY_OBSIDIAN_VAULT: process.env.AI_MEMORY_OBSIDIAN_VAULT,
    OBSIDIAN_VAULT_ROOT: process.env.OBSIDIAN_VAULT_ROOT,
    AI_MEMORY_STORE: process.env.AI_MEMORY_STORE,
    AI_MEMORY_STORE_ROOT: process.env.AI_MEMORY_STORE_ROOT,
    AI_MEMORY_ROOT: process.env.AI_MEMORY_ROOT,
  };
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("resolveVaultRoot returns AI_MEMORY_OBSIDIAN_VAULT when set", async () => {
  const snapshot = snapshotEnv();
  const fakeVault = fs.mkdtempSync(path.join(os.tmpdir(), "ai-vault-test-"));
  try {
    const mod = await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: fakeVault,
      OBSIDIAN_VAULT_ROOT: undefined,
      AI_MEMORY_STORE: "/should/not/be/used",
      AI_MEMORY_STORE_ROOT: undefined,
      AI_MEMORY_ROOT: undefined,
    });
    assert.equal(mod.resolveVaultRoot(), path.resolve(fakeVault));
  } finally {
    restoreEnv(snapshot);
    fs.rmSync(fakeVault, { recursive: true, force: true });
  }
});

test("resolveVaultRoot does not fall through to store env when no vault env is set", async () => {
  const snapshot = snapshotEnv();
  try {
    const mod = await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: undefined,
      OBSIDIAN_VAULT_ROOT: undefined,
      AI_MEMORY_STORE: "/tmp/store-only",
      AI_MEMORY_STORE_ROOT: undefined,
      AI_MEMORY_ROOT: undefined,
    });
    const result = mod.resolveVaultRoot();
    assert.notEqual(result, "/tmp/store-only");
    assert.notEqual(result, path.resolve("/tmp/store-only"));
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveVaultRoot does not fall through to AI_MEMORY_STORE_ROOT", async () => {
  const snapshot = snapshotEnv();
  try {
    const mod = await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: undefined,
      OBSIDIAN_VAULT_ROOT: undefined,
      AI_MEMORY_STORE: undefined,
      AI_MEMORY_STORE_ROOT: "/tmp/store-root-only",
      AI_MEMORY_ROOT: undefined,
    });
    assert.notEqual(mod.resolveVaultRoot(), "/tmp/store-root-only");
    assert.notEqual(mod.resolveVaultRoot(), path.resolve("/tmp/store-root-only"));
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveVaultRoot does not fall through to AI_MEMORY_ROOT", async () => {
  const snapshot = snapshotEnv();
  try {
    const mod = await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: undefined,
      OBSIDIAN_VAULT_ROOT: undefined,
      AI_MEMORY_STORE: undefined,
      AI_MEMORY_STORE_ROOT: undefined,
      AI_MEMORY_ROOT: "/tmp/root-only",
    });
    assert.notEqual(mod.resolveVaultRoot(), "/tmp/root-only");
    assert.notEqual(mod.resolveVaultRoot(), path.resolve("/tmp/root-only"));
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveVaultRoot prefers OBSIDIAN_VAULT_ROOT over store env", async () => {
  const snapshot = snapshotEnv();
  const fakeVault = fs.mkdtempSync(path.join(os.tmpdir(), "ai-vault-test-"));
  try {
    const mod = await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: undefined,
      OBSIDIAN_VAULT_ROOT: fakeVault,
      AI_MEMORY_STORE: "/should/not/be/used",
      AI_MEMORY_STORE_ROOT: "/should/not/be/used/either",
      AI_MEMORY_ROOT: "/should/not/be/used/either/either",
    });
    assert.equal(mod.resolveVaultRoot(), path.resolve(fakeVault));
  } finally {
    restoreEnv(snapshot);
    fs.rmSync(fakeVault, { recursive: true, force: true });
  }
});

test("getDefaultVaultCandidates returns a non-empty list with no store envs", async () => {
  const snapshot = snapshotEnv();
  try {
    await importFresh({
      AI_MEMORY_OBSIDIAN_VAULT: undefined,
      OBSIDIAN_VAULT_ROOT: undefined,
      AI_MEMORY_STORE: undefined,
      AI_MEMORY_STORE_ROOT: undefined,
      AI_MEMORY_ROOT: undefined,
    });
    const mod = await import(pathToFileURL(VAULT_ROOT_JS).href + `?t=${Date.now()}-${Math.random()}`);
    const candidates = mod.getDefaultVaultCandidates();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length > 0, "getDefaultVaultCandidates should not return empty array");
  } finally {
    restoreEnv(snapshot);
  }
});
