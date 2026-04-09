#!/usr/bin/env node
/**
 * ops/migrate-memory-v2.js
 * Migrates existing .memory/*.md files from ADR-001 frontmatter to ADR-002 v2 schema.
 *
 * v2 adds:
 *   - content_hash (SHA-256 of content body)
 *   - promotion block (version: 1, promoted_at, reason, source_type, source_confidence)
 *   - provenance block (consolidation_pass: 0)
 *   - lifecycle block (expires_at, access_count, promotion_count)
 *
 * Usage:
 *   node ops/migrate-memory-v2.js [--dry-run] [--verbose]
 *   node ops/migrate-memory-v2.js ~/.ai-memory/.memory/feedback/test.md
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const _home = (process.env.HOME || process.env.USERPROFILE || "").replace(/\\/g, "/");
function expandHome(p) {
  return p.replace(/^~\//, _home + "/").replace(/^~\$/, _home + "/");
}
const AI_MEMORY_ROOT = expandHome(
  process.env.AI_MEMORY_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".ai-memory")
);
const MEMORY_ROOT = path.join(AI_MEMORY_ROOT, ".memory");

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const _args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const TARGET_FILES = _args.length > 0 ? _args : null;

// Retention TTLs in days (null = never)
const TTL_DAYS = {
  user: null,
  feedback: 90,
  project: null,  // project end date required
  reference: 180,
  session: 7,
  task: 30,
};

function nowISO() {
  return new Date().toISOString();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function addDays(days) {
  if (days === null || days === undefined) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function computeContentHash(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2];
  const fm = {};

  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }

  return { frontmatter: fm, body, rawFrontmatter: raw };
}

function hasV2Frontmatter(fm) {
  return fm.promotion !== undefined ||
         fm.content_hash !== undefined ||
         fm.provenance !== undefined ||
         fm.lifecycle !== undefined ||
         fm.adr !== undefined;
}

function guessMemoryType(fm) {
  if (fm.type) return fm.type;
  if (fm.name && fm.name.includes("feedback")) return "feedback";
  if (fm.name && (fm.name.includes("user") || fm.name.includes("preference"))) return "user";
  if (fm.name && (fm.name.includes("project") || fm.name.includes("context"))) return "project";
  if (fm.name && fm.name.includes("reference")) return "reference";
  return "feedback";
}

function buildV2Frontmatter(fm, contentHash) {
  const memType = guessMemoryType(fm);
  const ttlDays = TTL_DAYS[memType] ?? 90;

  const lines = [];

  lines.push(`name: ${fm.name || "unknown"}`);
  lines.push(`description: ${fm.description || ""}`);
  lines.push(`type: ${memType}`);
  lines.push(`durable_type: ${memType}`);
  lines.push(`content_hash: sha256:${contentHash}`);
  lines.push(`adr: "002"`);
  lines.push("");
  lines.push("promotion:");
  lines.push("  version: 1");
  lines.push(`  durable_type: ${memType}`);
  lines.push(`  key: ${fm.name ? fm.name.replace(/[^a-z0-9-_]/gi, "-").toLowerCase() : "unknown"}`);
  lines.push("  reason: migrated from ADR-001 frontmatter");
  lines.push("  source_type: migration");
  lines.push("  source_confidence: 0.8");
  lines.push(`  promoted_at: ${nowISO()}`);
  lines.push("");
  lines.push("provenance:");
  lines.push("  consolidation_pass: 0");
  if (fm.session_id) lines.push(`  original_session: ${fm.session_id}`);
  lines.push("");
  lines.push("lifecycle:");
  lines.push(`  expires_at: ${addDays(ttlDays) ?? "null"}`);
  lines.push("  access_count: 0");
  lines.push("  promotion_count: 1");

  return lines.join("\n");
}

function migrateFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter: fm, body, rawFrontmatter } = parseFrontmatter(raw);

  if (hasV2Frontmatter(fm)) {
    if (VERBOSE) console.log(`[skip] ${filePath} — already v2`);
    return { action: "skip", path: filePath };
  }

  const contentHash = computeContentHash(body);
  const v2Fm = buildV2Frontmatter(fm, contentHash);
  const newContent = `---\n${v2Fm}\n---\n${body}`;

  // Backup
  if (!DRY_RUN) {
    const backupPath = filePath + ".bak";
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    fs.writeFileSync(filePath, newContent, "utf8");
  }

  return {
    action: "migrate",
    path: filePath,
    hash: contentHash.slice(0, 12),
    type: guessMemoryType(fm),
  };
}

function walkMemoryDir(root) {
  const results = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".index" || entry.name === ".lock" || entry.name === ".config") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMemoryDir(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  const files = TARGET_FILES !== null
  ? TARGET_FILES
  : walkMemoryDir(MEMORY_ROOT);

  if (files.length === 0) {
    console.log("[migrate] No .md files found to migrate");
    return;
  }

  console.log(`[migrate] Found ${files.length} files to scan`);
  if (DRY_RUN) console.log("[migrate] DRY RUN — no files will be modified\n");

  const results = { migrated: 0, skipped: 0, errors: [] };

  for (const filePath of files) {
    try {
      const result = migrateFile(filePath);
      if (result.action === "migrate") {
        results.migrated++;
        const label = DRY_RUN ? "[dry-run migrate]" : "[migrated]";
        console.log(`${label} ${result.path}`);
        if (VERBOSE) console.log(`  hash: sha256:${result.hash}  type: ${result.type}`);
      } else {
        results.skipped++;
      }
    } catch (err) {
      results.errors.push({ path: filePath, error: err.message });
      console.error(`[error] ${filePath}: ${err.message}`);
    }
  }

  console.log(`\n[migrate] Done. migrated=${results.migrated}  skipped=${results.skipped}  errors=${results.errors.length}`);
  if (DRY_RUN && results.migrated > 0) {
    console.log("[migrate] Run without --dry-run to apply changes");
  }
}

main().catch(err => { console.error("[migrate] FATAL:", err); process.exit(1); });
