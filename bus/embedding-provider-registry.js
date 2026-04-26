const { spawn } = require("child_process");
const { buildEmbeddingConfigHash, normalizeEmbeddingAdapter } = require("./shared-crypto.js");

function normalizeString(value) {
  return String(value || "").trim();
}

function getProviderHost(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL(baseUrl).host || "";
  } catch (_error) {
    return "";
  }
}

function createEmbeddingProviderRegistry(options = {}) {
  const pythonRuntime = options.pythonRuntime || {};
  const withPythonArgs =
    typeof options.withPythonArgs === "function" ? options.withPythonArgs : (_runtime, args) => args;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const sleep = typeof options.sleep === "function" ? options.sleep : async () => {};
  const buildHashEmbedding =
    typeof options.buildHashEmbedding === "function"
      ? options.buildHashEmbedding
      : () => {
          throw new Error("buildHashEmbedding dependency is required");
        };
  const hashModel = normalizeString(options.hashModel || "hashing-v1") || "hashing-v1";

  // Lazy-import worker pool to avoid circular dependency and allow optional usage.
  // Falls back to per-call spawn if pool init fails.
  let _pool = null;

  async function getPool() {
    if (_pool) return _pool;
    try {
      _pool = require("../shared-mcp/embedding-worker-pool.cjs");
    } catch {
      return null;
    }
    return _pool;
  }

  async function embedWithTransformer(texts, runtime) {
    if (!pythonRuntime.available) {
      throw new Error(`python-runtime-unavailable: ${pythonRuntime.error || "unknown-error"}`);
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

  const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

  async function embedWithGemini(texts, runtime) {
    if (!pythonRuntime.available) {
      throw new Error(`python-runtime-unavailable: ${pythonRuntime.error || "unknown-error"}`);
    }

    const apiKey = normalizeString(runtime.apiKey);
    const model = normalizeString(runtime.model || "gemini-embedding-2");
    if (!apiKey) {
      throw new Error("missing-gemini-api-key");
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

    // Fallback: per-call spawn
    const script = `
import json
import sys
import urllib.request
model_id = "${model}"
api_key = "${apiKey}"
if not model_id.startswith("models/"):
    model_id = "models/" + model_id
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    text = line
    url = "https://generativelanguage.googleapis.com/v1beta/" + model_id + ":embedContent?key=" + api_key
    body_model = model_id.replace("models/", "")
    payload = json.dumps({"model": body_model, "content": {"parts": [{"text": text}]}}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        parsed = json.loads(body)
        embeddings = parsed.get("embeddings") or []
        vals = embeddings[0].get("values") if embeddings else None
        if vals:
            print(json.dumps({"ok": True, "vec": vals}))
        else:
            print(json.dumps({"ok": False, "err": "empty"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "err": str(exc)}))
`;
    const inputPayload = texts.join("\n") + "\n";
    const { spawn } = require("child_process");
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

  async function embedWithOpenAICompatible(texts, runtime) {
    const baseUrl = normalizeString(runtime.baseUrl).replace(/\/+$/, "");
    const apiKey = normalizeString(runtime.apiKey);
    const timeoutMs = Math.max(1000, Number(runtime.timeoutMs || 120000) || 120000);
    const requestDelayMs = Math.max(0, Number(runtime.requestDelayMs || 0) || 0);
    const maxRetries = Math.max(0, Number(runtime.maxRetries || 3) || 3);

    if (!baseUrl) {
      throw new Error("missing-openai-base-url");
    }
    if (!apiKey) {
      throw new Error("missing-openai-api-key");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch-unavailable");
    }

    if (requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        await sleep(delayMs);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: normalizeString(runtime.model),
            input: texts,
            encoding_format: "float",
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          const error = new Error(`openai-compatible-http-${response.status}: ${detail.slice(0, 500)}`);
          const isRetryable = response.status === 429 || response.status >= 500;
          if (isRetryable && attempt < maxRetries) {
            lastError = error;
            clearTimeout(timeout);
            continue;
          }
          clearTimeout(timeout);
          throw error;
        }

        const payload = await response.json();
        const vectors = Array.isArray(payload.data)
          ? payload.data
              .slice()
              .sort((left, right) => (left.index || 0) - (right.index || 0))
              .map((item) => item.embedding)
          : [];

        if (vectors.length !== texts.length) {
          throw new Error(`openai-compatible-count-mismatch:${vectors.length}/${texts.length}`);
        }

        for (const vector of vectors) {
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error("openai-compatible-empty-vector");
          }
        }

        clearTimeout(timeout);
        return {
          backendName: "openai-compatible",
          modelName: normalizeString(runtime.model),
          vectors,
          providerHost: getProviderHost(baseUrl),
        };
      } catch (error) {
        lastError = error;
        const isRetryable = error.message && (error.message.includes("429") || error.message.includes("5"));
        if (!isRetryable || attempt >= maxRetries) {
          clearTimeout(timeout);
          throw error;
        }
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  const adapters = {
    hash: {
      name: "hash",
      defaultModel: hashModel,
      defaultBatchSize() {
        return 24;
      },
      async embedBatch({ texts }) {
        return {
          backendName: "hash",
          modelName: hashModel,
          vectors: texts.map((text) => buildHashEmbedding(text)),
          providerHost: "",
        };
      },
    },
    transformer: {
      name: "transformer",
      defaultBatchSize() {
        return 24;
      },
      async embedBatch({ texts, runtime }) {
        return {
          backendName: "transformer",
          modelName: normalizeString(runtime.model),
          vectors: await embedWithTransformer(texts, runtime),
          providerHost: "",
        };
      },
    },
    "openai-compatible": {
      name: "openai-compatible",
      defaultBatchSize() {
        return 8;
      },
      async embedBatch({ texts, runtime }) {
        return embedWithOpenAICompatible(texts, runtime);
      },
    },
    gemini: {
      name: "gemini",
      defaultBatchSize() {
        return 4;
      },
      async embedBatch({ texts, runtime }) {
        return embedWithGemini(texts, runtime);
      },
    },
  };

  return {
    get(name) {
      const normalized = normalizeEmbeddingAdapter(name, "hash");
      return adapters[normalized] || adapters.hash;
    },
    list() {
      return Object.keys(adapters);
    },
  };
}

module.exports = {
  buildEmbeddingConfigHash,
  createEmbeddingProviderRegistry,
  getProviderHost,
  normalizeEmbeddingAdapter,
};
