/**
 * ops/export/export-md.js
 *
 * Markdown truth-derivation layer (EverOS-inspired).
 *
 * Reads structured JSONL event streams (the project's append-only source of
 * truth) and *derives* a parallel set of human-readable Markdown notes that
 * Obsidian can consume directly. JSONL is never modified; .md files are a
 * read-only projection so users can:
 *
 *   - Browse memory in Obsidian's graph view / backlinks
 *   - Edit/annotate content via Obsidian UI (changes flow back via the
 *     existing sync-importers pipeline, not this tool)
 *   - Get version-controlled, git-friendly memory (each .md is a normal file)
 *
 * Design follows EverOS's "markdown source of truth" philosophy but adapted to
 * this project's "JSONL truth + Markdown projection" model:
 *
 *   - JSONL is the *write* truth (append-only, atomic, low-level audit)
 *   - Markdown is the *read* truth (humans, Obsidian, search-friendly)
 *
 * Output layout (under $AI_MEMORY_STORE/derived/):
 *
 *   derived/
 *     index.md                           # Master index grouped by scope/type
 *     by-scope/
 *       user.md                          # All user-scoped memories
 *       project.md
 *       task.md
 *       ...
 *     by-id/
 *       <id>.md                          # One file per record (atomic unit)
 *
 * Frontmatter schema (10 fields, aligned with ops/adapters/schema-registry.json
 * memory-record-v2 contract):
 *
 *   Required (8): id, schemaVersion, type, scope, memory_level, title,
 *                 tool, source
 *   Useful (2):  t (ISO timestamp), tags (Obsidian-native #tag syntax)
 *
 * Usage:
 *   node ops/export/export-md.js                  # Export all to default paths
 *   node ops/export/export-md.js --source inbox   # Export only shared-inbox
 *   node ops/export/export-md.js --check          # Verify projections up to date
 *
 * Inspired by:
 *   - EverOS docs/storage_layout.md "Markdown + YAML frontmatter" chassis
 *   - tech-debt-roadmap.md 债项 "可读导出层"
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Store root resolution (mirrors build-handoff-pack.js / build-memory-layers.js)
// ---------------------------------------------------------------------------

async function loadStoreRootHelper() {
  const candidates = [
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    path.join(__dirname, "bus", "store-root.js"),
    path.join(__dirname, "store-root.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate));
      return mod.default || mod;
    }
  }
  throw new Error(`store-root-helper-missing: tried ${candidates.join(", ")}`);
}

const resolveStoreRootMod = await loadStoreRootHelper();
const resolveStoreRoot = resolveStoreRootMod.resolveStoreRoot || resolveStoreRootMod;

const STORE_ROOT = resolveStoreRoot();
const STRUCTURED_ROOT = path.join(STORE_ROOT, "structured");
const DERIVED_ROOT = path.join(STORE_ROOT, "derived");

// Default sources to project. Names match $AI_MEMORY_STORE/structured/*.jsonl
// without the extension.
const DEFAULT_SOURCES = [
  "shared-inbox",
  "shared-events",
  "dream-inbox",
  "session-memory",
  "task-memory",
];

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const sourceIdx = args.indexOf("--source");
const onlySource = sourceIdx !== -1 ? args[sourceIdx + 1] : null;
const sources = onlySource ? [onlySource] : DEFAULT_SOURCES;

// Skip the side-effect-driven main() when this module is imported (e.g. from
// unit tests). Only run main() when this file is the actual CLI entry point.
const IS_CLI = import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function safeFilename(id) {
  // Obsidian forbids \\ / : * ? " < > | in filenames and dislikes leading dots.
  return String(id || "unknown")
    .replace(/[\\/:*?"<>|\s]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200);
}

function escapeYamlString(value) {
  // Quote any string that contains YAML-special chars or starts with quotes.
  const s = String(value == null ? "" : value);
  if (s === "") return '""';
  // Use double-quoted YAML; escape backslashes and double-quotes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatTags(tags) {
  if (!Array.isArray(tags)) return "[]";
  return "[" + tags.map((t) => escapeYamlString(t)).join(", ") + "]";
}

function toObsidianTags(tags) {
  if (!Array.isArray(tags)) return "";
  // Obsidian renders tags inside body via #tag syntax; reserved chars are
  // replaced with underscore to keep tags filesystem-safe.
  return tags
    .map((t) => {
      const cleaned = String(t).trim().replace(/\s+/g, "_").replace(/[#,\[\]\(\)]/g, "");
      return cleaned ? `#${cleaned}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Render one JSONL memory record as a standalone Markdown file.
 * Pure function: deterministic, no side effects, easy to unit-test.
 */
export function renderRecordMarkdown(record) {
  const id = String(record.id || "").trim() || "unknown";
  const required = {
    schemaVersion: record.schemaVersion ?? 2,
    id,
    type: record.type ?? "unknown",
    scope: record.scope ?? "unknown",
    memory_level: record.memory_level ?? "durable",
    title: record.title ?? "(untitled)",
    tool: record.tool ?? "unknown",
    source: record.source ?? "unknown",
  };
  const optional = {
    t: record.t ?? null,
    tags: Array.isArray(record.tags) ? record.tags : null,
  };

  const fm = [
    "---",
    `schemaVersion: ${required.schemaVersion}`,
    `id: ${escapeYamlString(required.id)}`,
    `type: ${escapeYamlString(required.type)}`,
    `scope: ${escapeYamlString(required.scope)}`,
    `memory_level: ${escapeYamlString(required.memory_level)}`,
    `title: ${escapeYamlString(required.title)}`,
    `tool: ${escapeYamlString(required.tool)}`,
    `source: ${escapeYamlString(required.source)}`,
  ];
  if (optional.t) fm.push(`t: ${escapeYamlString(optional.t)}`);
  if (optional.tags) fm.push(`tags: ${formatTags(optional.tags)}`);
  fm.push("---");

  const body = [
    "",
    `# ${required.title}`,
    "",
    toObsidianTags(optional.tags) ? `\n${toObsidianTags(optional.tags)}\n` : "",
    optional.t ? `\n> 🕒 ${optional.t}\n` : "",
    "\n## Content\n",
    String(record.content ?? "").trim() || "_(no content)_",
    "",
    "\n## Metadata\n",
    "| Field | Value |",
    "|-------|-------|",
    `| id | \`${required.id}\` |`,
    `| scope | ${required.scope} |`,
    `| memory_level | ${required.memory_level} |`,
    `| tool | ${required.tool} |`,
    `| source | ${required.source} |`,
    `| type | ${required.type} |`,
    optional.t ? `| timestamp | ${optional.t} |` : "",
    optional.tags?.length ? `| tags | ${optional.tags.join(", ")} |` : "",
    "",
  ];

  return fm.join("\n") + "\n" + body.filter((s) => s !== undefined).join("\n");
}

/**
 * Read JSONL from a path; tolerate malformed lines.
 * Returns array of records (synchronous to keep renderRecordMarkdown testable).
 */
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines silently; JSONL is append-only and partial
      // corruption is the caller's problem to investigate.
    }
  }
  return records;
}

function groupBy(records, keyFn) {
  const groups = new Map();
  for (const r of records) {
    const key = keyFn(r) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function renderIndex(records) {
  const byScope = groupBy(records, (r) => r.scope || "unknown");
  const lines = [
    "---",
    "schemaVersion: 2",
    `generated_at: "${new Date().toISOString()}"`,
    `record_count: ${records.length}`,
    "---",
    "",
    "# Memory Bus — Derived Index",
    "",
    `Total records: **${records.length}**`,
    "",
    "## By Scope",
    "",
  ];
  for (const [scope, items] of [...byScope.entries()].sort()) {
    lines.push(`### \`${scope}\` (${items.length})`);
    lines.push("");
    lines.push(`- [Open ${scope}](./by-scope/${scope}.md)`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderScopePage(scope, records) {
  const byType = groupBy(records, (r) => r.type || "unknown");
  const lines = [
    "---",
    `scope: ${scope}`,
    `record_count: ${records.length}`,
    `generated_at: "${new Date().toISOString()}"`,
    "---",
    "",
    `# Memory Bus — Scope: ${scope}`,
    "",
    `Records in this scope: **${records.length}**`,
    "",
    "## By Type",
    "",
  ];
  for (const [type, items] of [...byType.entries()].sort()) {
    lines.push(`### ${type} (${items.length})`);
    lines.push("");
    for (const r of items.slice(0, 50)) {
      const id = safeFilename(r.id);
      const title = String(r.title || "(untitled)").trim();
      const t = r.t ? ` — ${r.t}` : "";
      lines.push(`- [\`${r.id}\`](../by-id/${id}.md) — ${title}${t}`);
    }
    if (items.length > 50) {
      lines.push(`- _…and ${items.length - 50} more_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(DERIVED_ROOT);
  ensureDir(path.join(DERIVED_ROOT, "by-scope"));
  ensureDir(path.join(DERIVED_ROOT, "by-id"));

  const allRecords = [];
  let skippedSources = 0;

  for (const source of sources) {
    const jsonlPath = path.join(STRUCTURED_ROOT, `${source}.jsonl`);
    const records = readJsonl(jsonlPath);
    if (records.length === 0) {
      skippedSources += 1;
      continue;
    }
    allRecords.push(...records);

    for (const record of records) {
      const outPath = path.join(DERIVED_ROOT, "by-id", `${safeFilename(record.id)}.md`);
      const rendered = renderRecordMarkdown(record);
      if (!checkOnly) {
        fs.writeFileSync(outPath, rendered, "utf8");
      }
    }
  }

  // Build scope pages
  const byScope = groupBy(allRecords, (r) => r.scope || "unknown");
  for (const [scope, records] of byScope.entries()) {
    const outPath = path.join(DERIVED_ROOT, "by-scope", `${scope}.md`);
    if (!checkOnly) {
      fs.writeFileSync(outPath, renderScopePage(scope, records), "utf8");
    }
  }

  // Build index
  if (!checkOnly) {
    fs.writeFileSync(path.join(DERIVED_ROOT, "index.md"), renderIndex(allRecords), "utf8");
  }

  const summary = {
    status: "ok",
    storeRoot: STORE_ROOT,
    derivedRoot: DERIVED_ROOT,
    sourcesScanned: sources.length,
    sourcesEmpty: skippedSources,
    recordsExported: allRecords.length,
    checkOnly,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (IS_CLI) {
  main().catch((err) => {
    process.stderr.write(`export-md failed: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}