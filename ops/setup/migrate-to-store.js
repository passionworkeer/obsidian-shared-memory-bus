/**
 * ops/migrate-to-store.js
 * =========================
 * One-time migration: copies all memory data from the old Obsidian Vault
 * store to the new `.ai-memory` local store root.
 *
 * Usage:
 *   node ops/migrate-to-store.js [--dry-run] [--verbose]
 *
 * What gets migrated:
 *   {vault}/00-System/ai-memory/
 *     inbox/          → {store}/inbox/
 *     generated/      → {store}/generated/
 *     kg/             → {store}/kg/
 *     structured/     → {store}/structured/
 *     embeddings/     → {store}/embeddings/
 *     events/         → {store}/events/
 *     state/          → {store}/state/
 *     imported/       → {store}/imported/
 *     L0-fixed.md     → {store}/L0-fixed.md
 *     MEMORY-SCHEMA.md→ {store}/MEMORY-SCHEMA.md
 *     README.md       → {store}/README.md
 *
 * The migration is incremental: files that already exist in the new store
 * are skipped (not overwritten) unless --force is passed.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Store root resolution — must match bus/store-root.js
// ---------------------------------------------------------------------------
function loadStoreRootHelper() {
  const candidates = [
    // bus/ sibling (project layout)
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    // ops/bus/ (legacy nested layout)
    path.join(__dirname, "..", "bus", "store-root.js"),
    // Script-local (installed flat layout: ~/.ai-memory/ops/)
    path.join(__dirname, "store-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  return null;
}

function resolveStoreRoot() {
  const helper = loadStoreRootHelper();
  if (helper) {
    try { return helper.resolveStoreRoot(); } catch { /* fall through */ }
  }
  // Use DEFAULT_STORE_ROOT from store-root.js to avoid hardcoding
  const { DEFAULT_STORE_ROOT } = require("./store-root.js");
  return process.env.AI_MEMORY_STORE || DEFAULT_STORE_ROOT;
}

function resolveVaultRoot() {
  // Legacy: try to find the Obsidian vault that holds ai-memory
  const vaultRootCandidates = [
    process.env.AI_MEMORY_OBSIDIAN_VAULT,
    process.env.OBSIDIAN_VAULT_ROOT,
  ];
  for (const candidate of vaultRootCandidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  // Heuristic: find "Obsidian Vault" folder
  const userHome = process.env.USERPROFILE || "";
  const candidateVaults = [
    path.join(userHome, "Obsidian Vault"),
    path.join(userHome, "Desktop", "Obsidian Vault"),
    path.join(userHome, "Documents", "Obsidian Vault"),
    // Common desktop locations
    "E:\\desktop\\Obsidian Vault",
    "E:\\Obsidian Vault",
    "D:\\Obsidian Vault",
  ];
  for (const candidate of candidateVaults) {
    const aiMemoryPath = path.join(candidate, "00-System", "ai-memory");
    if (fs.existsSync(aiMemoryPath)) return path.resolve(candidate);
  }
  return "";
}

const STORE_ROOT = resolveStoreRoot();
const VAULT_ROOT = resolveVaultRoot();
const LEGACY_AI_MEMORY = VAULT_ROOT
  ? path.join(VAULT_ROOT, "00-System", "ai-memory")
  : "";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose") || DRY_RUN;
const FORCE = process.argv.includes("--force");

function log(msg) { if (VERBOSE) console.log(msg); }
function logDry(msg) { if (DRY_RUN) console.log("[DRY-RUN]", msg); }

function cp(src, dst, options = {}) {
  if (!fs.existsSync(src)) {
    log(`  skip  (not found): ${src}`);
    return 0;
  }
  if (fs.existsSync(dst) && !FORCE) {
    log(`  skip  (exists):    ${dst}`);
    return 0;
  }
  if (DRY_RUN) {
    logDry(`  copy: ${src} → ${dst}`);
    return 1;
  }
  // Ensure parent dir exists
  const parent = path.dirname(dst);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.copyFileSync(src, dst);
  log(`  copied: ${path.basename(dst)}`);
  return 1;
}

function copyDirRecursive(srcDir, dstDir, patterns = null) {
  if (!fs.existsSync(srcDir)) {
    log(`  skip  (not found): ${srcDir}`);
    return 0;
  }
  let count = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      // Skip lock files and temp dirs
      if (["node_modules", ".git", "logs"].includes(entry.name) && srcDir.includes("structured")) {
        log(`  skip  (special dir): ${srcPath}`);
        continue;
      }
      if (!fs.existsSync(dstPath)) fs.mkdirSync(dstPath, { recursive: true });
      count += copyDirRecursive(srcPath, dstPath, patterns);
    } else {
      // Skip lock files
      if (entry.name.endsWith(".lock")) {
        log(`  skip  (lock file): ${srcPath}`);
        continue;
      }
      // Filter by patterns if given
      if (patterns && patterns.length > 0) {
        const ext = path.extname(entry.name).toLowerCase();
        const allowedExts = patterns.map(p => p.toLowerCase());
        if (!allowedExts.includes(ext)) {
          log(`  skip  (ext filter): ${srcPath}`);
          continue;
        }
      }
      count += cp(srcPath, dstPath);
    }
  }
  return count;
}

function main() {
  console.log("=".repeat(60));
  console.log("Migrate ai-memory: Obsidian Vault → Local Store");
  console.log("=".repeat(60));
  console.log();

  if (DRY_RUN) console.log("*** DRY RUN — no files will be written ***\n");
  if (FORCE) console.log("*** FORCE mode — existing files WILL be overwritten ***\n");

  console.log(`New store root : ${STORE_ROOT}`);
  console.log(`Legacy vault    : ${VAULT_ROOT || "(not auto-detected)"}`);
  console.log(`Legacy data     : ${LEGACY_AI_MEMORY || "(not found)"}`);
  console.log();

  if (!LEGACY_AI_MEMORY || !fs.existsSync(LEGACY_AI_MEMORY)) {
    console.error("ERROR: Legacy ai-memory directory not found.");
    console.error("  Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT, or");
    console.error("  ensure 'Obsidian Vault/00-System/ai-memory' exists.");
    process.exit(1);
  }

  // Ensure new store root exists
  if (!DRY_RUN && !fs.existsSync(STORE_ROOT)) {
    fs.mkdirSync(STORE_ROOT, { recursive: true });
    console.log(`Created store root: ${STORE_ROOT}`);
  }

  // ----------------------------------------------------------------
  // Subdirs to migrate: [srcSubdir, dstSubdir, description]
  // ----------------------------------------------------------------
  const subdirs = [
    ["inbox",        "inbox",        "Agent inbox files"],
    ["generated",    "generated",    "Generated context files"],
    ["kg",           "kg",           "Knowledge graph (SQLite)"],
    ["structured",   "structured",   "Structured JSONL records"],
    ["embeddings",   "embeddings",   "Embeddings index"],
    ["events",       "events",       "Event logs"],
    ["state",        "state",        "Runtime state"],
    ["imported",     "imported",     "Imported memories"],
  ];

  const rootFiles = [
    ["L0-fixed.md",       "L0 bootstrap anchor"],
    ["MEMORY-SCHEMA.md",  "Memory schema docs"],
    ["README.md",          "Readme"],
  ];

  let totalCopied = 0;

  // --- Subdirectories ---
  console.log("[1/2] Migrating subdirectories...");
  for (const [subSrc, subDst, desc] of subdirs) {
    const src = path.join(LEGACY_AI_MEMORY, subSrc);
    const dst = path.join(STORE_ROOT, subDst);
    if (!fs.existsSync(src)) {
      log(`  skip  (not found): ${src}`);
      continue;
    }
    console.log(`\n  ${desc} (${subSrc}/ → ${subDst}/)`);
    const count = copyDirRecursive(src, dst);
    console.log(`    → ${count} file(s) processed`);
    totalCopied += count;
  }

  // --- Root files ---
  console.log("\n[2/2] Migrating root files...");
  for (const [fileName, desc] of rootFiles) {
    const src = path.join(LEGACY_AI_MEMORY, fileName);
    const dst = path.join(STORE_ROOT, fileName);
    const count = cp(src, dst);
    totalCopied += count;
  }

  console.log();
  console.log("=".repeat(60));
  if (DRY_RUN) {
    console.log(`DRY RUN: would have processed ~${totalCopied} file(s)`);
  } else {
    console.log(`MIGRATION COMPLETE — ${totalCopied} file(s) copied`);
  }
  console.log();
  console.log(`New store: ${STORE_ROOT}`);
  console.log(`Verify: node ops/build-memory-layers.js && node ops/mcp-memory-tools-handler.js`);
  console.log("=".repeat(60));

  process.stdout.write(JSON.stringify({
    ok: true,
    storeRoot: STORE_ROOT,
    legacySource: LEGACY_AI_MEMORY,
    filesProcessed: totalCopied,
    dryRun: DRY_RUN,
  }, null, 2));
}

main();
