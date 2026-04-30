/**
 * ops/migrations/kg-v1-to-v2.js
 * =============================
 * KG Schema Migration v1 → v2
 *
 * Adds temporal validity fields and confidence to triples table:
 *   - valid_from TEXT     — 事实从何时生效
 *   - valid_to   TEXT    — 事实到何时失效（NULL = 当前有效）
 *   - confidence REAL    — 置信度 0.0-1.0，跨项目累积
 *   - source_scope TEXT  — 'project' | 'shared' | 'archive'
 *
 * Migration 策略：
 *   1. 检查当前 schema 版本（schema_versions 表）
 *   2. 如已应用，跳过（幂等）
 *   3. 使用 ALTER TABLE 添加新字段（SQLite 支持）
 *   4. 写入 schema_versions 表记录
 *
 * 运行方式：
 *   node ops/migrations/kg-v1-to-v2.js
 */

import fs from "node:fs";
import path from "node:path";

const MIGRATION_VERSION = 2;
const MIGRATION_NAME    = "kg-v1-to-v2";

// ---------------------------------------------------------------------------
// Vault root resolution (compatible with bus/vault-root.js layout)
// ---------------------------------------------------------------------------

function loadVaultRootHelper() {
  const candidates = [
    path.join(__dirname, "../../bus/vault-root.js"),
    path.join(__dirname, "../vault-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return import(c);
  }
  throw new Error(
    "[kg-migration] vault-root.js not found. Set AI_MEMORY_OBSIDIAN_VAULT env var or place vault-root.js in bus/."
  );
}

async function resolveKgPath() {
  const vaultRootModule = await loadVaultRootHelper();
  const vaultRoot = vaultRootModule.resolveVaultRoot();
  return path.join(vaultRoot, "00-System", "ai-memory", "kg", "knowledge-graph.sqlite3");
}

async function resolveKgDir() {
  return path.dirname(await resolveKgPath());
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Run the v1→v2 migration.
 * Idempotent: safe to call multiple times.
 * @returns {{ok?: boolean, skipped?: boolean, version: number, error?: string}}
 */
async function migrate() {
  const dbPath = await resolveKgPath();
  const dbDir  = await resolveKgDir();

  // Node.js 22.5+ built-in
  const { DatabaseSync } = await import("node:sqlite");

  // Ensure the KG directory exists (first-run scenario)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync("file:" + dbPath);

  try {
    // 1. Ensure schema_versions table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        version   INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        name      TEXT
      )
    `);

    // 2. Idempotency check — skip if already applied
    const existing = db
      .prepare("SELECT version FROM schema_versions WHERE version = ?")
      .get(MIGRATION_VERSION);

    if (existing) {
      console.log(`[kg-migration] v${MIGRATION_VERSION} already applied, skipping`);
      return { skipped: true, version: MIGRATION_VERSION };
    }

    // 3. Discover current triples columns
    const columns  = db.prepare("PRAGMA table_info(triples)").all();
    const colNames = new Set(columns.map((c) => c.name));

    // 4. Add missing columns (safe to run even if they exist)
    const adds = [
      ["valid_from",    "ALTER TABLE triples ADD COLUMN valid_from TEXT"],
      ["valid_to",      "ALTER TABLE triples ADD COLUMN valid_to TEXT"],
      ["confidence",     "ALTER TABLE triples ADD COLUMN confidence REAL DEFAULT 0.5"],
      ["source_scope",  "ALTER TABLE triples ADD COLUMN source_scope TEXT DEFAULT 'project'"],
    ];

    for (const [colName, sql] of adds) {
      if (!colNames.has(colName)) {
        db.prepare(sql).run();
        console.log(`[kg-migration] added ${colName}`);
      } else {
        console.log(`[kg-migration] ${colName} already present, skipped`);
      }
    }

    // 5. Record migration in schema_versions
    db.prepare(
      "INSERT OR IGNORE INTO schema_versions (version, applied_at, name) VALUES (?, ?, ?)"
    ).run(MIGRATION_VERSION, new Date().toISOString(), MIGRATION_NAME);

    console.log(`[kg-migration] v${MIGRATION_VERSION} applied successfully`);
    return { ok: true, version: MIGRATION_VERSION };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Module & CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = await migrate();
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(1);
  }
}

export { migrate, MIGRATION_VERSION, MIGRATION_NAME };
