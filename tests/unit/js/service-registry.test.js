import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  generate,
  loadRegistry,
  validateRegistry,
} from "../../../scripts/generate-service-artifacts.mjs";
import {
  CRITICAL_PORTS,
  DEFAULT_BASE_PORT,
  MCP_SERVERS,
  SERVICE_REGISTRY,
  SPLIT_MEMORY_METRICS_PORTS,
  SPLIT_MEMORY_SERVER_PORTS,
} from "../../../shared-mcp/port-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const registry = loadRegistry();
const manifest = JSON.parse(fs.readFileSync(
  path.join(root, "shared-mcp", "manifest.json"),
  "utf8",
));
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const install = fs.readFileSync(path.join(root, "docs", "guides", "INSTALL.md"), "utf8");
const apiReference = fs.readFileSync(path.join(root, "docs", "guides", "API_REFERENCE.md"), "utf8");

describe("canonical service registry", () => {
  test("is valid and loaded by port-registry.js", () => {
    assert.equal(validateRegistry(registry), registry);
    assert.deepEqual(SERVICE_REGISTRY, registry);
    assert.equal(DEFAULT_BASE_PORT, registry.defaults.basePort);
  });

  test("generates a semantically current public manifest", () => {
    assert.equal(generate({ check: true }).ok, true);
    const generated = buildManifest(registry);
    assert.equal(generated.version, manifest.version);
    assert.equal(generated.protocolVersion, manifest.protocolVersion);
    assert.equal(generated.servers.length, manifest.servers.length);
  });

  test("derives every runtime server from registry entries", () => {
    const expected = registry.servers
      .filter((service) => service.core && service.runtimeCommand)
      .map((service) => service.id);
    assert.deepEqual(MCP_SERVERS.map((service) => service.id), expected);
  });

  test("derives split and metrics maps without collisions", () => {
    for (const [subset, port] of Object.entries(SPLIT_MEMORY_SERVER_PORTS)) {
      assert.equal(SPLIT_MEMORY_METRICS_PORTS[subset], port + 100);
      assert.ok(CRITICAL_PORTS.includes(port));
      assert.equal(CRITICAL_PORTS.includes(port + 100), false);
    }
  });

  test("keeps production fallback commands pinned", () => {
    const serialized = JSON.stringify(registry);
    assert.equal(serialized.includes("@latest"), false);
  });
});

describe("registry consumer coverage", () => {
  const corePorts = registry.servers
    .filter((service) => service.core && service.topology !== "monolithic")
    .map((service) => DEFAULT_BASE_PORT + service.portOffset);

  test("Docker and Compose expose every split core port", () => {
    for (const port of corePorts) {
      assert.ok(dockerfile.includes(String(port)), `Dockerfile must expose ${port}`);
      assert.ok(compose.includes(`${port}:${port}`), `Compose must publish ${port}`);
    }
  });

  test("installation and API docs include every split memory endpoint", () => {
    for (const service of registry.servers.filter((entry) => entry.topology === "split")) {
      const port = DEFAULT_BASE_PORT + service.portOffset;
      assert.ok(install.includes(service.id));
      assert.ok(install.includes(String(port)));
      assert.ok(apiReference.includes(service.id));
      assert.ok(apiReference.includes(`127.0.0.1:${port}/mcp`));
    }
  });
});
