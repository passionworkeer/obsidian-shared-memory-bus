#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const registryPath = path.join(root, "shared-mcp", "services.registry.json");
const manifestPath = path.join(root, "shared-mcp", "manifest.json");

const INTERNAL_FIELDS = new Set([
  "portOffset",
  "metricsOffset",
  "core",
  "critical",
  "topology",
  "runtimeCommand",
  "runtimeArgs",
  "runtimeEnv",
]);

function loadRegistry() {
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

function validateRegistry(registry) {
  if (!registry || registry.version !== 1 || !Array.isArray(registry.servers)) {
    throw new Error("invalid-services-registry");
  }
  const basePort = registry.defaults?.basePort;
  if (!Number.isInteger(basePort) || basePort <= 0) {
    throw new Error("invalid-services-registry-base-port");
  }

  const ids = new Set();
  for (const service of registry.servers) {
    if (!service?.id || ids.has(service.id)) {
      throw new Error(`duplicate-or-missing-service-id:${service?.id || "missing"}`);
    }
    ids.add(service.id);
    if (service.portOffset != null && (!Number.isInteger(service.portOffset) || service.portOffset < 0)) {
      throw new Error(`invalid-port-offset:${service.id}`);
    }
    if (service.metricsOffset != null && (!Number.isInteger(service.metricsOffset) || service.metricsOffset < 0)) {
      throw new Error(`invalid-metrics-offset:${service.id}`);
    }
    if (service.runtimeCommand && !Array.isArray(service.runtimeArgs)) {
      throw new Error(`runtime-args-required:${service.id}`);
    }
    if (service.core && !service.runtimeCommand) {
      throw new Error(`core-runtime-command-required:${service.id}`);
    }
    if (service.topology && !["split", "monolithic"].includes(service.topology)) {
      throw new Error(`invalid-topology:${service.id}:${service.topology}`);
    }
  }
  return registry;
}

function buildManifest(registry = loadRegistry()) {
  validateRegistry(registry);
  const basePort = registry.defaults.basePort;
  const servers = registry.servers.map((service) => {
    const output = {};
    for (const [key, value] of Object.entries(service)) {
      if (!INTERNAL_FIELDS.has(key)) {
        output[key] = value;
      }
    }

    if (Number.isInteger(service.portOffset)) {
      output.port = basePort + service.portOffset;
    }

    if (service.runtimeEnv || Number.isInteger(service.metricsOffset)) {
      output.stdioEnv = {
        ...(service.runtimeEnv || {}),
      };
      if (Number.isInteger(service.metricsOffset)) {
        output.stdioEnv.AI_MEMORY_METRICS_PORT = String(basePort + service.metricsOffset);
      }
    }

    return output;
  });

  return {
    version: registry.version,
    protocolVersion: registry.protocolVersion,
    defaults: registry.defaults,
    servers,
  };
}

function normalizeManifestForCheck(manifest) {
  return {
    version: manifest.version,
    protocolVersion: manifest.protocolVersion,
    defaults: manifest.defaults,
    servers: [...manifest.servers]
      .map(({ notes: _notes, ...service }) => service)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function generate({ check = false } = {}) {
  const expectedObject = buildManifest();
  const expected = serialize(expectedObject);
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";

  if (check) {
    let currentObject;
    try {
      currentObject = JSON.parse(current);
    } catch {
      throw new Error("generated-service-artifacts-invalid-json");
    }
    if (!isDeepStrictEqual(
      normalizeManifestForCheck(currentObject),
      normalizeManifestForCheck(expectedObject),
    )) {
      throw new Error("generated-service-artifacts-stale: run npm run generate:services");
    }
    return { ok: true, changed: false, manifestPath };
  }

  const changed = current !== expected;
  if (changed) {
    fs.writeFileSync(manifestPath, expected, "utf8");
  }
  return { ok: true, changed, manifestPath };
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg !== "--check") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check: argv.includes("--check") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = generate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  buildManifest,
  generate,
  loadRegistry,
  normalizeManifestForCheck,
  parseArgs,
  serialize,
  validateRegistry,
};
