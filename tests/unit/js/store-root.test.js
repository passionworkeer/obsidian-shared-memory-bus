import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolveStoreRoot } from "../../../bus/store-root.js";

async function getDefaultStoreCandidatesFromModule() {
  const mod = await import("../../../bus/store-root.js");
  return mod.getDefaultStoreCandidates();
}

// Snapshot of all store/vault env vars so each test can mutate freely.
const STORE_ENV_KEYS = [
  "AI_MEMORY_STORE",
  "AI_MEMORY_STORE_ROOT",
  "AI_MEMORY_ROOT",
  "AI_MEMORY_OBSIDIAN_VAULT",
  "OBSIDIAN_VAULT_ROOT",
];

function snapshotEnv() {
  const snap = {};
  for (const key of STORE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      snap[key] = process.env[key];
    }
  }
  return snap;
}

function restoreEnv(snap) {
  for (const key of STORE_ENV_KEYS) {
    if (key in snap) process.env[key] = snap[key];
    else delete process.env[key];
  }
}

function clearStoreEnv() {
  for (const key of STORE_ENV_KEYS) delete process.env[key];
}

describe("store root resolution", () => {
  test("resolveStoreRoot returns a non-empty string", () => {
    const snap = snapshotEnv();
    clearStoreEnv();
    try {
      const result = resolveStoreRoot();
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
    } finally {
      restoreEnv(snap);
    }
  });

  test("resolveStoreRoot uses AI_MEMORY_STORE when set", () => {
    const snap = snapshotEnv();
    clearStoreEnv();
    process.env.AI_MEMORY_STORE = "C:/test/store";
    try {
      const result = resolveStoreRoot();
      assert.equal(result, path.resolve("C:/test/store"));
    } finally {
      restoreEnv(snap);
    }
  });

  test("vault bridge: vault's 00-System/ai-memory wins when no STORE env is set", () => {
    const snap = snapshotEnv();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-vault-"));
    const vaultAiMemory = path.join(tmp, "00-System", "ai-memory");
    fs.mkdirSync(vaultAiMemory, { recursive: true });
    clearStoreEnv();
    process.env.AI_MEMORY_OBSIDIAN_VAULT = tmp;
    try {
      const result = resolveStoreRoot();
      assert.equal(result, path.resolve(vaultAiMemory));
    } finally {
      restoreEnv(snap);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("vault bridge is demoted below AI_MEMORY_STORE (explicit wins)", () => {
    const snap = snapshotEnv();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-vault-"));
    const vaultAiMemory = path.join(tmp, "00-System", "ai-memory");
    fs.mkdirSync(vaultAiMemory, { recursive: true });
    clearStoreEnv();
    process.env.AI_MEMORY_OBSIDIAN_VAULT = tmp;
    process.env.AI_MEMORY_STORE = "C:/explicit/store";
    try {
      const result = resolveStoreRoot();
      assert.equal(result, path.resolve("C:/explicit/store"));
    } finally {
      restoreEnv(snap);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("vault bridge wins over legacy AI_MEMORY_ROOT (symmetric with Python)", () => {
    const snap = snapshotEnv();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-vault-"));
    const vaultAiMemory = path.join(tmp, "00-System", "ai-memory");
    fs.mkdirSync(vaultAiMemory, { recursive: true });
    clearStoreEnv();
    process.env.AI_MEMORY_OBSIDIAN_VAULT = tmp;
    process.env.AI_MEMORY_ROOT = "C:/legacy/root";
    try {
      const result = resolveStoreRoot();
      assert.equal(result, path.resolve(vaultAiMemory));
      assert.notEqual(result, path.resolve("C:/legacy/root"));
    } finally {
      restoreEnv(snap);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AI_MEMORY_ROOT used when no vault bridge applies", () => {
    const snap = snapshotEnv();
    const savedAppdata = process.env.APPDATA;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    clearStoreEnv();
    process.env.AI_MEMORY_ROOT = "C:/legacy/root";
    // Simulate "no vault discoverable": redirect Obsidian config lookup at an
    // empty dir so resolveFromObsidianConfig finds no obsidian.json, and no
    // hard-coded default candidate matches. Only then does legacy AI_MEMORY_ROOT
    // win (the vault bridge has nothing to bridge to).
    const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-vault-"));
    process.env.APPDATA = emptyTmp;
    process.env.XDG_CONFIG_HOME = emptyTmp;
    try {
      const result = resolveStoreRoot();
      assert.equal(result, path.resolve("C:/legacy/root"));
    } finally {
      fs.rmSync(emptyTmp, { recursive: true, force: true });
      if (savedAppdata === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppdata;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      restoreEnv(snap);
    }
  });

  test("getDefaultStoreCandidates returns array of paths", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length > 0);
    candidates.forEach((c) => {
      assert.strictEqual(typeof c, "string");
      assert.ok(c.length > 0);
    });
  });

  test("getDefaultStoreCandidates contains ai-memory paths", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    const hasAiMem = candidates.some((c) => c.includes("ai-memory"));
    assert.ok(hasAiMem, "should contain ai-memory path");
  });

  test("getDefaultStoreCandidates removes duplicates", async () => {
    const candidates = await getDefaultStoreCandidatesFromModule();
    const unique = [...new Set(candidates)];
    assert.strictEqual(candidates.length, unique.length);
  });
});