// generate-embeddings.js
// Incrementally rebuilds the shared dense index from structured/*.jsonl.

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createEmbeddingProviderRegistry, getProviderHost, normalizeEmbeddingAdapter } = require("./embedding-provider-registry.js");
const { resolvePythonRuntime, withPythonArgs } = require("./python-runtime.js");
const { resolveEmbeddingRuntime } = require("./runtime-config.js");
const { resolveVaultRoot } = require("./vault-root.js");
const { VECTOR_SCHEMA_VERSION, fnv1a32, buildHashFeatures, buildHashEmbedding } = require("./lsh-hash.js");
const WINDOWS_ENV_CACHE = new Map();

hydrateProcessEnvFromWindows([
  "AI_MEMORY_RUNTIME_CONFIG_PATH",
  "AI_MEMORY_EMBED_ADAPTER",
  "AI_MEMORY_EMBED_BACKEND",
  "AI_MEMORY_EMBED_BASE_URL",
  "AI_MEMORY_EMBED_API_KEY",
  "AI_MEMORY_EMBED_API_KEY_ENV",
  "AI_MEMORY_EMBED_MODEL",
  "AI_MEMORY_EMBED_PROFILE",
  "AI_MEMORY_EMBED_PROVIDER",
  "AI_MEMORY_EMBED_TIMEOUT_MS",
  "AI_MEMORY_EMBED_TIMEOUT_SECONDS",
  "AI_MEMORY_EMBED_REQUEST_DELAY_MS",
  "AI_MEMORY_EMBED_DELAY_MS",
  "AI_MEMORY_EMBED_BATCH_SIZE",
  "AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK",
  "AI_MEMORY_OBSIDIAN_VAULT",
  "OBSIDIAN_VAULT_ROOT",
  "AI_MEMORY_PYTHON",
  "UV_COMMAND",
]);

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || __dirname;
const PYTHON = resolvePythonRuntime();
const EMBED_RUNTIME = resolveEmbeddingRuntime({
  rootPath: AI_MEMORY_ROOT,
  getEnvValue: firstNonEmptyEnv,
  defaults: {
    adapter: "hash",
    model: "all-MiniLM-L6-v2",
    timeoutMs: resolveTimeoutMs(),
    requestDelayMs: 0,
    batchSize: 0,
    allowBatchFallback: false,
  },
});
const MODEL = EMBED_RUNTIME.model || "all-MiniLM-L6-v2";
const EMBED_ADAPTER = normalizeEmbeddingAdapter(EMBED_RUNTIME.adapter || EMBED_RUNTIME.backend || "hash", "hash");
const EXPLICIT_BATCH_SIZE = Math.max(0, Number(EMBED_RUNTIME.batchSize || 0) || 0);
const ALLOW_BATCH_FALLBACK = Boolean(EMBED_RUNTIME.allowBatchFallback);
const ACTIVE_EMBED_PROFILE = String(EMBED_RUNTIME.profileName || "").trim();
const ACTIVE_EMBED_PROVIDER = String(EMBED_RUNTIME.providerName || "").trim();
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

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const name of names) {
    const value = readWindowsEnvironmentVariable(name);
    if (value) {
      return value;
    }
  }
  return "";
}

function hydrateProcessEnvFromWindows(names) {
  if (process.platform !== "win32" || !Array.isArray(names)) {
    return;
  }

  for (const name of names) {
    const normalized = String(name || "").trim();
    if (!normalized || firstNonEmptyEnv(normalized)) {
      continue;
    }

    const value = readWindowsEnvironmentVariable(normalized);
    if (value) {
      process.env[normalized] = value;
    }
  }
}

function readWindowsEnvironmentVariable(name) {
  if (process.platform !== "win32") {
    return "";
  }
  if (WINDOWS_ENV_CACHE.has(name)) {
    return WINDOWS_ENV_CACHE.get(name);
  }

  const escapedName = String(name || "").replace(/'/g, "''");
  const command = [
    `$value = [Environment]::GetEnvironmentVariable('${escapedName}', 'User')`,
    "if ([string]::IsNullOrWhiteSpace($value)) {",
    `  $value = [Environment]::GetEnvironmentVariable('${escapedName}', 'Machine')`,
    "}",
    "if (-not [string]::IsNullOrWhiteSpace($value)) { [Console]::Out.Write($value) }",
  ].join("; ");

  let value = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      value = String(result.stdout || "").trim();
    }
  } catch (_error) {
    value = "";
  }

  WINDOWS_ENV_CACHE.set(name, value);
  return value;
}

function resolveTimeoutMs() {
  const timeoutMs = Number(firstNonEmptyEnv("AI_MEMORY_EMBED_TIMEOUT_MS") || "0") || 0;
  if (timeoutMs > 0) {
    return Math.max(1000, timeoutMs);
  }

  const timeoutSeconds = Number(firstNonEmptyEnv("AI_MEMORY_EMBED_TIMEOUT_SECONDS") || "120") || 120;
  return Math.max(1000, timeoutSeconds * 1000);
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

function buildEmbeddingConfigHash({ backend, modelName, baseUrl = "" }) {
  const normalizedBackend = normalizeEmbeddingAdapter(backend, modelName);
  const normalizedBaseUrl =
    normalizedBackend === "openai-compatible" ? String(baseUrl || "").trim().replace(/\/+$/, "") : "";
  const payload = JSON.stringify({
    backend: normalizedBackend,
    model: String(modelName || "").trim(),
    baseUrl: normalizedBaseUrl.toLowerCase(),
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
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

// =============================================================================
// NOTE: The FNV-1a32 hashing logic has been extracted to bus/lsh-hash.js.
// Both Python (retrieval/lsh_utils.py) and JS now share the same algorithm.
// See: retrieval/lsh_utils.py for the canonical implementation.
// =============================================================================

const EMBEDDING_PROVIDER_REGISTRY = createEmbeddingProviderRegistry({
  pythonRuntime: PYTHON,
  withPythonArgs,
  fetchImpl: globalThis.fetch,
  sleep,
  buildHashEmbedding,
  hashModel: HASH_MODEL,
});

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
      } catch (err) {
        // Ignore malformed records during rebuild.
        console.error(`[generate-embeddings] JSON parse error (skipping line): ${err.message}`);
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
    } catch (err) {
      // Ignore malformed lines and continue rebuilding.
      console.error(`[generate-embeddings] JSON parse error in index load (skipping line): ${err.message}`);
    }
  }

  return existing;
}

function writeIndexSnapshot(orderedDocuments, finalRecords) {
  const orderedRecords = orderedDocuments
    .map((document) => finalRecords.get(document.id))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));

  const body = orderedRecords.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(INDEX_FILE, body ? `${body}\n` : "", "utf8");
  return orderedRecords;
}

function resolveBatchSize() {
  if (EXPLICIT_BATCH_SIZE > 0) {
    return EXPLICIT_BATCH_SIZE;
  }

  const activeProvider = EMBEDDING_PROVIDER_REGISTRY.get(EMBED_ADAPTER);
  return activeProvider.defaultBatchSize({ runtime: EMBED_RUNTIME });
}

async function embedBatch(texts, runtime) {
  const activeProvider = EMBEDDING_PROVIDER_REGISTRY.get(runtime.adapter);

  try {
    return await activeProvider.embedBatch({ texts, runtime });
  } catch (error) {
    if (!ALLOW_BATCH_FALLBACK || activeProvider.name === "hash") {
      throw new Error(`${activeProvider.name}-embedding-failed:${error.message}`);
    }

    console.warn(`${activeProvider.name} embeddings unavailable, falling back to ${HASH_MODEL}: ${error.message}`);
    return EMBEDDING_PROVIDER_REGISTRY.get("hash").embedBatch({ texts, runtime });
  }
}

async function main() {
  const force = process.argv.includes("--force");
  ensureDirectory(EMBEDDINGS_DIR);

  const documents = collectDocuments();
  const existing = loadExistingIndex();
  const preferredBackend = normalizeEmbeddingAdapter(EMBED_ADAPTER, MODEL) || "hash";
  const preferredModelName = preferredBackend === "hash" ? HASH_MODEL : MODEL;
  const preferredConfigHash = buildEmbeddingConfigHash({
    backend: preferredBackend,
    modelName: preferredModelName,
    baseUrl: EMBED_RUNTIME.baseUrl || "",
  });
  const orderedDocuments = Array.from(documents.values()).sort((left, right) => left.id.localeCompare(right.id));
  const finalRecords = new Map();
  const pending = [];

  for (const document of orderedDocuments) {
    const current = existing.get(document.id);
    const isReusable =
      !force &&
      current &&
      current.contentHash === document.contentHash &&
      normalizeEmbeddingAdapter(current.backend, current.model) === preferredBackend &&
      current.model === preferredModelName &&
      current.configHash === preferredConfigHash &&
      Array.isArray(current.embedding) &&
      current.embedding.length > 0;

    if (isReusable) {
      finalRecords.set(document.id, {
        ...current,
        ...document,
        backend: normalizeEmbeddingAdapter(current.backend, current.model),
        featureSchemaVersion: VECTOR_SCHEMA_VERSION,
      });
      continue;
    }

    pending.push(document);
  }

  console.log(`Structured documents: ${orderedDocuments.length}`);
  console.log(`Existing vectors: ${existing.size}`);
  console.log(`Pending vectors: ${pending.length}`);
  console.log(`Target backend: ${preferredBackend}`);
  console.log(`Target model: ${preferredModelName}`);
  if (ACTIVE_EMBED_PROFILE) {
    console.log(`Target profile: ${ACTIVE_EMBED_PROFILE}`);
  }
  if (ACTIVE_EMBED_PROVIDER) {
    console.log(`Target provider: ${ACTIVE_EMBED_PROVIDER}`);
  }
  if (EMBED_RUNTIME.resolutionMode) {
    console.log(`Runtime resolution: ${EMBED_RUNTIME.resolutionMode}`);
  }
  if (EMBED_RUNTIME.configExists) {
    console.log(`Runtime config: ${EMBED_RUNTIME.configPath}`);
  }
  if (EMBED_RUNTIME.configError) {
    console.warn(`Runtime config warning: ${EMBED_RUNTIME.configError}`);
  }
  if (preferredBackend === "openai-compatible") {
    console.log(`Target provider host: ${getProviderHost(EMBED_RUNTIME.baseUrl || "") || "unknown"}`);
  }

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
    const batchRuntime = {
      ...EMBED_RUNTIME,
      model: preferredModelName,
      adapter: preferredBackend,
      backend: preferredBackend,
    };
    const { vectors, modelName, backendName, providerHost = "" } = await embedBatch(
      batch.map((document) => document.text.slice(0, 3000)),
      batchRuntime
    );
    const configHash = buildEmbeddingConfigHash({
      backend: backendName,
      modelName,
      baseUrl: batchRuntime.baseUrl || "",
    });
    for (let index = 0; index < batch.length; index += 1) {
      const document = batch[index];
      finalRecords.set(document.id, {
        ...document,
        embedding: vectors[index],
        dim: Array.isArray(vectors[index]) ? vectors[index].length : 0,
        backend: backendName,
        model: modelName,
        configHash,
        providerHost,
        indexedAt: new Date().toISOString(),
        featureSchemaVersion: VECTOR_SCHEMA_VERSION,
      });
    }
    writeIndexSnapshot(orderedDocuments, finalRecords);
    console.log("done");
  }

  const orderedRecords = writeIndexSnapshot(orderedDocuments, finalRecords);

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
