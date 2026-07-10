import { buildEmbeddingConfigHash, normalizeEmbeddingAdapter } from "./shared-crypto.js";
import { COMMON_CODES, DomainError } from "./domain-error.js";

function normalizeString(value) {
  return String(value || "").trim();
}

// Q-HIGH-4: 抽 getProxyEnv() 消除 4 处 process.env.HTTP(S)_PROXY 重复
function getProxyEnv() {
  return {
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.http_proxy ? { http_proxy: process.env.http_proxy } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
  };
}

function getProviderHost(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL(baseUrl).host || "";
  } catch {
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
  // Q-CRIT-4 + Q-HIGH-4 partial: 抽 per-call Python spawn helper,
  // 之前 transformer (130-178) 与 gemini (279-306) 各自重复了相同 ~50 行
  // spawn + stdout/stderr drain + close-then-resolve + proxy env 4 行。
  // 同时避免 stderr 缓冲死锁 (立即 drain)。
  function spawnPythonWorker(scriptText, inputPayload, label) {
    return new Promise((resolve, reject) => {
      const child = spawn(pythonRuntime.command, withPythonArgs(pythonRuntime, ["-c", scriptText]), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          ...(label === "transformer"
            ? {
                TF_CPP_MIN_LOG_LEVEL: "3",
                TF_ENABLE_ONEDNN_OPTS: "0",
                ...getProxyEnv(),
              }
            : {}),
        },
      });
      let stdout = "";
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) console.error(`[python-${label}-worker]`, text);
      });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.on("error", (err) => reject(new Error(`${label}-process-error: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) { reject(new Error(`${label}-process-exit-${code}`)); return; }
        resolve(stdout);
      });
      if (inputPayload !== undefined) child.stdin.write(inputPayload);
      child.stdin.end();
    });
  }

  // Q-CRIT-4/Q-HIGH-1 split candidate: per-call Python scripts (transformer + gemini)
  // moved to top-level constants so the worker-pool.cjs script template can be
  // generated from the same source instead of maintained in 3 places (per-call × 2
  // + worker-pool.cjs:145 行 template literal).
  const PER_CALL_SENTENCE_TRANSFORMER_SCRIPT = `
import json
import sys
from sentence_transformers import SentenceTransformer

payload = json.load(sys.stdin)
model = SentenceTransformer(payload["model"])
vectors = model.encode(payload["texts"], show_progress_bar=False, convert_to_numpy=True)
json.dump([vector.tolist() for vector in vectors], sys.stdout)
`;

  const PER_CALL_GEMINI_SCRIPT = `
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

  const _pool = null;

  async function getPool() {
    if (_pool) return _pool;
    try {
      const mod = require("../shared-mcp/embedding-worker-pool.cjs");
      return mod;
    } catch (err) {
      console.warn(
        "[embedding-registry] worker pool unavailable, falling back to per-call spawn:",
        err && err.message ? err.message : String(err),
      );
      return null;
    }
  }

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
        await pool.initPool(
          pythonRuntime.command,
          withPythonArgs(pythonRuntime, ["-c", pool.buildWorkerScript()]),
          {
            ...process.env,
            TF_CPP_MIN_LOG_LEVEL: "3",
            TF_ENABLE_ONEDNN_OPTS: "0",
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
            ...getProxyEnv(),
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
        console.error("[embedding-registry] pool error, falling back to spawn:", poolErr.message);
      }
    }

    const payload = JSON.stringify({
      model: normalizeString(runtime.model),
      texts,
    });
    const stdout = await spawnPythonWorker(PER_CALL_SENTENCE_TRANSFORMER_SCRIPT, payload, "transformer");
    try {
      const vectors = JSON.parse(stdout);
      return {
        backendName: "transformer",
        modelName: normalizeString(runtime.model),
        vectors,
        providerHost: "",
      };
    } catch (e) {
      throw new Error(`invalid-embedding-json: ${e.message}`);
    }
  }

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

    // Per-call spawn fallback (Q-CRIT-4: shared helper with transformer path).
    // Secret (api_key, model) and payload passed via stdin JSON, not heredoc interpolation,
    // to prevent shell/Python injection from a hostile env var or runtime config.
    const inputPayload = JSON.stringify({ model, api_key: apiKey, texts }) + "\n";
    const stdout = await spawnPythonWorker(PER_CALL_GEMINI_SCRIPT, inputPayload, "gemini");
    try {
      const vectors = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.ok) vectors.push(r.vec.map((v) => Number(v)));
      }
      return {
        backendName: "gemini",
        modelName: model,
        vectors,
        providerHost: "generativelanguage.googleapis.com",
      };
    } catch (e) {
      throw new Error(`gemini-parse-error: ${e.message}`);
    }
  }

  async function embedWithOpenAICompatible(texts, runtime) {
    const baseUrl = normalizeString(runtime.baseUrl).replace(/\/+$/, "");
    const apiKey = normalizeString(runtime.apiKey);
    const timeoutMs = Math.max(1000, Number(runtime.timeoutMs || 120000) || 120000);
    const requestDelayMs = Math.max(0, Number(runtime.requestDelayMs || 0) || 0);
    const maxRetries = Math.max(0, Number(runtime.maxRetries || 3) || 3);

    if (!baseUrl) {
      throw new DomainError(COMMON_CODES.INVALID_INPUT, "missing-openai-base-url");
    }
    if (!apiKey) {
      throw new DomainError(COMMON_CODES.INVALID_INPUT, "missing-openai-api-key");
    }
    if (typeof fetchImpl !== "function") {
      throw new DomainError(COMMON_CODES.INTERNAL, "fetch-unavailable");
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
          throw new DomainError(
            COMMON_CODES.EXTERNAL_SERVICE,
            `openai-compatible-count-mismatch:${vectors.length}/${texts.length}`,
          );
        }

        for (const vector of vectors) {
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new DomainError(COMMON_CODES.EXTERNAL_SERVICE, "openai-compatible-empty-vector");
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

export {
  buildEmbeddingConfigHash,
  createEmbeddingProviderRegistry,
  getProviderHost,
  normalizeEmbeddingAdapter,
};
