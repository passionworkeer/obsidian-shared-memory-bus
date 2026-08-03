/**
 * Guard the four-server split manifest contract.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "../../../shared-mcp/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

describe("manifest.json — four-server split", () => {
  test("contains the four memory subset servers", () => {
    const memoryServers = manifest.servers.filter((server) => server.id.startsWith("memory-"));
    assert.equal(memoryServers.length, 4);
    assert.deepEqual(
      memoryServers.map((server) => server.id),
      ["memory-retrieval", "memory-bridge", "memory-dream", "memory-mgmt"],
    );
  });

  test("uses unique proxy ports 9338-9341", () => {
    const memoryServers = manifest.servers.filter((server) => server.id.startsWith("memory-"));
    const ports = memoryServers.map((server) => server.port).sort((a, b) => a - b);
    assert.deepEqual(ports, [9338, 9339, 9340, 9341]);
  });

  test("declares modes and non-colliding metrics ports", () => {
    const memoryServers = manifest.servers.filter((server) => server.id.startsWith("memory-"));
    for (const server of memoryServers) {
      assert.ok(server.stdioEnv, `${server.id} must declare stdioEnv`);
      const expectedMode = server.id.replace("memory-", "");
      assert.equal(server.stdioEnv.AI_MEMORY_SERVER_MODE, expectedMode);
      assert.equal(Number(server.stdioEnv.AI_MEMORY_METRICS_PORT), server.port + 100);
      assert.notEqual(Number(server.stdioEnv.AI_MEMORY_METRICS_PORT), server.port);
    }
  });

  test("attaches the isolated search worker only to retrieval", () => {
    const retrieval = manifest.servers.find((server) => server.id === "memory-retrieval");
    assert.ok(retrieval.isolatedSubprocess);
    assert.equal(retrieval.isolatedSubprocess.managedBy, "memory-retrieval");

    for (const id of ["memory-bridge", "memory-dream", "memory-mgmt"]) {
      const server = manifest.servers.find((entry) => entry.id === id);
      assert.equal(server.isolatedSubprocess, undefined);
    }
  });

  test("keeps the search worker restart policy", () => {
    const retrieval = manifest.servers.find((server) => server.id === "memory-retrieval");
    assert.equal(retrieval.isolatedSubprocess.restartPolicy, "always");
    assert.equal(retrieval.isolatedSubprocess.maxRestarts, 5);
    assert.equal(retrieval.isolatedSubprocess.circuitWindowMs, 300000);
  });
});

describe("manifest.json — legacy monolithic compatibility", () => {
  test("retains the mutually-exclusive legacy memory entry", () => {
    const legacy = manifest.servers.find((server) => server.id === "memory");
    assert.ok(legacy);
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.port, 9338);
  });

  test("uses all mode and a separate legacy metrics port", () => {
    const legacy = manifest.servers.find((server) => server.id === "memory");
    assert.equal(legacy.stdioEnv.AI_MEMORY_SERVER_MODE, "all");
    assert.equal(legacy.stdioEnv.AI_MEMORY_METRICS_PORT, "9438");
  });
});

describe("manifest.json — overall shape", () => {
  test("contains 13 server entries", () => {
    assert.equal(manifest.servers.length, 13);
  });

  test("all non-isolated servers have valid ports", () => {
    for (const server of manifest.servers) {
      if (server.id === "pencil") {
        assert.equal(server.mode, "isolated");
        continue;
      }
      assert.ok(typeof server.port === "number", `${server.id} must have a port`);
      assert.ok(server.port > 0, `${server.id} port must be positive`);
    }
  });
});
