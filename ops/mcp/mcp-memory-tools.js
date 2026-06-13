
/**
 * Shared memory MCP helpers backed by the local .ai-memory store.
 *
 * Callable as:
 *   Node.js module: const { memory_boot, memory_search, memory_query, memory_write } = require("./ops/mcp-memory-tools")
 *   CLI:            node ops/mcp-memory-tools.js <boot|search|query|write> [args]
 *
 * CLI output is always JSON.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadHelper(relativeParts) {
  const candidates = [
    path.join(__dirname, "..", "..", ...relativeParts),
    path.join(__dirname, "..", ...relativeParts),
    path.join(__dirname, ...relativeParts),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }
  return null;
}

function loadStoreRootHelper() {
  return loadHelper(["bus", "store-root.js"]);
}

function loadBm25Helper() {
  return loadHelper(["bus", "bm25.js"]);
}

// Cache helpers at call-time, not module-load-time, so test env vars can override.
// eslint-disable-next-line consistent-return
async function resolveStoreHelpers() {
  const helper = await loadStoreRootHelper();
  if (helper) {
    return helper;
  }
  return {
    resolveStoreRoot() {
      return (
        process.env.AI_MEMORY_STORE ||
        process.env.AI_MEMORY_STORE_ROOT ||
        process.env.AI_MEMORY_ROOT ||
        path.join(os.homedir(), ".ai-memory")
      );
    },
  };
}

let _storeRootResolver = null;
async function getStoreRootResolver() {
  if (!_storeRootResolver) _storeRootResolver = await resolveStoreHelpers();
  return _storeRootResolver;
}

// Resolve store root lazily so tests can override process.env before the first call.
async function resolveStoreRoot() {
  const helpers = await getStoreRootResolver();
  return helpers.resolveStoreRoot();
}

function getProjectsRoot(storeRoot) {
  return path.join(storeRoot, "projects");
}

function getContextPath(storeRoot) {
  return path.join(storeRoot, "CONTEXT.md");
}

let _bm25Helper = null;
async function getBm25Search() {
  if (!_bm25Helper) _bm25Helper = await loadBm25Helper();
  return _bm25Helper ? _bm25Helper.search : () => [];
}

const VALID_SCOPES = new Set(["user", "project", "feedback", "reference"]);
const VALID_TYPES = new Set(["bugfix", "feature", "refactor", "discovery", "docs", "chore", "note"]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function detectProjectKey({ project = "", cwd = "" } = {}) {
  if (typeof project === "string" && project.trim()) {
    return project.trim();
  }
  if (typeof cwd === "string" && cwd.trim()) {
    const normalized = cwd.replace(/[\\/]+$/, "");
    const leaf = path.basename(normalized);
    if (leaf) {
      return leaf;
    }
  }
  return "default";
}

function readJsonl(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readProjectFacts(projectKey, { limit = 20, storeRoot } = {}) {
  const jsonlPath = path.join(getProjectsRoot(storeRoot), `${projectKey}.jsonl`);
  return readJsonl(jsonlPath).filter((record) => !record.extraction_failed).reverse().slice(0, limit);
}

function buildBootContext(globalMd, facts, projectKey) {
  const lines = ["# Memory Context", "", "## Global", globalMd || "(no global.md yet)"];

  lines.push("");
  lines.push(`## Project: ${projectKey}`);
  if (facts.length === 0) {
    lines.push("(no project facts yet)");
    return lines.join("\n");
  }

  for (const fact of facts) {
    const date = String(fact.t || "").slice(0, 10) || "?";
    const content = fact.content || (Array.isArray(fact.facts) ? fact.facts[0] : "") || "(empty)";
    lines.push(`- [${date}] ${content}`);
    for (const decision of Array.isArray(fact.decisions) ? fact.decisions : []) {
      lines.push(`  -> ${decision}`);
    }
  }

  return lines.join("\n");
}

function collectSearchDocuments(projectKey, storeRoot) {
  const projectsRoot = getProjectsRoot(storeRoot);
  const targets = projectKey
    ? [path.join(projectsRoot, `${projectKey}.jsonl`)]
    : fs.existsSync(projectsRoot)
      ? fs
          .readdirSync(projectsRoot)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => path.join(projectsRoot, name))
      : [];

  const docs = [];
  for (const jsonlPath of targets) {
    const project = path.basename(jsonlPath, ".jsonl");
    for (const record of readJsonl(jsonlPath)) {
      if (!record || !record.id || record.extraction_failed) {
        continue;
      }
      const text = [record.content, ...(record.facts || []), ...(record.decisions || [])]
        .filter(Boolean)
        .join(" ");
      docs.push({
        id: record.id,
        text,
        _raw: { ...record, project: record.project || project },
      });
    }
  }
  return docs;
}

function validateFact(fact) {
  if (!fact || typeof fact !== "object") return "fact must be an object";
  if (!fact.content || typeof fact.content !== "string") return "fact.content (string) is required";
  if (fact.content.length > 2000) return "fact.content must be under 2000 characters";
  if (fact.scope && !VALID_SCOPES.has(fact.scope)) return `fact.scope must be one of ${Array.from(VALID_SCOPES).join(", ")}`;
  if (fact.session_type && !VALID_TYPES.has(fact.session_type)) return `fact.session_type must be one of ${Array.from(VALID_TYPES).join(", ")}`;
  if (fact.confidence != null && (typeof fact.confidence !== "number" || fact.confidence < 0 || fact.confidence > 1)) {
    return "fact.confidence must be between 0 and 1";
  }
  // Per-array-element length caps prevent unbounded write amplification from
  // a single mcp_write call.
  for (const field of ["facts", "decisions", "entities"]) {
    const arr = fact[field];
    if (arr !== undefined) {
      if (!Array.isArray(arr)) return `fact.${field} must be an array`;
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (typeof item === "string") {
          if (item.length > 2000) return `fact.${field}[${i}] must be under 2000 characters`;
        } else if (item && typeof item === "object") {
          const serialized = JSON.stringify(item);
          if (serialized && serialized.length > 2000) {
            return `fact.${field}[${i}] serialized form must be under 2000 characters`;
          }
        }
      }
    }
  }
  return null;
}

async function memory_boot({ agent_id: _agentId, project = "", cwd = "", top_k = 20 } = {}) {
  const storeRoot = await resolveStoreRoot();
  const projectKey = detectProjectKey({ project, cwd });
  const globalPath = path.join(storeRoot, "global.md");
  const globalMd = fs.existsSync(globalPath) ? fs.readFileSync(globalPath, "utf8").trim() : "";
  const facts = readProjectFacts(projectKey, { limit: Number(top_k) || 20, storeRoot });

  return {
    source: "memory_boot",
    store_root: storeRoot,
    default_store_root: path.join(os.homedir(), ".ai-memory"),
    project: projectKey,
    context_md: getContextPath(storeRoot),
    global_exists: fs.existsSync(globalPath),
    context_md_exists: fs.existsSync(getContextPath(storeRoot)),
    fact_count: facts.length,
    facts,
    context: buildBootContext(globalMd, facts, projectKey),
  };
}

async function memory_search({ query = "", project = "", cwd = "", top_k = 10 } = {}) {
  if (!query || !String(query).trim()) {
    return { query: "", project: detectProjectKey({ project, cwd }), results: [], total_docs: 0, error: "query is required" };
  }

  const storeRoot = await resolveStoreRoot();
  const projectKey = project || cwd ? detectProjectKey({ project, cwd }) : "";
  const docs = collectSearchDocuments(projectKey, storeRoot);
  if (docs.length === 0) {
    return { query, project: projectKey || null, results: [], total_docs: 0 };
  }

  const bm25Fn = await getBm25Search();
  const hits = bm25Fn(docs, String(query), { topK: Number(top_k) || 10 });
  const results = hits.map((hit) => {
    const record = hit._raw || docs.find((doc) => doc.id === hit.id)?._raw || {};
    return {
      id: hit.id,
      score: Math.round(Number(hit.score || 0) * 1000) / 1000,
      project: record.project || null,
      date: String(record.t || "").slice(0, 10) || null,
      content: record.content || "",
      facts: Array.isArray(record.facts) ? record.facts : [],
      decisions: Array.isArray(record.decisions) ? record.decisions : [],
      session_type: record.session_type || "note",
    };
  });

  return {
    query,
    project: projectKey || null,
    total_docs: docs.length,
    results,
  };
}

async function memory_query({ query = "", depth = "compact", project = "", cwd = "", top_k = 10 } = {}) {
  const searchResult = await memory_search({ query, project, cwd, top_k });
  if (searchResult.error) {
    return {
      query,
      depth,
      project_key: detectProjectKey({ project, cwd }),
      results: [],
      error: searchResult.error,
    };
  }

  const compact = String(depth || "compact") !== "full";
  return {
    query,
    depth: compact ? "compact" : "full",
    project_key: detectProjectKey({ project, cwd }),
    results: searchResult.results.map((result) => {
      if (!compact) {
        return {
          ...result,
          content_hash: sha256(result.content),
        };
      }
      const summary = result.content.length > 200 ? `${result.content.slice(0, 200)}...` : result.content;
      return {
        id: result.id,
        timestamp: result.date,
        project: result.project,
        title: result.content.slice(0, 120).trim(),
        summary,
      };
    }),
  };
}

async function memory_write({ project = "", cwd = "", facts = [] } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return { ok: false, error: "facts[] is required" };
  }
  // Hard cap on batch size — prevents amplification attacks where a single
  // mcp_write call appends gigabytes to the JSONL file.
  if (facts.length > 1000) {
    return { ok: false, error: `facts[] batch size ${facts.length} exceeds cap of 1000` };
  }

  for (const fact of facts) {
    const error = validateFact(fact);
    if (error) {
      return { ok: false, error };
    }
  }

  const storeRoot = await resolveStoreRoot();
  const projectKey = detectProjectKey({ project, cwd });
  const projectsRoot = getProjectsRoot(storeRoot);
  const jsonlPath = path.join(projectsRoot, `${projectKey}.jsonl`);

  const atomicMod = await loadHelper(["ops", "inbox", "inbox-atomic-write.js"]);
  if (!atomicMod || typeof atomicMod.appendLineAtomic !== "function") {
    return { ok: false, error: "appendLineAtomic helper unavailable" };
  }

  const written = [];
  for (const fact of facts) {
    const record = {
      id: `rec_${crypto.randomUUID()}`,
      session_id: fact.session_id || `manual_${crypto.randomUUID()}`,
      project: projectKey,
      scope: fact.scope || "project",
      content: fact.content,
      confidence: fact.confidence ?? 0.9,
      facts: Array.isArray(fact.facts) ? fact.facts : [],
      decisions: Array.isArray(fact.decisions) ? fact.decisions : [],
      entities: Array.isArray(fact.entities) ? fact.entities : [],
      session_type: fact.session_type || "note",
      extraction_failed: false,
      write_mode: "manual",
      t: new Date().toISOString(),
    };
    atomicMod.appendLineAtomic(jsonlPath, record, { createDir: true, safeRoot: projectsRoot });
    written.push(record.id);
  }

  return {
    ok: true,
    project: projectKey,
    path: jsonlPath,
    written,
  };
}

export { memory_boot, memory_search, memory_query, memory_write };

// CLI entry point - only runs when executed directly
async function runCli() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  function parseArgs(argList) {
    const options = {};
    for (const arg of argList) {
      if (arg.includes("=")) {
        const [key, value] = arg.split("=", 2);
        options[key.trim()] = value.trim();
      } else {
        options._ = options._ || [];
        options._.push(arg);
      }
    }
    return options;
  }

  try {
    const parsed = parseArgs(args);
    let result;
    switch (cmd) {
      case "boot":
        result = memory_boot({
          project: parsed.project || parsed.p,
          cwd: parsed.cwd || parsed._?.[0] || process.cwd(),
          top_k: parsed.top_k || parsed.topK,
        });
        break;
      case "search":
        result = memory_search({
          query: parsed.query || parsed.q || parsed._?.[0] || "",
          project: parsed.project || parsed.p,
          cwd: parsed.cwd || "",
          top_k: parsed.top_k || parsed.topK,
        });
        break;
      case "query":
        result = memory_query({
          query: parsed.query || parsed.q || parsed._?.[0] || "",
          project: parsed.project || parsed.p,
          cwd: parsed.cwd || "",
          depth: parsed.depth || parsed.d || "compact",
          top_k: parsed.top_k || parsed.topK,
        });
        break;
      case "write":
        result = memory_write({
          project: parsed.project || parsed.p,
          cwd: parsed.cwd || "",
          facts: parsed.facts ? JSON.parse(parsed.facts) : [],
        });
        break;
      default:
        throw new Error(`Unknown command: ${cmd || "(none)"}. Use: boot | search | query | write`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}

