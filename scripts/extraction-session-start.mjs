// scripts/extraction-session-start.mjs
// Claude Code SessionStart Hook: injects user identity + recent project facts into context
// ESM module, no dependencies, pure file reads
// Always exits 0 — never crashes Claude Code

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { resolveStoreRoot, getProjectsRoot } = require("../bus/store-root.js");

const MAX_INJECT_TOKENS = 800;

function estimateTokens(text) {
  if (!text) return 0;
  // Rough estimate: Chinese chars ~2 tokens, others ~4 chars per token
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil((text.length - chineseChars) / 4 + chineseChars / 2);
}

function fitTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  // Truncate with safety margin
  const ratio = (maxTokens / estimateTokens(text)) * 0.85;
  return text.slice(0, Math.floor(text.length * ratio)) + "\n…";
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8").trim();
}

/**
 * Drain stdin to prevent blocking.
 * Claude Code SessionStart passes JSON but we don't need it.
 */
async function drainStdin() {
  try {
    for await (const _line of createInterface({ input: process.stdin })) {
      // Drain all input
    }
  } catch {
    // Ignore drain errors
  }
}

async function main() {
  // Drain stdin (Claude Code may write JSON here)
  await drainStdin();

  const storeRoot = resolveStoreRoot();
  const projectsRoot = getProjectsRoot(storeRoot);
  const cwd = process.cwd();
  const project = path.basename(cwd) || "default";

  const lines = [];

  lines.push("=".repeat(60));
  lines.push(`[Memory] Session started — project: ${project}`);
  lines.push("=".repeat(60));

  // L0: user-identity.md
  const identity = readText(path.join(storeRoot, "user-identity.md"));
  if (identity) {
    lines.push("\n## User Identity (Read First)");
    lines.push(fitTokens(identity, 200));
  }

  // L1: recent facts from project.jsonl (last 10, reversed = newest first)
  const projectJsonlPath = path.join(projectsRoot, `${project}.jsonl`);
  if (fs.existsSync(projectJsonlPath)) {
    const rawLines = fs
      .readFileSync(projectJsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-10)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    if (rawLines.length > 0) {
      lines.push(`\n## Recent Project Memory (${project})`);
      for (const r of rawLines) {
        const date = (r.t || "").slice(0, 10);
        const tag = r.type || "?";
        let line = `[${date}] [${tag}] `;
        if (r.content) line += r.content.slice(0, 120);
        else if (r.title) line += r.title.slice(0, 120);
        else if (r.facts && r.facts[0]) line += r.facts[0].slice(0, 120);
        lines.push(fitTokens(line, 150));
      }
    }
  }

  lines.push("\n" + "=".repeat(60));
  lines.push("[Memory] End of injected context");

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("[Memory SessionStart] Warning: failed to load context —", err.message);
  process.exit(0); // Hook must never crash Claude Code
});