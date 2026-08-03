import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildEmbeddingRuntimeCatalog,
  containsPlaintextApiKey,
  loadRuntimeConfig,
  normalizeEmbeddingAdapter,
  resolveEmbeddingRuntime,
  resolveRuntimeConfigPath,
  resolveRuntimeConfigTemplatePath,
  stripPlaintextApiKeys,
  updateEmbeddingRuntimeSelection,
  writeRuntimeConfig,
} from "../../../bus/runtime-config.js";

const TEMPLATE = {
  embeddings: {
    activeProfile: "local-hash",
    activeProvider: "local-hash",
    providers: {
      "local-hash": { adapter: "hash", model: "hashing-v1" },
      remote: {
        adapter: "openai-compatible",
        model: "text-embedding-3-small",
        apiKey: "must-not-be-used",
        apiKeyEnv: "TEST_EMBED_KEY",
      },
    },
    profiles: {
      "local-hash": { provider: "local-hash" },
      remote: { provider: "remote" },
    },
  },
};

describe("runtime config", () => {
  let tempRoot;
  let originalStore;
  let originalStoreRoot;
  let originalConfigPath;
  let originalEmbedKey;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-"));
    originalStore = process.env.AI_MEMORY_STORE;
    originalStoreRoot = process.env.AI_MEMORY_STORE_ROOT;
    originalConfigPath = process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
    originalEmbedKey = process.env.TEST_EMBED_KEY;
    process.env.AI_MEMORY_STORE = tempRoot;
    delete process.env.AI_MEMORY_STORE_ROOT;
    delete process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
    delete process.env.TEST_EMBED_KEY;
  });

  afterEach(() => {
    if (originalStore == null) delete process.env.AI_MEMORY_STORE;
    else process.env.AI_MEMORY_STORE = originalStore;
    if (originalStoreRoot == null) delete process.env.AI_MEMORY_STORE_ROOT;
    else process.env.AI_MEMORY_STORE_ROOT = originalStoreRoot;
    if (originalConfigPath == null) delete process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
    else process.env.AI_MEMORY_RUNTIME_CONFIG_PATH = originalConfigPath;
    if (originalEmbedKey == null) delete process.env.TEST_EMBED_KEY;
    else process.env.TEST_EMBED_KEY = originalEmbedKey;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("normalizes supported adapter aliases", () => {
    assert.equal(normalizeEmbeddingAdapter("OpenAI"), "openai-compatible");
    assert.equal(normalizeEmbeddingAdapter("hashing"), "hash");
    assert.equal(normalizeEmbeddingAdapter("invalid", "hash"), "hash");
    assert.equal(normalizeEmbeddingAdapter("", "fallback"), "fallback");
  });

  test("resolves the writable config below the canonical store", () => {
    const result = resolveRuntimeConfigPath();
    assert.equal(result, path.join(tempRoot, "config", "runtime.json"));
    assert.equal(result.includes(`${path.sep}templates${path.sep}`), false);
  });

  test("honors an explicit runtime config path", () => {
    const explicit = path.join(tempRoot, "custom", "runtime.json");
    process.env.AI_MEMORY_RUNTIME_CONFIG_PATH = explicit;
    assert.equal(resolveRuntimeConfigPath(), explicit);
  });

  test("loads a template as read-only seed data", () => {
    const templatePath = path.join(tempRoot, "templates", "config", "runtime.json");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(templatePath, `${JSON.stringify(TEMPLATE, null, 2)}\n`, "utf8");

    assert.equal(resolveRuntimeConfigTemplatePath(tempRoot), templatePath);
    const loaded = loadRuntimeConfig(tempRoot);
    assert.equal(loaded.exists, false);
    assert.equal(loaded.inheritedFromTemplate, true);
    assert.equal(loaded.sourcePath, templatePath);
    assert.equal(loaded.configPath, path.join(tempRoot, "config", "runtime.json"));
    assert.equal(loaded.data.embeddings.activeProfile, "local-hash");
  });

  test("writes atomically without persisting plaintext apiKey fields", () => {
    const configPath = writeRuntimeConfig(tempRoot, TEMPLATE);
    assert.equal(configPath, path.join(tempRoot, "config", "runtime.json"));
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(containsPlaintextApiKey(persisted), false);
    assert.equal(persisted.embeddings.providers.remote.apiKey, undefined);
    assert.equal(persisted.embeddings.providers.remote.apiKeyEnv, "TEST_EMBED_KEY");
    assert.deepEqual(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    }
  });

  test("stripPlaintextApiKeys recursively removes secrets", () => {
    const cleaned = stripPlaintextApiKeys({
      embeddings: {
        defaults: { apiKey: "one", apiKeyEnv: "ENV_ONE" },
        providers: { remote: { apiKey: "two", nested: { apiKey: "three" } } },
      },
    });
    assert.equal(containsPlaintextApiKey(cleaned), false);
    assert.equal(cleaned.embeddings.defaults.apiKeyEnv, "ENV_ONE");
  });

  test("ignores plaintext configured keys and reports a warning", () => {
    writeRuntimeConfig(tempRoot, TEMPLATE);
    const rawPath = resolveRuntimeConfigPath(tempRoot);
    const unsafe = JSON.parse(fs.readFileSync(rawPath, "utf8"));
    unsafe.embeddings.activeProfile = "remote";
    unsafe.embeddings.activeProvider = "remote";
    unsafe.embeddings.providers.remote.apiKey = "plaintext-secret";
    fs.writeFileSync(rawPath, `${JSON.stringify(unsafe, null, 2)}\n`, "utf8");

    const runtime = resolveEmbeddingRuntime({ rootPath: tempRoot });
    assert.equal(runtime.apiKey, "");
    assert.equal(runtime.plaintextApiKeyIgnored, true);

    const catalog = buildEmbeddingRuntimeCatalog({ rootPath: tempRoot });
    assert.ok(catalog.warnings.some((warning) => warning.startsWith("plaintext-api-key-ignored")));
  });

  test("resolves remote keys only through environment variables", () => {
    const safeTemplate = stripPlaintextApiKeys(TEMPLATE);
    safeTemplate.embeddings.activeProfile = "remote";
    safeTemplate.embeddings.activeProvider = "remote";
    writeRuntimeConfig(tempRoot, safeTemplate);
    process.env.TEST_EMBED_KEY = "runtime-secret";

    const runtime = resolveEmbeddingRuntime({ rootPath: tempRoot });
    assert.equal(runtime.apiKey, "runtime-secret");
    assert.equal(runtime.apiKeyEnv, "TEST_EMBED_KEY");
    assert.equal(runtime.plaintextApiKeyIgnored, false);
  });

  test("selection updates copy template data into writable config", () => {
    const templatePath = path.join(tempRoot, "templates", "config", "runtime.json");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    const originalTemplate = `${JSON.stringify(TEMPLATE, null, 2)}\n`;
    fs.writeFileSync(templatePath, originalTemplate, "utf8");

    const result = updateEmbeddingRuntimeSelection({
      rootPath: tempRoot,
      profile: "remote",
    });

    assert.equal(result.ok, true);
    assert.equal(result.configPath, path.join(tempRoot, "config", "runtime.json"));
    assert.equal(fs.readFileSync(templatePath, "utf8"), originalTemplate);
    const persisted = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
    assert.equal(persisted.embeddings.activeProfile, "remote");
    assert.equal(persisted.embeddings.activeProvider, "remote");
    assert.equal(containsPlaintextApiKey(persisted), false);
  });

  test("catalog exposes template inheritance and runtime metadata", () => {
    const templatePath = path.join(tempRoot, "templates", "config", "runtime.json");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(templatePath, `${JSON.stringify(TEMPLATE, null, 2)}\n`, "utf8");

    const catalog = buildEmbeddingRuntimeCatalog({ rootPath: tempRoot });
    assert.equal(catalog.configExists, false);
    assert.equal(catalog.configInheritedFromTemplate, true);
    assert.equal(catalog.configSourcePath, templatePath);
    assert.ok(catalog.warnings.includes("runtime-config-inherited-from-read-only-template"));
    assert.equal(catalog.runtime.adapter, "hash");
  });
});
