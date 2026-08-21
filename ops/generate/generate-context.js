#!/usr/bin/env node
/**
 * ops/generate-context.js
 * -----------------------
 * Generates CONTEXT.md under the resolved AI_MEMORY_STORE root.
 * Used by passive agents (Trae, OpenCode, Codex) that can't call MCP.
 *
 * Content: global.md + top-10 recent facts from each project
 * Target size: < 500 tokens
 *
 * Usage:
 *   node ops/generate-context.js
 *   node ops/generate-context.js --project obsidian-shared-memory-bus
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStoreRoot, getContextPath } from "../../bus/store-root.js";
import { createJsonlStream } from "../util/jsonl-stream.js";

function getProjectsRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "projects");
}

const TOP_PER_PROJECT = 10;
const MAX_CONTENT_CHARS = 200;  // truncate long fact content

function truncate(str, max = MAX_CONTENT_CHARS) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "…";
}

/**
 * Read up to `topK` most-recent facts from a project JSONL file without
 * loading the whole file into memory. F3.2 (perf audit): the previous
 * implementation called `readFileSync` + `.split("\n")` + JSON.parse on every
 * record, then sliced topK — O(file_size) memory even though we only keep 10.
 *
 * Streams the file line-by-line, pushing each valid record into a fixed-size
 * ring buffer. When the buffer is full, the oldest entry is shifted out so
 * peak memory stays O(topK).
 *
 * @param {string} jsonlPath
 * @param {number} topK
 * @returns {Promise<object[]>} Up to `topK` records, newest-first.
 */
async function loadRecentFacts(jsonlPath, topK) {
  const ring = [];
  try {
    for await (const record of createJsonlStream(jsonlPath)) {
      if (!record || record.extraction_failed) continue;
      ring.push(record);
      if (ring.length > topK) ring.shift();
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  // createJsonlStream yields in file order; reverse to give newest-first.
  return ring.reverse();
}

async function generateContext(opts = {}) {
  const storeRoot    = resolveStoreRoot();
  const projectsRoot = getProjectsRoot(storeRoot);
  const contextPath  = getContextPath(storeRoot);

  const sections = [];
  sections.push(`# AI Memory Context`);
  sections.push(`> Generated: ${new Date().toISOString().slice(0, 16)} UTC`);
  sections.push("");

  // global.md — permanent user facts
  const globalPath = path.join(storeRoot, "global.md");
  if (fs.existsSync(globalPath)) {
    sections.push("## Global Facts");
    sections.push(fs.readFileSync(globalPath, "utf-8").trim());
    sections.push("");
  }

  // project facts
  if (!fs.existsSync(projectsRoot)) {
    sections.push("*(no project facts yet)*");
  } else {
    const jsonlFiles = fs.readdirSync(projectsRoot)
      .filter(f => f.endsWith(".jsonl"))
      .sort();

    // If --project flag given, only show that project
    const filterProject = opts.project;
    const targets = filterProject
      ? jsonlFiles.filter(f => f === `${filterProject}.jsonl`)
      : jsonlFiles;

    for (const f of targets) {
      const project = f.replace(".jsonl", "");
      // F3.2: loadRecentFacts is now async (streams JSONL with ring buffer).
      const facts   = await loadRecentFacts(path.join(projectsRoot, f), TOP_PER_PROJECT);
      if (facts.length === 0) continue;

      sections.push(`## Project: ${project}`);
      for (const fact of facts) {
        const date    = (fact.t || "").slice(0, 10);
        const content = truncate(fact.content || fact.facts?.[0] || "");
        sections.push(`- [${date}] ${content}`);
        if (Array.isArray(fact.decisions) && fact.decisions.length) {
          sections.push(`  → ${fact.decisions.map(d => truncate(d, 100)).join("; ")}`);
        }
      }
      sections.push("");
    }
  }

  const output = sections.join("\n");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, output, "utf-8");
  return contextPath;
}

// CLI entry point
async function cliMain() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const project = projectIdx >= 0 ? args[projectIdx + 1] : undefined;

  try {
    const outPath = await generateContext({ project });
    const size    = fs.statSync(outPath).size;
    process.stdout.write(`[generate-context] wrote ${outPath} (${size} bytes)\n`);
  } catch (err) {
    process.stderr.write(`[generate-context] error: ${err.message}\n`);
    process.exit(1);
  }
}

// Run as CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain();
}

export { generateContext };
