#!/usr/bin/env node
/**
 * ops/init-sqlite-schema.js
 * Initializes ~/.ai-memory/.memory/.index/memory.db with ADR-002 schema.
 *
 * Usage: node ops/init-sqlite-schema.js [--dry-run]
 *
 * sqlite-vec 0.1.9 table format:
 *   CREATE VIRTUAL TABLE t USING vec0(column_name FLOAT[dimensions])
 *
 * Embedding model: all-MiniLM-L6-v2 = 384 dimensions
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const _home = (process.env.HOME || process.env.USERPROFILE || "").replace(/\\/g, "/");
function expandHome(p) {
  return p.replace(/^~\//, _home + "/").replace(/^~\$/, _home + "/");
}
const AI_MEMORY_ROOT = expandHome(
  process.env.AI_MEMORY_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".ai-memory")
);
const DB_PATH = path.join(AI_MEMORY_ROOT, ".memory", ".index", "memory.db");
const EMBEDDING_DIM = 384;

const DRY_RUN = process.argv.includes("--dry-run");

function getPythonCommand() {
  // Priority: D:/python/python.exe (has sentence-transformers + sqlite-vec)
  if (process.platform === "win32") {
    const fp = "D:/python/python.exe";
    if (fs.existsSync(fp)) return fp;
  }
  if (process.env.AI_MEMORY_PYTHON) return process.env.AI_MEMORY_PYTHON;
  return "python";
}

function runPython(script, stdinData) {
  return new Promise((resolve, reject) => {
    const PYTHON = getPythonCommand();
    const child = spawn(PYTHON, [PYTHON === "python" ? "-c" : "-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(stderr || `exit-${code}`));
      resolve(stdout.trim());
    });
    if (stdinData) child.stdin.end(stdinData);
    else child.stdin.end();
  });
}

async function main() {
  console.log("[init] Target DB:", DB_PATH);

  if (DRY_RUN) {
    console.log("[dry-run] Would execute schema creation");
    printSchema();
    return;
  }

  // Ensure .index directory exists
  const indexDir = path.dirname(DB_PATH);
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true });
    console.log("[init] Created directory:", indexDir);
  }

  // Verify sqlite-vec is loadable first
  try {
    await runPython(`
import sqlite3, sqlite_vec
conn = sqlite3.connect(':memory:')
conn.enable_load_extension(True)
sqlite_vec.load(conn)
print('sqlite-vec', sqlite_vec.__version__, 'OK')
`);
    console.log("[init] sqlite-vec verified OK");
  } catch (e) {
    console.error("[init] sqlite-vec load FAILED:", e.message);
    process.exit(1);
  }

  const script = `
import json, sqlite3, sys, os, sqlite_vec

payload = json.load(sys.stdin)
db_path = payload.get("db_path", ":memory:")
DIM = int(payload.get("dim", 384))

conn = sqlite3.connect(db_path)
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA foreign_keys=ON')
conn.enable_load_extension(True)
sqlite_vec.load(conn)

# 1. files — canonical file registry
conn.execute('''
  CREATE TABLE IF NOT EXISTS files (
    path          TEXT PRIMARY KEY,
    content_hash  TEXT NOT NULL,
    memory_type   TEXT,
    name          TEXT,
    description   TEXT,
    adr_version   TEXT DEFAULT '002',
    mtime         INTEGER NOT NULL,
    chunk_count   INTEGER DEFAULT 0
  )
''')

# 2. chunks — line-range chunk store (ADR-002, replaces whole JSONL)
conn.execute('''
  CREATE TABLE IF NOT EXISTS chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path     TEXT NOT NULL,
    chunk_id      TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    start_line    INTEGER NOT NULL,
    end_line      INTEGER NOT NULL,
    text          TEXT NOT NULL,
    token_count   INTEGER,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE,
    UNIQUE(file_path, chunk_id)
  )
''')

# 3. chunks_fts — FTS5 full-text index
conn.execute('''
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    file_path UNINDEXED,
    text,
    content='chunks',
    content_rowid='id'
  )
''')

# 4. chunks_vec — sqlite-vec vector index (all-MiniLM-L6-v2 = 384 dims)
conn.execute(f'''
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    chunk_id  TEXT UNINDEXED,
    file_path TEXT UNINDEXED,
    items     FLOAT[{DIM}]
  )
''')

# 5. embedding_cache — provider/model/content_hash → vector (avoids re-embedding)
conn.execute('''
  CREATE TABLE IF NOT EXISTS embedding_cache (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    vector        BLOB NOT NULL,
    created_at    INTEGER NOT NULL,
    hit_count     INTEGER DEFAULT 0,
    last_hit      INTEGER,
    UNIQUE(provider, model, content_hash)
  )
''')

# 6. memory_meta — denormalized metadata for fast filtering
conn.execute('''
  CREATE TABLE IF NOT EXISTS memory_meta (
    chunk_id         TEXT PRIMARY KEY,
    file_path        TEXT NOT NULL,
    memory_type      TEXT NOT NULL,
    durable_type     TEXT,
    name             TEXT,
    expires_at       INTEGER,
    access_count     INTEGER DEFAULT 0,
    last_accessed    INTEGER,
    promotion_count  INTEGER DEFAULT 0,
    source_session   TEXT,
    FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
  )
''')

# 7. consolidation_state — Phase 3 lock (replaces PID file lock)
conn.execute('''
  CREATE TABLE IF NOT EXISTS consolidation_state (
    key   TEXT PRIMARY KEY,
    pid   INTEGER,
    mtime INTEGER,
    owner TEXT,
    state TEXT
  )
''')

# Triggers: keep chunks_fts in sync
conn.execute('''
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, chunk_id, file_path, text)
      VALUES (new.id, new.chunk_id, new.file_path, new.text);
  END
''')
conn.execute('''
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, chunk_id, file_path, text)
      VALUES('delete', old.id, old.chunk_id, old.file_path, old.text);
  END
''')
conn.execute('''
  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, chunk_id, file_path, text)
      VALUES('delete', old.id, old.chunk_id, old.file_path, old.text);
    INSERT INTO chunks_fts(rowid, chunk_id, file_path, text)
      VALUES (new.id, new.chunk_id, new.file_path, new.text);
  END
''')

# Indexes
conn.execute('CREATE INDEX IF NOT EXISTS idx_chunks_file   ON chunks(file_path)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_chunks_hash  ON chunks(content_hash)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_meta_type    ON memory_meta(memory_type)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_meta_expires  ON memory_meta(expires_at)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_cache_hash   ON embedding_cache(provider, model, content_hash)')

# Initialize consolidation state
conn.execute("INSERT OR IGNORE INTO consolidation_state(key, state) VALUES ('consolidation', 'idle')")
conn.commit()

# Report
tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
vec_tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'chunks_%' OR name LIKE 'sqlite_%')")]
triggers = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")]
print('TABLES:', json.dumps(tables))
print('VEC_FTS:', json.dumps(vec_tables))
print('TRIGGERS:', json.dumps(triggers))
print('DONE')
`;

  const result = await runPython(script, JSON.stringify({ db_path: DB_PATH, dim: EMBEDDING_DIM }));
  const lines = result.split("\n");
  const tables = JSON.parse(lines.find(l => l.startsWith("TABLES:"))?.slice(8) || "[]");
  const vecFts  = JSON.parse(lines.find(l => l.startsWith("VEC_FTS:"))?.slice(9) || "[]");
  const triggers = JSON.parse(lines.find(l => l.startsWith("TRIGGERS:"))?.slice(10) || "[]");

  console.log("[init] Tables:", tables.join(", "));
  console.log("[init] Vec/FTS:", vecFts.join(", "));
  console.log("[init] Triggers:", triggers.join(", "));
  console.log("[init] Total tables:", tables.length, "— schema init complete at", DB_PATH);
}

function printSchema() {
  console.log(`
-- files
CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, memory_type TEXT, name TEXT, description TEXT, adr_version TEXT DEFAULT '002', mtime INTEGER NOT NULL, chunk_count INTEGER DEFAULT 0);

-- chunks
CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, chunk_id TEXT NOT NULL, content_hash TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL, token_count INTEGER, created_at INTEGER NOT NULL, UNIQUE(file_path, chunk_id));

-- chunks_fts (FTS5)
CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id, file_path, text, content='chunks', content_rowid='id');

-- chunks_vec (sqlite-vec 0.1.9, all-MiniLM-L6-v2 = 384 dims)
CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id TEXT, file_path TEXT, items FLOAT[384]);

-- embedding_cache
CREATE TABLE embedding_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL, created_at INTEGER NOT NULL, hit_count INTEGER DEFAULT 0, last_hit INTEGER, UNIQUE(provider, model, content_hash));

-- memory_meta
CREATE TABLE memory_meta (chunk_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, memory_type TEXT NOT NULL, durable_type TEXT, name TEXT, expires_at INTEGER, access_count INTEGER DEFAULT 0, last_accessed INTEGER, promotion_count INTEGER DEFAULT 0, source_session TEXT);

-- consolidation_state
CREATE TABLE consolidation_state (key TEXT PRIMARY KEY, pid INTEGER, mtime INTEGER, owner TEXT, state TEXT);

-- 3 FTS triggers: ai/au/ad
-- 5 indexes: chunks(file), chunks(hash), meta(type), meta(expires), cache(hash)
`);
}

main().catch(err => { console.error("[init] ERROR:", err.message); process.exit(1); });
