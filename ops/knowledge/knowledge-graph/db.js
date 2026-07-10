// ops/knowledge/knowledge-graph/db.js
//
// Thin SQLite database wrapper (Db class) plus storage-path resolution and
// stable ID helpers used by the KnowledgeGraph class.
//
// Uses Node.js built-in `node:sqlite` (v22.5+) — no external dependencies.
// Storage: SQLite at AI_MEMORY_ROOT/kg/knowledge-graph.sqlite3

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Store root resolution — no Obsidian dependency
// ---------------------------------------------------------------------------

export async function loadStoreRootHelper() {
  const candidates = [
    // bus/ sibling (project layout)
    path.join(__dirname, "..", "..", "..", "bus", "store-root.js"),
    // Script-local (installed flat layout: ~/.ai-memory/ops/)
    path.join(__dirname, "..", "store-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const mod = await import(pathToFileURL(c));
      return mod.default || mod;
    }
  }
  return null;
}

export async function resolveStoreRoot() {
  const helper = await loadStoreRootHelper();
  if (helper) {
    try {
      return helper.resolveStoreRoot();
    } catch { /* fall through */ }
  }
  // Use DEFAULT_STORE_ROOT from store-root.js to avoid hardcoding
  const { DEFAULT_STORE_ROOT } = await import(pathToFileURL(path.join(__dirname, "..", "..", "store-root.js")));
  return process.env.AI_MEMORY_STORE || DEFAULT_STORE_ROOT;
}

/** @param {string} [storeRoot] @returns {string} KG SQLite database path */
export async function resolveKgPath(storeRoot) {
  const root = storeRoot || await resolveStoreRoot();
  return path.join(root, "kg", "knowledge-graph.sqlite3");
}

// ---------------------------------------------------------------------------
// ID + date helpers
// ---------------------------------------------------------------------------

/** Generate a stable entity ID from a name. */
export function entityId(name) {
  if (!name || typeof name !== "string") return "_unknown_";
  // Preserve CJK, Greek, Cyrillic, Arabic, Hebrew characters as-is
  // Only lowercase ASCII Latin letters; other scripts are case-insensitive by nature
  const lower = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  // Non-ASCII ranges preserved by Unicode escape to keep source readable:
  //   Latin Extended (À-ɏ), CJK Unified (一-鿿), Hiragana (぀-ゟ),
  //   Katakana (゠-ヿ), Cyrillic (Ѐ-ӿ), Arabic (؀-ۿ), Hebrew (֐-׿),
  //   Hangul Syllables (가-힯).
  const NON_ASCII_KEEP = new RegExp("[^a-z0-9\\u00C0-\\u024F\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF\\u0400-\\u04FF\\u0600-\\u06FF\\u0590-\\u05FF\\uAC00-\\uD7AF]+", "g");
  const sanitized = lower
    .replace(NON_ASCII_KEEP, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  return sanitized || "_unknown_";
}

/** Generate a stable triple ID. */
export function tripleId(subject, predicate, object, validFrom) {
  const seed = `${subject}|${predicate}|${object}|${validFrom || Date.now()}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 20);
}

/** Today's date as ISO string (YYYY-MM-DD). */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------

/** Thin wrapper around node:sqlite DatabaseSync that provides a familiar API. */
export class Db {
  /**
   * @param {string} dbPath
   * @param {boolean} readOnly
   */
  constructor(dbPath, readOnly = false) {
    const { DatabaseSync } = require("node:sqlite");
    // Note: node:sqlite is a built-in module, keep require for sync usage
    this._db = new DatabaseSync(dbPath, { readOnly });
    this._execWithRetry("PRAGMA journal_mode = WAL");
    this._execWithRetry("PRAGMA foreign_keys = ON");
    // Wait up to 10s for locks to be released before returning SQLITE_BUSY.
    // WAL mode serialises writers but allows concurrent readers.
    this._execWithRetry("PRAGMA busy_timeout = 10000");
  }

  /** Retry an exec up to 3 times on SQLITE_BUSY. The busy_timeout PRAGMA
   * (10s) makes SQLite wait efficiently at the C level, so on contention we
   * retry without a JS-level busy spin — that would block the event loop. */
  _execWithRetry(sql, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this._db.exec(sql);
        return;
      } catch (err) {
        if (attempt < maxRetries - 1 && err.code === "ERR_SQLITE_ERROR" && err.errstr && err.errstr.includes("locked")) {
          continue; // busy_timeout performs the actual waiting on retry
        }
        throw err;
      }
    }
  }

  exec(sql) {
    this._db.exec(sql);
  }

  /** Execute a statement with params, return all rows. */
  all(sql, ...params) {
    return this._db.prepare(sql).all(...params);
  }

  /** Execute a statement with params, return first row. */
  get(sql, ...params) {
    return this._db.prepare(sql).get(...params);
  }

  /** Execute a statement with params (INSERT/UPDATE/DELETE). Returns run result. */
  run(sql, ...params) {
    return this._db.prepare(sql).run(...params);
  }

  close() {
    this._db.close();
  }
}