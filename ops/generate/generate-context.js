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

function getProjectsRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "projects");
}

const TOP_PER_PROJECT = 10;
const MAX_CONTENT_CHARS = 200;  // truncate long fact content

function truncate(str, max = MAX_CONTENT_CHARS) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function loadRecentFacts(jsonlPath, topK) {
  if (!fs.existsSync(jsonlPath)) return [];
  const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && !r.extraction_failed)
    .reverse()
    .slice(0, topK);
}

function generateContext(opts = {}) {
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
      const facts   = loadRecentFacts(path.join(projectsRoot, f), TOP_PER_PROJECT);
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
    const outPath = generateContext({ project });
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
