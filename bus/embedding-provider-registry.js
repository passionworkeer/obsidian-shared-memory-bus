const crypto = require("crypto");
const { spawn } = require("child_process");

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeEmbeddingAdapter(value, fallback = "") {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return normalizeString(fallback).toLowerCase();
  }

  if (normalized === "openai") {
    return "openai-compatible";
  }
  if (normalized === "hashing") {
    return "hash";
  }
  if (normalized === "sentence-transformer" || normalized === "sentence-transformers") {
    return "transformer";
  }
  return normalized;
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

function buildEmbeddingConfigHash({ backend, modelName, baseUrl = "" }) {
  const normalizedBackend = normalizeEmbeddingAdapter(backend, modelName);
  const normalizedBaseUrl =
    normalizedBackend === "openai-compatible" ? normalizeString(baseUrl).replace(/\/+$/, "") : "";
  const payload = JSON.stringify({
    backend: normalizedBackend,
    model: normalizeString(modelName),
    baseUrl: normalizedBaseUrl.toLowerCase(),
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
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

  async function embedWithTransformer(texts, runtime) {
    if (!pythonRuntime.available) {
      throw new Error(`python-runtime-unavailable: ${pythonRuntime.error || "unknown-error"}`);
    }

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
        env: {
          ...process.env,
          TF_CPP_MIN_LOG_LEVEL: "3",
          TF_ENABLE_ONEDNN_OPTS: "0",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `embedding-process-exit-${code}`));
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

  async function embedWithOpenAICompatible(texts, runtime) {
    const baseUrl = normalizeString(runtime.baseUrl).replace(/\/+$/, "");
    const apiKey = normalizeString(runtime.apiKey);
    const timeoutMs = Math.max(1000, Number(runtime.timeoutMs || 120000) || 120000);
    const requestDelayMs = Math.max(0, Number(runtime.requestDelayMs || 0) || 0);

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
        throw new Error(`openai-compatible-http-${response.status}: ${detail.slice(0, 500)}`);
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

      return {
        backendName: "openai-compatible",
        modelName: normalizeString(runtime.model),
        vectors,
        providerHost: getProviderHost(baseUrl),
      };
    } finally {
      clearTimeout(timeout);
    }
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
