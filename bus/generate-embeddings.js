import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createEmbeddingProviderRegistry, getProviderHost, buildEmbeddingConfigHash, normalizeEmbeddingAdapter } from "./embedding-provider-registry.js";
import { resolvePythonRuntime, withPythonArgs } from "./python-runtime.js";
import { resolveEmbeddingRuntime } from "./runtime-config.js";
import { resolveStoreRoot } from "./store-root.js";
import { VECTOR_SCHEMA_VERSION, fnv1a32, buildHashFeatures, buildHashEmbedding } from "./lsh-hash.js";
import { createJsonlStream } from "../ops/util/jsonl-stream.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

const AI_MEMORY_ROOT =
  process.env.AI_MEMORY_STORE ||
  process.env.AI_MEMORY_STORE_ROOT ||
  process.env.AI_MEMORY_ROOT ||
  __dirname;
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

const STORE_ROOT = resolveStoreRoot();
const STRUCTURED_DIR = path.join(STORE_ROOT, "structured");
const EMBEDDINGS_DIR = path.join(STORE_ROOT, "embeddings");
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

/**
 * index.jsonl schema (v2 - field-level):
 * { id, record_id, field: "content"|"fact"|"concept", text, vector, configHash, featureSchemaVersion, contentHash }
 *
 * - id: unique entry id; for parent entry = record_id, for sub-entries = record_id__fact_N / record_id__concept_N
 * - record_id: the parent record id all sub-entries link back to (used for deduplication in retrieval)
 * - field: which field this embedding represents
 * - text: the raw text that was embedded
 * - vector: the embedding vector
 * - configHash: embedding backend+model configuration hash
 * - featureSchemaVersion: VECTOR_SCHEMA_VERSION (tracks the feature generation algorithm)
 * - contentHash: SHA-256 of the field text (used for incremental rebuild — field unchanged = vector reusable)
 *
 * Legacy v1 records (no record_id, no field, one entry per record) are handled transparently
 * in retrieval: missing record_id defaults to id, missing field defaults to "content".
 */

// =============================================================================
// NOTE: The FNV-1a32 hashing logic has been extracted to bus/lsh-hash.js.
// Both Python (retrieval/lsh_utils.py) and JS now share the same algorithm.
// See: retrieval/lsh_utils.py for the canonical implementation.
// =============================================================================

/**
 * Extract the three field texts from a structured JSONL record.
 *
 * Handles two formats for facts[] and concepts[]:
 *   - Object format:  { value: string[], Count: number }
 *   - String format:  plain string
 *
 * Returns { title, content, facts: string[], concepts: string[] }.
 * facts[] and concepts[] contain individual text items extracted from the value arrays.
 */
function extractFieldTexts(entry) {
  const title = normalizeSpaces(entry.title || "");
  const content = normalizeSpaces(entry.content || "");

  const rawFacts = Array.isArray(entry.facts) ? entry.facts : [];
  const facts = [];
  for (const item of rawFacts) {
    if (typeof item === "string") {
      const t = normalizeSpaces(item);
      if (t) facts.push(t);
    } else if (item && Array.isArray(item.value)) {
      for (const v of item.value) {
        const t = normalizeSpaces(String(v || ""));
        if (t) facts.push(t);
      }
    }
  }

  const rawConcepts = Array.isArray(entry.concepts) ? entry.concepts : [];
  const concepts = [];
  for (const item of rawConcepts) {
    if (typeof item === "string") {
      const t = normalizeSpaces(item);
      if (t) concepts.push(t);
    } else if (item && Array.isArray(item.value)) {
      for (const v of item.value) {
        const t = normalizeSpaces(String(v || ""));
        if (t) concepts.push(t);
      }
    }
  }

  return { title, content, facts, concepts };
}

/**
 * Build the parent (field='content') search text from a structured record.
 * Mirrors the text construction logic used in semantic-search.py build_entry().
 */
function buildParentSearchText(entry) {
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

/**
 * Compute SHA-256 content hash for a field text.
 * Used to detect whether a field has changed (incremental rebuild).
 */
function hashFieldText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Returns true if all field texts in newFieldHashes match the corresponding
 * stored field texts in existingEntry (which must be a v2 record with fieldTexts).
 * Used for incremental reuse: only skip re-embedding when ALL field texts are unchanged.
 */
function fieldTextsUnchanged(newFieldHashes, existingEntry) {
  if (!existingEntry || !existingEntry.fieldTexts) {
    return false;
  }
  const stored = existingEntry.fieldTexts;
  for (const [fieldName, hash] of Object.entries(newFieldHashes)) {
    if (stored[fieldName] !== hash) {
      return false;
    }
  }
  return true;
}

const EMBEDDING_PROVIDER_REGISTRY = createEmbeddingProviderRegistry({
  pythonRuntime: PYTHON,
  withPythonArgs,
  fetchImpl: globalThis.fetch,
  sleep,
  buildHashEmbedding,
  hashModel: HASH_MODEL,
});

// buildDocument is superseded by field-level extraction in collectDocuments.
function buildDocument(entry) {
  return null; // intentionally broken — do not use
}

/**
 * Collect structured records and extract their field-level texts.
 *
 * Returns a Map keyed by record_id (parent id).  Each value is a "record doc"
 * object with:
 *   { record_id, tool, type, project, agent, t, title, fieldTexts, fieldHashes }
 *
 * fieldTexts:  { "content": "...", "fact_0": "...", "concept_0": "...", ... }
 * fieldHashes: { "content": "<sha256>", "fact_0": "<sha256>", ... }
 *
 * Only non-empty, non-noise fields are included.
 * The title + raw content are kept for metadata (not embedded directly).
 */
function collectDocuments() {
  const documents = new Map();
  if (!fs.existsSync(STRUCTURED_DIR)) {
    return documents;
  }

  // ADR-002 v2: --tier-filter defaults to Tier 2+3+4 (Session + Project Durable + Shared Durable)
  // These tiers cover all legacy memory_level values found in existing structured records.
  const tierFilterArg = (() => {
    const idx = process.argv.indexOf("--tier-filter");
    return idx >= 0 ? (process.argv[idx + 1] || "session+project+durable") : "session+project+durable";
  })();
  const allowedTiers = new Set(
    tierFilterArg === "all"
      ? [1, 2, 3, 4, 5]
      : tierFilterArg.split("+").map((t) => ({ session: 2, ephemeral: 1, project: 3, durable: 4, "2": 2, "3": 3, "4": 4 })[t.trim()] ?? 3)
  );

  for (const fileName of fs.readdirSync(STRUCTURED_DIR).sort()) {
    if (!fileName.endsWith(".jsonl")) {
      continue;
    }
    console.error("[DEBUG] Reading file:", fileName);
    const filePath = path.join(STRUCTURED_DIR, fileName);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);

        // ADR-002 v2: Skip archived records (Q3 fix — no tombstone, use archived flag)
        const isArchived = entry.lifecycle?.archived === true;
        if (isArchived) {
          // Write archived=true marker so retrieval layer can skip these vectors
          documents.set(String(entry.id || "").trim() || fallbackId(entry, "", ""), {
            recordId: String(entry.id || "").trim() || fallbackId(entry, "", ""),
            tool: normalizeSpaces(entry.tool || "unknown") || "unknown",
            type: normalizeSpaces(entry.type || ""),
            archived: true,
            t: normalizeSpaces(entry.t || ""),
          });
          continue;
        }

        // ADR-002 v2: Tier filter — resolve record tier from lifecycle.tier (preferred)
        // or from memory_level/scope/tier_from fields (legacy schema).
        // Tier 1=Ephemeral, 2=Session, 3=Project Durable, 4=Shared Durable, 5=Archive
        const TIER_MAP = {
          session: 2, ephemeral: 1, project: 3, shared: 4, knowledge: 4, durable: 4, hot: 2, task: 2,
        };
        let recordTier = entry.lifecycle?.tier != null ? Number(entry.lifecycle.tier) : NaN;
        if (!Number.isFinite(recordTier)) {
          // Check tier_from (archive-manifest schema)
          const tierFrom = entry.tier_from;
          if (tierFrom != null) {
            recordTier = Number(tierFrom);
          }
        }
        if (!Number.isFinite(recordTier)) {
          recordTier = TIER_MAP[String(entry.memory_level || "").toLowerCase()]
            || TIER_MAP[String(entry.scope || "").toLowerCase()]
            || 2;
        }
        if (!allowedTiers.has(recordTier)) {
          if (documents.size < 3) console.error("[DEBUG] filtered by tier:", recordTier, "allowed:", [...allowedTiers]);
          continue;
        }
        const { title, content, facts, concepts } = extractFieldTexts(entry);
        const rawText = [title, content].filter(Boolean).join(" ");
        if (documents.size < 3) {
          console.error("[DEBUG] first record - memory_level:", entry.memory_level, "scope:", entry.scope, "tier:", recordTier, "rawText len:", rawText.length, "title:", String(title).slice(0,30));
        }

        if (isNoise(rawText)) {
          if (documents.size < 3) console.error("[DEBUG] filtered by isNoise:", String(rawText).slice(0,50));
          continue;
        }

        const recordId = String(entry.id || "").trim() || fallbackId(entry, title, content);

        // Build parent content search text (mirrors semantic-search.py build_entry)
        const parentText = buildParentSearchText(entry);

        const fieldTexts = {};
        const fieldHashes = {};

        // Parent content field
        if (parentText) {
          fieldTexts.content = parentText;
          fieldHashes.content = hashFieldText(parentText);
        }

        // Fact sub-fields: each item in the facts array becomes a separate fact_N field
        for (let i = 0; i < facts.length; i++) {
          const factText = facts[i];
          if (factText && !isNoise(factText)) {
            const key = `fact_${i}`;
            fieldTexts[key] = factText;
            fieldHashes[key] = hashFieldText(factText);
          }
        }

        // Concept sub-fields: each item in the concepts array becomes a separate concept_N field
        for (let i = 0; i < concepts.length; i++) {
          const conceptText = concepts[i];
          if (conceptText && !isNoise(conceptText)) {
            const key = `concept_${i}`;
            fieldTexts[key] = conceptText;
            fieldHashes[key] = hashFieldText(conceptText);
          }
        }

        if (Object.keys(fieldTexts).length === 0) {
          continue;
        }

        documents.set(recordId, {
          recordId,
          tool: normalizeSpaces(entry.tool || "unknown") || "unknown",
          type: normalizeSpaces(entry.type || ""),
          project: normalizeSpaces(entry.project || ""),
          agent: normalizeSpaces(entry.agent || ""),
          t: normalizeSpaces(entry.t || ""),
          title: title || rawText.slice(0, 120) || recordId,
          excerpt: (content || rawText || "").slice(0, 240),
          fieldTexts,
          fieldHashes,
          // ADR-002 v2: tier + lifecycle metadata
          tier: recordTier,
          archived: false,
        });
      } catch (err) {
        // Ignore malformed records during rebuild.
        console.error(`[generate-embeddings] JSON parse error (skipping line): ${err.message}`);
      }
    }
  }

  return documents;
}

/**
 * Load the existing index.jsonl (v1 or v2 format).
 *
 * Returns a Map keyed by entry_id (sub-entry id).  Each value is the parsed
 * index record with an added `fieldTexts` dict derived from its `contentHash`
 * map for the reuse check.
 *
 * v2 records (with record_id/field) are preferred; legacy v1 records
 * (one entry per record_id, no record_id/field) are also loaded and treated
 * as having field="content".
 */
/**
 * Load the existing index.jsonl (v1 or v2 format) using streaming.
 * Never loads the entire file into memory — iterates one record at a time.
 *
 * Returns a Map keyed by entry_id (sub-entry id).  Each value is the parsed
 * index record with an added `fieldTexts` dict derived from its `contentHash`
 * map for the reuse check.
 *
 * v2 records (with record_id/field) are preferred; legacy v1 records
 * (one entry per record_id, no record_id/field) are also loaded and treated
 * as having field="content".
 */
async function loadExistingIndex() {
  const existing = new Map();
  if (!fs.existsSync(INDEX_FILE)) {
    return existing;
  }

  for await (const record of createJsonlStream(INDEX_FILE)) {
    if (!record || !record.id) {
      continue;
    }
    try {
      const entryId = String(record.id).trim();

      // Reconstruct fieldTexts from the stored record:
      // v2: record has { record_id, field, text, contentHash: { fieldName -> hash } }
      // v1 (legacy): no record_id/field — treat as { field: "content", text: record.text || record.search_text }
      if (record.record_id !== undefined && record.field !== undefined) {
        // v2 format — contentHash is { fieldName -> hash }
        const fieldTexts = {};
        if (record.contentHash && typeof record.contentHash === "object" && !Array.isArray(record.contentHash)) {
          for (const [fname, h] of Object.entries(record.contentHash)) {
            fieldTexts[fname] = String(h || "");
          }
        } else if (typeof record.contentHash === "string") {
          // Legacy single-hash string: treat as content field
          fieldTexts.content = String(record.contentHash);
        }
        existing.set(entryId, { ...record, fieldTexts });
      } else {
        // v1 legacy format — one entry per record_id with a single contentHash
        const recordId = entryId;
        const fieldTexts = {};
        if (record.contentHash && typeof record.contentHash === "string") {
          fieldTexts.content = String(record.contentHash);
        }
        existing.set(entryId, { ...record, fieldTexts, record_id: recordId, field: "content" });
      }
    } catch (err) {
      // Ignore malformed lines and continue rebuilding.
      console.error(`[generate-embeddings] JSON parse error in index load (skipping line): ${err.message}`);
    }
  }

  return existing;
}

/**
 * Write all field-level records to index.jsonl (v2 format).
 *
 * orderedRecords: flat list of entry records, each with
 *   { id, record_id, field, text, embedding, dim, backend, model, configHash,
 *     providerHost, indexedAt, featureSchemaVersion, contentHash, tool }
 *
 * Each call overwrites the file atomically (partial write on crash is acceptable
 * for a personal-memory scale index).
 */
function writeIndexSnapshot(orderedRecords) {
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
  const existing = await loadExistingIndex();
  const preferredBackend = normalizeEmbeddingAdapter(EMBED_ADAPTER, MODEL) || "hash";
  const preferredModelName = preferredBackend === "hash" ? HASH_MODEL : MODEL;
  const preferredConfigHash = buildEmbeddingConfigHash({
    backend: preferredBackend,
    modelName: preferredModelName,
    baseUrl: EMBED_RUNTIME.baseUrl || "",
  });

  // Build the flat list of (recordId, fieldName) pairs to embed
  const orderedRecordIds = Array.from(documents.values()).sort((l, r) => l.recordId.localeCompare(r.recordId));
  const finalRecords = new Map();   // entryId -> v2 output record
  const pending = [];               // [{ recordId, fieldName, text, recordDoc }]

  // Group: existing entries by record_id for fast lookup
  const existingByRecord = new Map();
  for (const [entryId, rec] of existing.entries()) {
    const rid = String(rec.record_id || entryId);
    if (!existingByRecord.has(rid)) {
      existingByRecord.set(rid, new Map());
    }
    existingByRecord.get(rid).set(String(rec.field || "content"), rec);
  }

  for (const doc of orderedRecordIds) {
    const storedByField = existingByRecord.get(doc.recordId) || new Map();
    let allFieldsReusable = true;

    for (const [fieldName, fieldText] of Object.entries(doc.fieldTexts)) {
      const entryId = fieldName === "content" ? doc.recordId : `${doc.recordId}__${fieldName}`;
      const stored = storedByField.get(fieldName);

      const isFieldReusable =
        !force &&
        stored &&
        normalizeEmbeddingAdapter(stored.backend, stored.model) === preferredBackend &&
        stored.model === preferredModelName &&
        stored.configHash === preferredConfigHash &&
        stored.fieldTexts &&
        stored.fieldTexts[fieldName] === doc.fieldHashes[fieldName] &&
        Array.isArray(stored.embedding) &&
        stored.embedding.length > 0;

      if (isFieldReusable) {
        finalRecords.set(entryId, {
          ...stored,
          record_id: doc.recordId,
          field: fieldName,
          text: fieldText,
          backend: normalizeEmbeddingAdapter(stored.backend, stored.model),
          featureSchemaVersion: VECTOR_SCHEMA_VERSION,
        });
      } else {
        allFieldsReusable = false;
        pending.push({ entryId, recordId: doc.recordId, fieldName, text: fieldText, doc });
      }
    }
  }

  console.log(`Structured records: ${orderedRecordIds.length}`);
  console.log(`Existing entry slots: ${existing.size}`);
  console.log(`Pending embeddings: ${pending.length}`);
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

  if (orderedRecordIds.length === 0) {
    fs.writeFileSync(INDEX_FILE, "", "utf8");
    console.log("No structured documents found. Wrote empty embeddings index.");
    return;
  }

  const batchSize = resolveBatchSize();
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const batchCount = Math.ceil(pending.length / batchSize);
    process.stdout.write(`Embedding batch ${batchNumber}/${batchCount} (${batch.length} fields)... `);
    const batchRuntime = {
      ...EMBED_RUNTIME,
      model: preferredModelName,
      adapter: preferredBackend,
      backend: preferredBackend,
    };
    const { vectors, modelName, backendName, providerHost = "" } = await embedBatch(
      batch.map((item) => item.text.slice(0, 3000)),
      batchRuntime
    );
    const configHash = buildEmbeddingConfigHash({
      backend: backendName,
      modelName,
      baseUrl: batchRuntime.baseUrl || "",
    });

    for (let index = 0; index < batch.length; index += 1) {
      const { entryId, recordId, fieldName, text, doc } = batch[index];
      // contentHash: { fieldName -> sha256(fieldText) } for ALL fields in this record.
      // Stored on every sub-entry so each line can independently validate field changes.
      const contentHash = { ...doc.fieldHashes };

      finalRecords.set(entryId, {
        id: entryId,
        record_id: recordId,
        field: fieldName,
        text,
        contentHash,
        embedding: vectors[index],
        dim: Array.isArray(vectors[index]) ? vectors[index].length : 0,
        backend: backendName,
        model: modelName,
        configHash,
        providerHost,
        indexedAt: new Date().toISOString(),
        featureSchemaVersion: VECTOR_SCHEMA_VERSION,
        tool: doc.tool,
        type: doc.type,
        project: doc.project,
        agent: doc.agent,
        t: doc.t,
        title: doc.title,
        excerpt: doc.excerpt,
      });
    }

    const orderedRecords = Array.from(finalRecords.values()).sort((l, r) => l.id.localeCompare(r.id));
    writeIndexSnapshot(orderedRecords);
    console.log("done");
  }

  const orderedRecords = Array.from(finalRecords.values()).sort((l, r) => l.id.localeCompare(r.id));
  writeIndexSnapshot(orderedRecords);

  const byTool = {};
  for (const record of orderedRecords) {
    byTool[record.tool] = (byTool[record.tool] || 0) + 1;
  }

  console.log(`Rebuilt embeddings index: ${INDEX_FILE}`);
  console.log(`Final entries: ${orderedRecords.length}`);
  for (const [tool, count] of Object.entries(byTool).sort((l, r) => l[0].localeCompare(r[0]))) {
    console.log(`  ${tool}: ${count}`);
  }
}

export {
  normalizeSpaces,
  buildEmbeddingConfigHash,
  isNoise,
  fallbackId,
  extractFieldTexts,
  buildParentSearchText,
  hashFieldText,
  fieldTextsUnchanged,
  buildDocument,
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}
