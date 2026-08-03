// shared-mcp/metrics/server.js
//
// HTTP transport for the metrics pipeline. Owns:
//   - The /metrics (Prometheus text) endpoint
//   - The /health (JSON snapshot) endpoint
//   - The /python-metrics proxy to the Python search-worker exporter (9091)
//   - The 60s metrics refresh interval

import http from "node:http";

import { COMMON_CODES, DomainError } from "../../bus/domain-error.js";
import { firstNonEmptyEnv } from "../omni-platform-helpers.js";
import { isAllowedLocalHttpRequest } from "../proto/http-guard.mjs";
import { log } from "./source.js";
import { buildMetricsSnapshot, collectMetrics, getSearchWorkerSnapshot } from "./compute.js";
import { refreshMetricsFromFiles } from "./source.js";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function startMetricsServer({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }) {
  const port = Number(firstNonEmptyEnv("AI_MEMORY_METRICS_PORT") || "9090");
  const metricsToken = firstNonEmptyEnv("AI_MEMORY_METRICS_TOKEN");
  const requireMetricsAuth = metricsToken && metricsToken.length > 0;

  const metricsServer = http.createServer((req, res) => {
    if (!isAllowedLocalHttpRequest(req.headers)) {
      sendJson(res, 403, { error: "forbidden-non-loopback-request" });
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        searchWorker: getSearchWorkerSnapshot(),
        snapshot: buildMetricsSnapshot({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary }),
      });
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      if (requireMetricsAuth) {
        const authHeader = req.headers["authorization"] || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token !== metricsToken) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4",
        "Cache-Control": "no-store",
      });
      res.end(collectMetrics());
      return;
    }
    if (req.method === "GET" && req.url === "/python-metrics") {
      const pythonPort = Number(firstNonEmptyEnv("AI_MEMORY_PY_METRICS_PORT") || "9091");
      const pythonReq = http.get(
        {
          hostname: "127.0.0.1",
          port: pythonPort,
          path: "/metrics",
          timeout: 3000,
          headers: { Host: `127.0.0.1:${pythonPort}` },
        },
        (pythonRes) => {
          res.writeHead(pythonRes.statusCode || 200, {
            "Content-Type": "text/plain; version=0.0.4",
            "Cache-Control": "no-store",
          });
          pythonRes.pipe(res);
        },
      );
      pythonReq.on("error", () => {
        sendJson(res, 503, { error: "python-metrics-unavailable" });
      });
      pythonReq.on("timeout", () => {
        pythonReq.destroy();
        sendJson(res, 503, { error: "python-metrics-timeout" });
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("Not Found");
  });

  metricsServer.on("error", (err) => {
    if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
      log.error("metrics-server-bind-failed", { port, code: err.code, error: err.message });
      const wrapped = new DomainError(
        err.code === "EADDRINUSE" ? COMMON_CODES.CONFLICT : COMMON_CODES.PERMISSION_DENIED,
        `metrics-server-bind-failed: ${err.message}`,
        { cause: err },
      );
      wrapped.code = err.code;
      metricsServer.emit("bind-error", wrapped);
      return;
    }
    log.error("metrics-server-error", { port, error: err.message });
  });

  metricsServer.listen(port, "127.0.0.1", () => {
    log.info("metrics-server-started", { port, host: "127.0.0.1" });
  });
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
