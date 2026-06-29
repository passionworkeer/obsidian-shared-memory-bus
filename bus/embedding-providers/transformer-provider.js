// Transformer (SentenceTransformer) embedding provider.
// Runs Python via worker pool with per-call spawn as fallback.

import { spawn } from "node:child_process";
import { DomainError, COMMON_CODES } from "../domain-error.js";
import { normalizeString } from "./utils.js";

export function createTransformerProvider({ pythonRuntime, withPythonArgs, getPool }) {
  async function embedWithTransformer(texts, runtime) {
    if (!pythonRuntime.available) {
      throw new DomainError(
        COMMON_CODES.EXTERNAL_SERVICE,
        `python-runtime-unavailable: ${pythonRuntime.error || "unknown-error"}`,
      );
    }

    const pool = await getPool();
    if (pool) {
      try {
        // Warm pool: init if not already running, then use warm workers
        await pool.initPool(
          pythonRuntime.command,
          withPythonArgs(pythonRuntime, ["-c", pool.buildWorkerScript()]),
          {
            ...process.env,
            TF_CPP_MIN_LOG_LEVEL: "3",
            TF_ENABLE_ONEDNN_OPTS: "0",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
            ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
            ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
            ...(process.env.http_proxy ? { http_proxy: process.env.http_proxy } : {}),
            ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
          }
        );
        const result = await pool.embedWithPool({
          texts,
          model: normalizeString(runtime.model),
          pythonCmd: pythonRuntime.command,
          pythonArgs: withPythonArgs(pythonRuntime, ["-c", pool.buildWorkerScript()]),
          env: {
            ...process.env,
            TF_CPP_MIN_LOG_LEVEL: "3",
            TF_ENABLE_ONEDNN_OPTS: "0",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
            ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
            ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          },
        });
        return {
          backendName: "transformer",
          modelName: normalizeString(runtime.model),
          vectors: result,
          providerHost: "",
        };
      } catch (poolErr) {
        // Pool failed (backpressure, init error) — fall through to per-call spawn
        console.error("[embedding-registry] pool error, falling back to spawn:", poolErr.message);
      }
    }

    // Per-call spawn (legacy fallback when pool unavailable)
    const script = `
import json
import sys
from sentence_transformers import SentenceTransformer

payload = json.load(sys.stdin)
model = SentenceTransformer(payload["model"])
vectors = model.encode(payload["texts"], show_progress_bar=False, convert_to_numpy=True)
json.dump([vector.tolist() for vector in vectors], sys.stdout)
`;
    const payload = JSON.stringify({
      model: normalizeString(runtime.model),
      texts,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(pythonRuntime.command, withPythonArgs(pythonRuntime, ["-c", script]), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          TF_CPP_MIN_LOG_LEVEL: "3",
          TF_ENABLE_ONEDNN_OPTS: "0",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          ...(process.env.http_proxy ? { http_proxy: process.env.http_proxy } : {}),
          ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
        },
      });

      let stdout = "";
      // FIX: Drain stderr immediately on each chunk to prevent buffer deadlock.
      // The Python embedding worker emits errors/logs to stderr — never accumulate.
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          console.error("[python-embedding-worker]", text);
        }
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", (err) => {
        reject(new Error(`embedding-process-error: ${err.message}`));
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`embedding-process-exit-${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`invalid-embedding-json: ${error.message}`));
        }
      });

      child.stdin.end(payload);
    });
  }

  return { embedWithTransformer };
}
