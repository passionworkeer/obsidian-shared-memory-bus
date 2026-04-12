/**
 * ops/mcp-memory-tools.js
 * ======================
 * Memory MCP tools: memory_boot and memory_query.
 *
 * Callable as:
 *   Node.js module:  const { memory_boot, memory_query } = require('./ops/mcp-memory-tools')
 *   CLI:             node ops/mcp-memory-tools.js <cmd> [args]
 *
 * CLI output is always JSON.
 */

"use strict";

const fs   = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Store root resolution — no Obsidian dependency
// ---------------------------------------------------------------------------

function loadStoreRootHelper() {
  const candidates = [
    // bus/ sibling (project layout)
    path.join(__dirname, "..", "bus", "store-root.cjs"),
    // ops/bus/ (legacy nested layout)
    path.join(__dirname, "bus", "store-root.cjs"),
    // Script-local (installed flat layout: ~/.ai-memory/ops/)
    path.join(__dirname, "store-root.cjs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  return null;
}

function resolveVaultRoot() {
  const helper = loadStoreRootHelper();
  if (helper) {
    try {
      return helper.resolveStoreRoot();
    } catch {
      // fall through
    }
  }
  // Last resort: use DEFAULT_STORE_ROOT from store-root.cjs to avoid hardcoding
  const { DEFAULT_STORE_ROOT } = require("./store-root.cjs");
  return process.env.AI_MEMORY_STORE || DEFAULT_STORE_ROOT;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function sha256(value) {
  return require("node:crypto")
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// memory_boot
// ---------------------------------------------------------------------------

/**
 * Load L0 + L1 memory layers for a given project.
 *
 * @param {{ agent_id?: string, cwd: string }} opts
 * @param {string} opts.cwd       — required; project working directory
 * @param {string} [opts.agent_id] — optional; present for MCP compat, unused here
 * @returns {{
 *   l0: string,
 *   l1: string,
 *   l1Count: number,
 *   project_key: string,
 *   source: 'memory_boot'
 * }}
 */
function memory_boot({ agent_id: _agent_id, cwd } = {}) {
  let vaultRoot;
  let resolvedCwd = cwd || "";
  let project_key;

  try {
    vaultRoot = resolveVaultRoot();
  } catch {
    project_key = resolvedCwd ? path.basename(resolvedCwd) : "unknown";
    return {
      l0:         "(vault not found)",
      l1:         "(vault not found)",
      l1Count:    0,
      project_key,
      source:     "memory_boot",
    };
  }

  // project_key for KG query: use cwd basename, fallback to vault root dir name
  project_key = resolvedCwd
    ? path.basename(resolvedCwd)
    : path.basename(vaultRoot);

  // --- L0: read generated L0-bootstrap.md (contains real project context + L1 facts) ---
  // vaultRoot is now the store root (e.g. E:\.ai-memory\) — no 00-System/ai-memory prefix
  const GENERATED_ROOT = path.join(vaultRoot, "generated");
  const L0_BOOTSTRAP  = path.join(GENERATED_ROOT, "L0-bootstrap.md");
  const l0 = fs.existsSync(L0_BOOTSTRAP)
    ? fs.readFileSync(L0_BOOTSTRAP, "utf-8").trim()
    : "(no L0-bootstrap.md — run build-memory-layers.js first)";

  // --- L1: query KG for project-relevant triples (~500 tokens) ---
  let l1 = "（暂无 L1 事实）";
  let l1Count = 0;

  try {
    const { KnowledgeGraph } = require("./knowledge-graph.cjs");
    const kg = new KnowledgeGraph({ vaultRoot });
    const triples = kg.queryCurrentTriples({ entityName: project_key, limit: 20 });

    if (triples && triples.length > 0) {
      l1Count = triples.length;
      l1 = triples
        .slice(0, 20)
        .map((t) => {
          const s = t.subject     || "";
          const p = t.predicate   || "";
          const o = t.object      || "";
          return `- ${s} ${p} ${o}`.trim();
        })
        .join("\n");
    }
    kg.close();
  } catch (e) {
    l1 = `（KG 不可用: ${e.message}）`;
  }

  return { l0, l1, l1Count, project_key, source: "memory_boot" };
}

// ---------------------------------------------------------------------------
// memory_query
// ---------------------------------------------------------------------------

/**
 * Search inbox records by keyword.
 *
 * @param {{
 *   query: string,
 *   depth?: 'compact' | 'full',
 *   cwd?: string
 * }} opts
 * @returns {{
 *   results: object[],
 *   query: string,
 *   depth: string,
 *   project_key: string,
 *   error?: string
 * }}
 */
function memory_query({ query = "", depth = "compact", cwd = "" } = {}) {
  const project_key = cwd ? path.basename(cwd) : "";
  let vaultRoot;

  try {
    vaultRoot = resolveVaultRoot();
  } catch {
    return {
      results:    [],
      query,
      depth,
      project_key,
      error:       "vault not found",
    };
  }

  const INBOX_ROOT = path.join(vaultRoot, "00-System", "ai-memory", "inbox");
  if (!fs.existsSync(INBOX_ROOT)) {
    return { results: [], query, depth, project_key };
  }

  const linePattern = /^-\s+\[(?<timestamp>[^\]]+)\]\s+\[(?<project>[^\]]+)\]\s*(?<content>.+)$/;

  // Simple token-based keyword match
  const queryTokens = (query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  /** @param {string} text @returns {boolean} */
  const matches = (text) => {
    if (!queryTokens.length) return true;
    const lower = text.toLowerCase();
    return queryTokens.every((t) => lower.includes(t));
  };

  const results = [];

  for (const fileName of fs.readdirSync(INBOX_ROOT)) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = path.join(INBOX_ROOT, fileName);
    const tool = path.basename(fileName, ".md");

    for (const line of readText(filePath).split(/\r?\n/)) {
      const match = line.match(linePattern);
      if (!match || !match.groups) continue;

      const content = match.groups.content || "";
      if (!matches(content)) continue;

      // Project filter (same project_key logic as memory_boot)
      if (project_key) {
        const lineProject = (match.groups.project || "").trim().toLowerCase();
        if (lineProject && lineProject !== project_key.toLowerCase()) continue;
      }

      const timestamp = match.groups.timestamp || "";
      const title     = content.slice(0, 120).trim();

      if (depth === "full") {
        results.push({
          tool,
          timestamp,
          project:     match.groups.project,
          title,
          content,
          content_hash: sha256(content),
        });
      } else {
        // compact: title + summary (~50 tokens per result)
        const summary = content.length > 200 ? `${content.slice(0, 200)}…` : content;
        results.push({ tool, timestamp, project: match.groups.project, title, summary });
      }
    }
  }

  return { results, query, depth, project_key };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = { memory_boot, memory_query };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;

  /** Minimal argument parser: key=value or positional */
  function parseArgs(argList) {
    const opts = {};
    for (const arg of argList) {
      if (arg.includes("=")) {
        const [k, v] = arg.split("=", 2);
        opts[k.trim()] = v.trim();
      } else {
        opts._ = opts._ || [];
        opts._.push(arg);
      }
    }
    return opts;
  }

  try {
    let result;
    switch (cmd) {
      case "boot": {
        const a   = parseArgs(args);
        const cwd = a.cwd || a._[0] || process.cwd();
        result = memory_boot({ cwd });
        break;
      }
      case "query": {
        const a     = parseArgs(args);
        const q     = a.query  || a.q     || (a._[0] || "");
        const depth = a.depth  || a.d    || "compact";
        const cwd   = a.cwd    || a._[1]  || "";
        result = memory_query({ query: q, depth, cwd });
        break;
      }
      default: {
        console.error(JSON.stringify({
          ok:    false,
          error: `Unknown command: ${cmd || "(none)"}. Use: boot | query`,
        }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
