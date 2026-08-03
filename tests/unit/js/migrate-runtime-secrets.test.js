import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { containsPlaintextApiKey } from "../../../bus/runtime-config.js";
import {
  migrateRuntimeSecrets,
  parseArgs,
  validateEnvName,
} from "../../../scripts/migrate-runtime-secrets.mjs";

describe("runtime secret migration", () => {
  let tempRoot;
  let originalStore;
  let originalConfigPath;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-secret-migration-"));
    originalStore = process.env.AI_MEMORY_STORE;
    originalConfigPath = process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
    process.env.AI_MEMORY_STORE = tempRoot;
    delete process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
  });

  afterEach(() => {
    if (originalStore == null) delete process.env.AI_MEMORY_STORE;
    else process.env.AI_MEMORY_STORE = originalStore;
    if (originalConfigPath == null) delete process.env.AI_MEMORY_RUNTIME_CONFIG_PATH;
    else process.env.AI_MEMORY_RUNTIME_CONFIG_PATH = originalConfigPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeUnsafeConfig(targetRoot = tempRoot) {
    const configPath = path.join(targetRoot, "config", "runtime.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      embeddings: {
        providers: {
          first: {
            adapter: "openai-compatible",
            apiKey: "secret-one",
          },
          second: {
            adapter: "gemini",
            apiKey: "secret-two",
            apiKeyEnv: "EXISTING_KEY_ENV",
          },
        },
      },
    }, null, 2), "utf8");
    return configPath;
  }

  test("dry run reports changes without mutating or exposing secrets", () => {
    const configPath = writeUnsafeConfig();
    const before = fs.readFileSync(configPath, "utf8");

    const result = migrateRuntimeSecrets({
      rootPath: tempRoot,
      apiKeyEnv: "MIGRATED_EMBED_KEY",
      dryRun: true,
    });

    assert.equal(result.changed, true);
    assert.equal(result.migratedCount, 2);
    assert.equal(result.dryRun, true);
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
    assert.equal(JSON.stringify(result).includes("secret-one"), false);
    assert.equal(JSON.stringify(result).includes("secret-two"), false);
  });

  test("migrates plaintext keys to environment references", () => {
    const configPath = writeUnsafeConfig();

    const result = migrateRuntimeSecrets({
      rootPath: tempRoot,
      apiKeyEnv: "MIGRATED_EMBED_KEY",
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.migratedCount, 2);

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(containsPlaintextApiKey(persisted), false);
    assert.equal(persisted.embeddings.providers.first.apiKeyEnv, "MIGRATED_EMBED_KEY");
    assert.equal(persisted.embeddings.providers.second.apiKeyEnv, "EXISTING_KEY_ENV");
  });

  test("is idempotent after migration", () => {
    writeUnsafeConfig();
    migrateRuntimeSecrets({ rootPath: tempRoot });
    const second = migrateRuntimeSecrets({ rootPath: tempRoot });
    assert.equal(second.changed, false);
    assert.equal(second.migratedCount, 0);
  });

  test("migrates inherited template data without modifying the template", () => {
    const templatePath = path.join(tempRoot, "templates", "config", "runtime.json");
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    const original = JSON.stringify({
      embeddings: {
        providers: {
          remote: { adapter: "openai-compatible", apiKey: "template-secret" },
        },
      },
    }, null, 2);
    fs.writeFileSync(templatePath, original, "utf8");

    const result = migrateRuntimeSecrets({ rootPath: tempRoot });
    assert.equal(result.inheritedFromTemplate, true);
    assert.equal(fs.readFileSync(templatePath, "utf8"), original);

    const configPath = path.join(tempRoot, "config", "runtime.json");
    assert.ok(fs.existsSync(configPath));
    assert.equal(containsPlaintextApiKey(JSON.parse(fs.readFileSync(configPath, "utf8"))), false);
  });

  test("validates CLI arguments and environment variable names", () => {
    assert.deepEqual(
      parseArgs(["--root", "/tmp/store", "--api-key-env", "REMOTE_KEY", "--dry-run"]),
      { rootPath: "/tmp/store", apiKeyEnv: "REMOTE_KEY", dryRun: true },
    );
    assert.equal(validateEnvName("VALID_KEY_1"), "VALID_KEY_1");
    assert.throws(() => validateEnvName("NOT-VALID-KEY"), /invalid environment variable/);
    assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
  });
});
