import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_SERVERS,
  getServerMetricsPort,
  getServerPort,
} from "../../../shared-mcp/port-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "../../../shared-mcp/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

describe("shared MCP manifest consistency", () => {
  test("memory proxy and metrics ports match port-registry.js", () => {
    const manifestById = new Map(manifest.servers.map((server) => [server.id, server]));

    for (const registryServer of MCP_SERVERS.filter((server) => server.id === "memory" || server.id.startsWith("memory-"))) {
      const manifestServer = manifestById.get(registryServer.id);
      assert.ok(manifestServer, `${registryServer.id} must exist in manifest.json`);
      assert.equal(manifestServer.port, getServerPort(registryServer));

      const metricsPort = getServerMetricsPort(registryServer);
      if (metricsPort !== null) {
        assert.equal(
          Number(manifestServer.stdioEnv?.AI_MEMORY_METRICS_PORT),
          metricsPort,
          `${registryServer.id} metrics port must not collide with its proxy port`,
        );
        assert.notEqual(metricsPort, manifestServer.port);
      }
    }
  });

  test("npx fallback commands are reproducibly pinned", () => {
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes("@latest"), false);
  });
});
