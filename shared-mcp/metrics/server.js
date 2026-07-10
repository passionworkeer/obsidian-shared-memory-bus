// shared-mcp/metrics/server.js
//
// HTTP transport for the metrics pipeline. Owns:
//   - The /metrics (Prometheus text) endpoint
//   - The /health (JSON snapshot) endpoint
//   - The /python-metrics proxy to the Python search-worker exporter (9091)
//   - The 60s metrics refresh interval
//
// DomainError is raised on the two most user-visible failure paths
// (port-in-use and listen error) so callers can distinguish startup
// failures from runtime glitches without parsing the underlying EADDRINUSE
// codes themselves. The internal request handlers continue to surface
// their own HTTP status codes; only the lifecycle errors use DomainError.

import http from "node:http";

import { COMMON_CODES, DomainError } from "../../bus/domain-error.js";
import { firstNonEmptyEnv } from "../omni-platform-helpers.js";
import { log } from "./source.js";
import { buildMetricsSnapshot, collectMetrics, getSearchWorkerSnapshot } from "./compute.js";
import { refreshMetricsFromFiles } from "./source.js";

function startMetricsServer({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }) {
  const port = Number(firstNonEmptyEnv("AI_MEMORY_METRICS_PORT") || "9090");
  const metricsToken = firstNonEmptyEnv("AI_MEMORY_METRICS_TOKEN");
  const requireMetricsAuth = metricsToken && metricsToken.length > 0;

  const metricsServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        searchWorker: getSearchWorkerSnapshot(),
        // Phase 1A: full metrics snapshot at /health
        snapshot: buildMetricsSnapshot({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }),
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      if (requireMetricsAuth) {
        const authHeader = req.headers["authorization"] || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== metricsToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(collectMetrics());
      return;
    }
    // Phase 1A: proxy Python-side metrics from the search worker exporter (9091)
    if (req.method === "GET" && req.url === "/python-metrics") {
      const pythonPort = Number(firstNonEmptyEnv("AI_MEMORY_PY_METRICS_PORT") || "9091");
      const pythonReq = http.get(
        { hostname: "127.0.0.1", port: pythonPort, path: "/metrics", timeout: 3000 },
        (pythonRes) => {
          res.writeHead(pythonRes.statusCode || 200, { "Content-Type": "text/plain; version=0.0.4" });
          pythonRes.pipe(res);
        },
      );
      pythonReq.on("error", () => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "python-metrics-unavailable" }));
      });
      pythonReq.on("timeout", () => {
        pythonReq.destroy();
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "python-metrics-timeout" }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  metricsServer.on("error", (err) => {
    // DomainError on lifecycle errors: callers can detect a startup/bind
    // failure without sniffing node EADDRINUSE codes.
    if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
      log.error("metrics-server-bind-failed", { port, code: err.code, error: err.message });
      const wrapped = new DomainError(
        err.code === "EADDRINUSE" ? COMMON_CODES.CONFLICT : COMMON_CODES.PERMISSION_DENIED,
        `metrics-server-bind-failed: ${err.message}`,
        { cause: err },
      );
      // Preserve the original code for tests/diagnostics
      wrapped.code = err.code;
      // Surface synchronously so callers awaiting a ready signal can react.
      metricsServer.emit("bind-error", wrapped);
      return;
    }
    log.error("metrics-server-error", { port, error: err.message });
  });

  metricsServer.listen(port, "127.0.0.1", () => { log.info("metrics-server-started", { port, host: "127.0.0.1" }); });
}

function startMetricsRefreshInterval({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary }) {
  setInterval(
    () => refreshMetricsFromFiles({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary }),
    60_000,
  );
  refreshMetricsFromFiles({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary });
}

export {
  startMetricsServer,
  startMetricsRefreshInterval,
};
