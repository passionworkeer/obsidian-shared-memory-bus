// Gemini embedding provider.
// Runs Python via worker pool with per-call spawn as fallback.

import { spawn } from "node:child_process";
import { DomainError, COMMON_CODES } from "../domain-error.js";
import { normalizeString } from "./utils.js";

export function createGeminiProvider({ pythonRuntime, withPythonArgs, getPool }) {
  async function embedWithGemini(texts, runtime) {
    if (!pythonRuntime.available) {
      throw new DomainError(
        COMMON_CODES.EXTERNAL_SERVICE,
        `python-runtime-unavailable: ${pythonRuntime.error || "unknown-error"}`,
      );
    }

    const apiKey = normalizeString(runtime.apiKey);
    const model = normalizeString(runtime.model || "gemini-embedding-2");
    if (!apiKey) {
      throw new DomainError(COMMON_CODES.INVALID_INPUT, "missing-gemini-api-key");
    }

    const pool = await getPool();
    if (pool) {
      try {
        await pool.initPool(
          pythonRuntime.command,
          withPythonArgs(pythonRuntime, ["-c", pool.buildWorkerScript()]),
          {
            ...process.env,
            TF_CPP_MIN_LOG_LEVEL: "3",
            TF_ENABLE_ONEDNN_OPTS: "0",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
          }
        );
        const vectors = await pool.embedWithPool({
          texts,
          model,
          pythonCmd: pythonRuntime.command,
          pythonArgs: withPythonArgs(pythonRuntime, ["-c", pool.buildWorkerScript()]),
          env: {
            ...process.env,
            TF_CPP_MIN_LOG_LEVEL: "3",
            TF_ENABLE_ONEDNN_OPTS: "0",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
          },
          msgType: "GEMINI_EMBED",
          apiKey,
          geminiModel: model.startsWith("models/") ? model : "models/" + model,
        });
        return {
          backendName: "gemini",
          modelName: model,
          vectors,
          providerHost: "generativelanguage.googleapis.com",
        };
      } catch (poolErr) {
        console.error("[embedding-registry] gemini pool error, falling back:", poolErr.message);
      }
    }

    // Fallback: per-call spawn.
    // Secrets (api_key, model) and payload are passed via stdin JSON, not heredoc interpolation,
    // to prevent shell/Python injection from a hostile env var or runtime config.
    const script = `
import json
import sys
import os
import urllib.request

payload = json.load(sys.stdin)
model_id = payload["model"]
api_key = payload["api_key"]
texts = payload["texts"]
if not model_id.startswith("models/"):
    model_id = "models/" + model_id
# Explicit proxy opener — urllib auto-detection from env vars is unreliable on Windows
http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
proxies = {}
if http_proxy: proxies["http"] = http_proxy
if https_proxy: proxies["https"] = https_proxy
_opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies)) if proxies else urllib.request.build_opener()
for text in texts:
    url = "https://generativelanguage.googleapis.com/v1beta/" + model_id + ":embedContent?key=" + api_key
    body_model = model_id.replace("models/", "")
    body = json.dumps({"model": body_model, "content": {"parts": [{"text": text}]}}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with _opener.open(req, timeout=60) as resp:
            resp_body = resp.read().decode("utf-8", errors="replace")
        parsed = json.loads(resp_body)
        emb_list = parsed.get("embeddings") or []
        vals = emb_list[0].get("values") if emb_list else None
        if not vals:
            emb_obj = parsed.get("embedding") or {}
            vals = emb_obj.get("values") if isinstance(emb_obj, dict) else None
        if vals:
            print(json.dumps({"ok": True, "vec": vals}))
        else:
            print(json.dumps({"ok": False, "err": "empty"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "err": str(exc)}))
`;
    const inputPayload = JSON.stringify({ model, api_key: apiKey, texts }) + "\n";
    return new Promise((resolve, reject) => {
      const child = spawn(pythonRuntime.command, withPythonArgs(pythonRuntime, ["-c", script]), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      let stdout = "";
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) console.error("[python-gemini-worker]", text);
      });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.on("error", (err) => reject(new Error(`gemini-process-error: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) { reject(new Error(`gemini-process-exit-${code}`)); return; }
        try {
          const vectors = [];
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            const r = JSON.parse(line);
            if (r.ok) vectors.push(r.vec.map((v) => Number(v)));
          }
          resolve({ backendName: "gemini", modelName: model, vectors, providerHost: "generativelanguage.googleapis.com" });
        } catch (e) { reject(new Error(`gemini-parse-error: ${e.message}`)); }
      });
      child.stdin.write(inputPayload);
      child.stdin.end();
    });
  }

  return { embedWithGemini };
}
