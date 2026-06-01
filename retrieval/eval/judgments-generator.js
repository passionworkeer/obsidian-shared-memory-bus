#!/usr/bin/env node
/**
 * judgments-generator.js — Semi-automated judgment generation.
 *
 * Runs the current semantic-search system for each judgment query,
 * fetches top-10 results, and formats them for human review.
 *
 * Usage:
 *   node judgments-generator.js --input retrieval/eval/judgments.jsonl --output retrieval/eval/judgments-annotated.jsonl
 *   node judgments-generator.js -i retrieval/eval/judgments.jsonl -o retrieval/eval/judgments-annotated.jsonl
 *
 * Output format: JSONL with {query, route, relevant_ids, relevance_scores, annotated_by, date, notes, system_results}
 *   where system_results = top-10 results from current system (with search_score as relevance proxy)
 *
 * Skips entries that already have non-empty relevant_ids (human annotations).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePythonRuntime, withPythonArgs } from "../../bus/python-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = resolvePythonRuntime();

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt  = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] || def : def;
};

const INPUT_PATH  = opt("--input",  opt("-i", null));
const OUTPUT_PATH = opt("--output", opt("-o", null));
const VERBOSE     = opt("--verbose", opt("-v", false)) || opt("--dry-run", false);

if (!INPUT_PATH) {
  console.error("Usage: node judgments-generator.js --input <path> --output <path>");
  process.exit(1);
}

// Resolve paths relative to project root
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const inputAbs  = path.isAbsolute(INPUT_PATH)  ? INPUT_PATH  : path.join(PROJECT_ROOT, INPUT_PATH);
const outputAbs = path.isAbsolute(OUTPUT_PATH) ? OUTPUT_PATH : path.join(PROJECT_ROOT, OUTPUT_PATH || "retrieval/eval/judgments-annotated.jsonl");

// ── Logging ───────────────────────────────────────────────────────────────────

const log = (...msg) => VERBOSE && console.log("[judgments-generator]", ...msg);

// ── JSONL helpers ─────────────────────────────────────────────────────────────

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (e) { log(`Skipping malformed line: ${e.message}`); return null; }
    })
    .filter(Boolean);
}

function writeJsonl(filePath, records) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return records.length;
}

// ── Semantic search runner ───────────────────────────────────────────────────

/**
 * Run semantic_search via Python subprocess for a single query.
 * Returns {results: [{id, record_id, score, title, scope, ...}]} or throws.
 */
function runSemanticSearch(query, route, topK = 10) {
  return new Promise((resolve, reject) => {
    const workspaceRoot = process.env.AI_MEMORY_OBSIDIAN_VAULT || process.env.OBSIDIAN_VAULT_ROOT || "";

    const scriptPath = path.join(PROJECT_ROOT, "retrieval", "semantic_search.py");

    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`semantic_search.py not found at ${scriptPath}`));
      return;
    }
    if (!PYTHON.available) {
      reject(new Error(`Python runtime unavailable: ${PYTHON.error || "unknown-error"}`));
      return;
    }

    const searchArgs = [
      scriptPath,
      "--mode", "hybrid",
      "--route", route || "auto",
      "--top-k", String(topK),
      "--json",
    ];
    if (workspaceRoot) {
      searchArgs.push("--workspace", workspaceRoot);
    }
    searchArgs.push(query);

    const child = spawn(PYTHON.command, withPythonArgs(PYTHON, searchArgs), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });

    const TIMEOUT_MS = 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms for query: ${query.slice(0, 40)}`));
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log(`semantic_search.py exited ${code}: ${stderr.slice(0, 200)}`);
        reject(new Error(`semantic_search.py exited ${code}`));
        return;
      }

      try {
        // The script writes JSON to stdout
        const trimmed = stdout.trim();
        const lines   = trimmed.split("\n");
        // Find the JSON object line (last JSON line)
        let result = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (l.startsWith("{")) {
            result = JSON.parse(l);
            break;
          }
        }
        if (!result) {
          // Try parsing the whole stdout as JSON
          result = JSON.parse(trimmed);
        }
        resolve(result);
      } catch (e) {
        log(`Failed to parse search result: ${e.message}`);
        log(`stdout: ${stdout.slice(0, 300)}`);
        reject(e);
      }
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdin.end();
  });
}

/**
 * Extract a flat summary of top results suitable for human annotation.
 * Returns {result_ids: string[], result_summaries: object[]}
 */
function summarizeResults(resp) {
  const results = resp.results || [];
  return {
    result_ids: results.map((r) => String(r.id || r.record_id || "")),
    result_summaries: results.slice(0, 10).map((r) => ({
      id:           String(r.id || r.record_id || ""),
      title:        r.title || r.name || "",
      scope:        r.scope || "",
      source_kind:  r.source_kind || r.sourceKind || "",
      search_score: typeof r.score === "number" ? r.score : null,
    })),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[judgments-generator] Reading judgments from: ${inputAbs}`);
  const judgments = readJsonl(inputAbs);
  console.log(`[judgments-generator] Loaded ${judgments.length} judgment entries`);

  const ALL_ROUTES = ["auto", "mixed", "durable", "task", "recent", "reference"];

  const outputEntries = [];
  let skipped = 0;
  let processed = 0;
  let errors = 0;

  for (const judgment of judgments) {
    const query = judgment.query;
    if (!query) { log("Skipping entry with empty query"); skipped++; continue; }

    const route = judgment.route || "auto";

    // Skip already annotated entries (human has filled relevant_ids)
    if (Array.isArray(judgment.relevant_ids) && judgment.relevant_ids.length > 0) {
      log(`Skipping already-annotated query: ${query.slice(0, 40)}`);
      outputEntries.push({
        ...judgment,
        annotated_by: judgment.annotated_by || "human",
        annotated_at: new Date().toISOString(),
      });
      skipped++;
      continue;
    }

    // Run the system for this query
    process.stdout.write(`  Query ${processed + skipped + 1}/${judgments.length}: "${query.slice(0, 50)}" ... `);

    try {
      const resp = await runSemanticSearch(query, route, 10);
      const summary = summarizeResults(resp);

      outputEntries.push({
        ...judgment,
        annotated_by:    judgment.annotated_by || "seed",
        date:            judgment.date || new Date().toISOString().slice(0, 10),
        system_route:    route,
        system_results:  summary.result_summaries,
        relevance_scores: judgment.relevance_scores || {},
        // Use system search_score as initial relevance proxy (0.0–1.0, normalized)
        // Human annotators can override this
        _system_score_proxy: summary.result_summaries
          .filter((r) => r.search_score !== null)
          .map((r) => ({ id: r.id, proxy_score: r.search_score })),
      });

      process.stdout.write(`OK (${summary.result_ids.length} results)\n`);
      processed++;

      // Rate limit: small delay between queries to avoid overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message.slice(0, 60)}\n`);
      outputEntries.push({
        ...judgment,
        annotated_by:  judgment.annotated_by || "seed",
        date:          judgment.date || new Date().toISOString().slice(0, 10),
        _error:        e.message,
        system_results: [],
      });
      errors++;
      processed++;
    }
  }

  const written = writeJsonl(outputAbs, outputEntries);

  console.log(`\n[judgments-generator] Done.`);
  console.log(`  Processed: ${processed}  Skipped: ${skipped}  Errors: ${errors}`);
  console.log(`  Output: ${outputAbs} (${written} entries)`);

  if (errors > 0) {
    console.warn(`  WARNING: ${errors} queries failed — check output file for details`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[judgments-generator] Fatal error:", e.message);
  process.exit(1);
});
