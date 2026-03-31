// generate-embeddings.js
// Incrementally rebuilds the shared dense index from structured/*.jsonl.

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || __dirname;
const PYTHON = process.env.AI_MEMORY_PYTHON || "python";
const MODEL = process.env.AI_MEMORY_EMBED_MODEL || "all-MiniLM-L6-v2";
const EMBED_BACKEND = (process.env.AI_MEMORY_EMBED_BACKEND || "hash").toLowerCase();
const OPENAI_BASE_URL = (process.env.AI_MEMORY_EMBED_BASE_URL || "").trim().replace(/\/+$/, "");
const OPENAI_API_KEY = (process.env.AI_MEMORY_EMBED_API_KEY || "").trim();
const OPENAI_REQUEST_DELAY_MS = Math.max(0, Number(process.env.AI_MEMORY_EMBED_REQUEST_DELAY_MS || "0") || 0);
const OPENAI_TIMEOUT_MS = Math.max(1000, Number(process.env.AI_MEMORY_EMBED_TIMEOUT_MS || "120000") || 120000);
const EXPLICIT_BATCH_SIZE = Math.max(0, Number(process.env.AI_MEMORY_EMBED_BATCH_SIZE || "0") || 0);
const HASH_MODEL = "hashing-v1";
const HASH_DIM = 384;

const NOISE_PATTERNS = [
  /^Sender\s*\(/i,
  /^System:/i,
  /^Subagent Context/i,
  /^\[Subagent Context\]/i,
  /^Exec completed/i,
  /^Exec failed/i,
  /^A new session was started/i,
  /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i,
  /^Run your Session Startup/i,
];

function resolveVaultRoot() {
  for (const envKey of ["AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const defaults = [
    "E:/desktop/Obsidian Vault",
    path.join(USER_HOME, "Documents", "Obsidian Vault"),
  ];
  return defaults.find((candidate) => fs.existsSync(candidate)) || defaults[0];
}

const VAULT_ROOT = resolveVaultRoot();
const SHARED_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_DIR = path.join(SHARED_MEMORY_ROOT, "structured");
const EMBEDDINGS_DIR = path.join(SHARED_MEMORY_ROOT, "embeddings");
const INDEX_FILE = path.join(EMBEDDINGS_DIR, "index.jsonl");

function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function ensureDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBackend(value, modelName) {
  const backend = String(value || "").trim().toLowerCase();
  if (backend) {
    return backend;
  }
  if (String(modelName || "").trim().toLowerCase().startsWith("hashing-")) {
    return "hash";
  }
  return "transformer";
}

function isNoise(text) {
  const normalized = normalizeSpaces(text);
  if (!normalized || normalized.length < 5) {
    return true;
  }
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function fallbackId(entry, title, content) {
  const seed = [entry.tool || "", entry.t || "", title || "", content || ""].join("|");
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function buildSearchText(entry) {
  return normalizeSpaces(
    [
      entry.title || "",
      entry.content || "",
      entry.agent || "",
      entry.project || "",
      entry.type || "",
      entry.tool || "",
    ].join(" ")
  ).slice(0, 6000);
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function buildHashFeatures(text) {
  const source = normalizeSpaces(text).toLowerCase();
  const features = [];
  const compact = source.replace(/\s+/g, "");

  for (const token of source.match(/[a-z0-9][a-z0-9_\-./:]{1,}/g) || []) {
    features.push(`w:${token}`);
  }

  for (const chunk of source.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    features.push(`c:${chunk}`);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      features.push(`c2:${chunk.slice(index, index + 2)}`);
    }
    for (let index = 0; index < chunk.length - 2; index += 1) {
      features.push(`c3:${chunk.slice(index, index + 3)}`);
    }
  }

  const maxGramCount = Math.max(0, Math.min(compact.length - 2, 400));
  for (let index = 0; index < maxGramCount; index += 1) {
    features.push(`g3:${compact.slice(index, index + 3)}`);
  }

  if (features.length === 0 && compact) {
    features.push(`raw:${compact}`);
  }
  return features;
}

function buildHashEmbedding(text, dimension = HASH_DIM) {
  const vector = new Array(dimension).fill(0);
  const features = buildHashFeatures(text);
  for (const feature of features) {
    const hash = fnv1a32(feature);
    const slot = hash % dimension;
    const sign = ((hash >>> 1) & 1) === 0 ? 1 : -1;
    vector[slot] += sign;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = Number((vector[index] / norm).toFixed(8));
    }
  }
  return vector;
}

function buildDocument(entry) {
  const title = normalizeSpaces(entry.title || "");
  const content = normalizeSpaces(entry.content || "");
  const rawText = normalizeSpaces([title, content].filter(Boolean).join(" "));
  if (isNoise(rawText)) {
    return null;
  }

  const id = String(entry.id || "").trim() || fallbackId(entry, title, content);
  const text = buildSearchText(entry);
  const contentHash = crypto.createHash("sha256").update(text).digest("hex");

  return {
    id,
    tool: normalizeSpaces(entry.tool || "unknown") || "unknown",
    type: normalizeSpaces(entry.type || ""),
    project: normalizeSpaces(entry.project || ""),
    agent: normalizeSpaces(entry.agent || ""),
    t: normalizeSpaces(entry.t || ""),
    title: title || rawText.slice(0, 120) || id,
    excerpt: (content || rawText || text).slice(0, 240),
    text,
    contentHash,
  };
}

function collectDocuments() {
  const documents = new Map();
  if (!fs.existsSync(STRUCTURED_DIR)) {
    return documents;
  }

  for (const fileName of fs.readdirSync(STRUCTURED_DIR).sort()) {
    if (!fileName.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(STRUCTURED_DIR, fileName);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        const document = buildDocument(entry);
        if (document) {
          documents.set(document.id, document);
        }
      } catch {
        // Ignore malformed records during rebuild.
      }
    }
  }

  return documents;
}

function loadExistingIndex() {
  const existing = new Map();
  if (!fs.existsSync(INDEX_FILE)) {
    return existing;
  }

  const lines = fs.readFileSync(INDEX_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && record.id) {
        existing.set(record.id, record);
      }
    } catch {
      // Ignore malformed lines and continue rebuilding.
    }
  }

  return existing;
}

function resolveBatchSize() {
  if (EXPLICIT_BATCH_SIZE > 0) {
    return EXPLICIT_BATCH_SIZE;
  }
  if (EMBED_BACKEND === "openai" || EMBED_BACKEND === "openai-compatible") {
    return 8;
  }
  return 24;
}

function embedBatchWithTransformer(texts, modelName) {
  return new Promise((resolve, reject) => {
    const script = `
import json
import sys
from sentence_transformers import SentenceTransformer

payload = json.load(sys.stdin)
model = SentenceTransformer(payload["model"])
vectors = model.encode(payload["texts"], show_progress_bar=False, convert_to_numpy=True)
json.dump([vector.tolist() for vector in vectors], sys.stdout)
`;
    const child = spawn(PYTHON, ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3", TF_ENABLE_ONEDNN_OPTS: "0" },
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

    child.stdin.end(JSON.stringify({ model: modelName, texts }));
  });
}

async function embedBatchWithOpenAICompatible(texts, modelName) {
  if (!OPENAI_BASE_URL) {
    throw new Error("missing-openai-base-url");
  }
  if (!OPENAI_API_KEY) {
    throw new Error("missing-openai-api-key");
  }

  if (OPENAI_REQUEST_DELAY_MS > 0) {
    await sleep(OPENAI_REQUEST_DELAY_MS);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelName,
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

    return vectors;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedBatch(texts, modelName) {
  if (EMBED_BACKEND === "transformer") {
    try {
      return {
        modelName,
        vectors: await embedBatchWithTransformer(texts, modelName),
      };
    } catch (error) {
      console.warn(`Transformer embeddings unavailable, falling back to ${HASH_MODEL}: ${error.message}`);
      return {
        modelName: HASH_MODEL,
        vectors: texts.map((text) => buildHashEmbedding(text)),
      };
    }
  }

  if (EMBED_BACKEND === "openai" || EMBED_BACKEND === "openai-compatible") {
    try {
      return {
        modelName,
        vectors: await embedBatchWithOpenAICompatible(texts, modelName),
      };
    } catch (error) {
      console.warn(`OpenAI-compatible embeddings unavailable, falling back to ${HASH_MODEL}: ${error.message}`);
      return {
        modelName: HASH_MODEL,
        vectors: texts.map((text) => buildHashEmbedding(text)),
      };
    }
  }

  return {
    modelName: HASH_MODEL,
    vectors: texts.map((text) => buildHashEmbedding(text)),
  };
}

async function main() {
  const force = process.argv.includes("--force");
  ensureDirectory(EMBEDDINGS_DIR);

  const documents = collectDocuments();
  const existing = loadExistingIndex();
  const preferredBackend = normalizeBackend(EMBED_BACKEND, MODEL);
  const preferredModelName =
    EMBED_BACKEND === "transformer" || EMBED_BACKEND === "openai" || EMBED_BACKEND === "openai-compatible"
      ? MODEL
      : HASH_MODEL;
  const orderedDocuments = Array.from(documents.values()).sort((left, right) => left.id.localeCompare(right.id));
  const finalRecords = new Map();
  const pending = [];

  for (const document of orderedDocuments) {
    const current = existing.get(document.id);
    const isReusable =
      !force &&
      current &&
      current.contentHash === document.contentHash &&
      normalizeBackend(current.backend, current.model) === preferredBackend &&
      current.model === preferredModelName &&
      Array.isArray(current.embedding) &&
      current.embedding.length > 0;

    if (isReusable) {
      finalRecords.set(document.id, {
        ...current,
        ...document,
        backend: normalizeBackend(current.backend, current.model),
      });
      continue;
    }

    pending.push(document);
  }

  console.log(`Structured documents: ${orderedDocuments.length}`);
  console.log(`Existing vectors: ${existing.size}`);
  console.log(`Pending vectors: ${pending.length}`);

  if (orderedDocuments.length === 0) {
    fs.writeFileSync(INDEX_FILE, "", "utf8");
    console.log("No structured documents found. Wrote empty embeddings index.");
    return;
  }

  const batchSize = resolveBatchSize();
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const batchCount = Math.ceil(pending.length / batchSize);
    process.stdout.write(`Embedding batch ${batchNumber}/${batchCount} (${batch.length} docs)... `);
    const { vectors, modelName } = await embedBatch(batch.map((document) => document.text.slice(0, 3000)), MODEL);
    for (let index = 0; index < batch.length; index += 1) {
      const document = batch[index];
      finalRecords.set(document.id, {
        ...document,
        embedding: vectors[index],
        dim: Array.isArray(vectors[index]) ? vectors[index].length : 0,
        backend: normalizeBackend(EMBED_BACKEND, modelName),
        model: modelName,
        indexedAt: new Date().toISOString(),
      });
    }
    console.log("done");
  }

  const orderedRecords = orderedDocuments
    .map((document) => finalRecords.get(document.id))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));

  const body = orderedRecords.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(INDEX_FILE, body ? `${body}\n` : "", "utf8");

  const byTool = {};
  for (const record of orderedRecords) {
    byTool[record.tool] = (byTool[record.tool] || 0) + 1;
  }

  console.log(`Rebuilt embeddings index: ${INDEX_FILE}`);
  console.log(`Final vectors: ${orderedRecords.length}`);
  for (const [tool, count] of Object.entries(byTool).sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`  ${tool}: ${count}`);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
