/**
 * Health check utilities for isolated subprocess MCP services.
 *
 * Provides both synchronous process-health checks and async HTTP health probes.
 */

import { spawn } from "node:child_process";
import http from "node:http";

/**
 * Probe types for different server kinds.
 */
export const PROBE_TYPES = {
  MCP_INITIALIZE: "mcp-initialize", // Send MCP initialize + tool/list, expect response
  HTTP_HEALTH: "http-health",       // GET /healthz or /health, expect JSON with status
  HTTP_METRICS: "http-metrics",     // GET /metrics, expect Prometheus text format
  STDIO_ECHO: "stdio-echo",         // Write JSON, expect same JSON back
};

/**
 * Check if a process is alive (has not exited).
 * @param {ChildProcess|null} child
 * @returns {boolean}
 */
export function isProcessAlive(child) {
  return Boolean(child && !child.killed && child.exitCode === null);
}

/**
 * Probe an HTTP endpoint.
 * @param {string} host
 * @param {number} port
 * @param {string} [path="/healthz"]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ok: boolean, status?: number, latencyMs?: number, body?: string, error?: string}>}
 */
export function probeHttp(host, port, path = "/healthz", timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk.toString(); });
      res.on("end", () => {
        resolve({
          ok: res.statusCode < 400,
          status: res.statusCode,
          latencyMs: Date.now() - started,
          body,
        });
      });
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err.message, latencyMs: Date.now() - started });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout", latencyMs: Date.now() - started });
    });
  });
}

/**
 * Probe a stdio MCP server by sending an initialize request.
 * @param {string} pythonPath - Path to python executable
 * @param {string} scriptPath - Path to the MCP server script
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{ok: boolean, latencyMs?: number, error?: string}>}
 */
export function probeStdioMcp(pythonPath, scriptPath, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(pythonPath, [scriptPath, "--server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutData = "";
    let stderrData = "";
    let settled = false;

    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok, error, latencyMs: Date.now() - started });
    };

    const timer = setTimeout(() => settle(false, "timeout"), timeoutMs);

    child.stdout.on("data", (chunk) => { stdoutData += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

    child.on("error", (err) => settle(false, err.message));
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Any exit is considered a failure for probing — we expect the process to keep running
      settle(false, `process exited with code ${code}`);
    });

    // Send a minimal MCP initialize probe
    const initPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
    child.stdin.write(initPayload, () => {
      // Give it a moment to respond
      setTimeout(() => {
        if (stdoutData.trim()) {
          try {
            JSON.parse(stdoutData.trim());
            settle(true);
          } catch {
            settle(false, "invalid JSON response");
          }
        } else {
          settle(false, "no response");
        }
      }, 500);
    });
  });
}

/**
 * Wait for a service to become healthy within a timeout.
 * @param {string} host
 * @param {number} port
 * @param {string} [path="/healthz"]
 * @param {number} [timeoutMs=30000]
 * @param {number} [intervalMs=1000]
 * @returns {Promise<boolean>}
 */
export async function waitForHealthy(host, port, path = "/healthz", timeoutMs = 30000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeHttp(host, port, path, 3000);
    if (result.ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Build a health snapshot for a subprocess service.
 * @param {object} options
 * @param {ChildProcess|null} options.child - The child process
 * @param {string} options.id - Service ID
 * @param {number} options.port - HTTP port (if applicable)
 * @param {string} [options.host="127.0.0.1"]
 * @param {string} [options.healthPath="/healthz"]
 * @returns {Promise<object>}
 */
export async function buildServiceSnapshot({ child, id, port, host = "127.0.0.1", healthPath = "/healthz" }) {
  const alive = isProcessAlive(child);
  let httpHealth = null;

  if (alive && port) {
    httpHealth = await probeHttp(host, port, healthPath, 5000).catch(() => ({ ok: false }));
  }

  return {
    id,
    alive,
    pid: child?.pid || null,
    exitCode: child?.exitCode ?? null,
    httpHealth: httpHealth ? { ok: httpHealth.ok, status: httpHealth.status } : null,
  };
}