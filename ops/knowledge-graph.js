/**
 * ops/knowledge-graph.js
 * ======================
 * Lightweight temporal knowledge graph for the shared memory bus.
 *
 * Inspired by MemPalace's knowledge_graph.py — stores entity-relationship
 * triples in SQLite with temporal validity (valid_from / valid_to).
 *
 * Uses Node.js built-in `node:sqlite` (v22.5+) — no external dependencies.
 *
 * Storage: SQLite at AI_MEMORY_ROOT/kg/knowledge-graph.sqlite3
 *
 * Usage (standalone):
 *   node knowledge-graph.js add "Alice" "works_on" "MemPalace" --valid-from 2026-01-01
 *   node knowledge-graph.js query "Alice"
 *   node knowledge-graph.js stats
 *
 * Usage (as module):
 *   const { KnowledgeGraph } = require('./ops/knowledge-graph')
 *   const kg = new KnowledgeGraph({ vaultRoot })
 *   kg.addTriple('Alice', 'uses', 'MemPalace')
 *   const results = kg.queryEntity('Alice')
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** @param {string} [vaultRoot] @returns {string} */
function resolveKgPath(vaultRoot) {
  const vault = vaultRoot || process.env.AI_MEMORY_OBSIDIAN_VAULT || "";
  if (!vault) {
    return path.join(
      process.env.AI_MEMORY_ROOT || "",
      "kg",
      "knowledge-graph.sqlite3"
    );
  }
  return path.join(vault, "00-System", "ai-memory", "kg", "knowledge-graph.sqlite3");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable entity ID from a name. */
function entityId(name) {
  if (!name || typeof name !== "string") return "_unknown_";
  // Preserve CJK, Greek, Cyrillic, Arabic, Hebrew characters as-is
  // Only lowercase ASCII Latin letters; other scripts are case-insensitive by nature
  const lower = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const sanitized = lower
    .replace(/[^a-z0-9\u00C0-\u024F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\uAC00-\uD7AF]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  return sanitized || "_unknown_";
}

/** Generate a stable triple ID. */
function tripleId(subject, predicate, object, validFrom) {
  const seed = `${subject}|${predicate}|${object}|${validFrom || Date.now()}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 20);
}

/** Today's date as ISO string (YYYY-MM-DD). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------

/** Thin wrapper around node:sqlite DatabaseSync that provides a familiar API. */
class Db {
  /**
   * @param {string} dbPath
   * @param {boolean} readOnly
   */
  constructor(dbPath, readOnly = false) {
    let { DatabaseSync } = require("node:sqlite");
    this._db = new DatabaseSync(dbPath, { readOnly });
    this._execWithRetry("PRAGMA journal_mode = WAL");
    this._execWithRetry("PRAGMA foreign_keys = ON");
    // Wait up to 10s for locks to be released before returning SQLITE_BUSY.
    // WAL mode serialises writers but allows concurrent readers.
    this._execWithRetry("PRAGMA busy_timeout = 10000");
  }

  /** Retry an exec up to 3 times with 50ms backoff on SQLITE_BUSY. */
  _execWithRetry(sql, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this._db.exec(sql);
        return;
      } catch (err) {
        if (attempt < maxRetries - 1 && err.code === "ERR_SQLITE_ERROR" && err.errstr && err.errstr.includes("locked")) {
          // Sleep synchronously using a spin loop (Node SQLite is sync, no setTimeout available here)
          const end = Date.now() + 50 * Math.pow(2, attempt);
          while (Date.now() < end) { /* spin */ }
          continue;
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

// ---------------------------------------------------------------------------
// KnowledgeGraph
// ---------------------------------------------------------------------------

class KnowledgeGraph {
  /**
   * @param {{ dbPath?: string, vaultRoot?: string }} [opts]
   */
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || resolveKgPath(opts.vaultRoot);
    this._db = null;
    this._initDb();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  _initDb() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._db = new Db(this.dbPath);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT DEFAULT 'unknown',
        properties  TEXT DEFAULT '{}',
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS triples (
        id           TEXT PRIMARY KEY,
        subject      TEXT NOT NULL,
        predicate    TEXT NOT NULL,
        object       TEXT NOT NULL,
        valid_from   TEXT,
        valid_to     TEXT,
        confidence   REAL DEFAULT 0.5,
        source_id    TEXT,
        source_file  TEXT,
        source_scope TEXT DEFAULT 'project',
        extracted_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_triples_subject    ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object     ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate  ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid      ON triples(valid_from, valid_to);
    `);
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch {}
      this._db = null;
    }
  }

  // ── Transaction / batch support ───────────────────────────────────────

  /**
   * Begin a write transaction. All subsequent write operations
   * (addEntity, addTriple, ingestRecord) are held in memory until
   * endBatch() is called. This dramatically improves throughput when
   * ingesting hundreds of records.
   */
  beginBatch() {
    this._db.run("BEGIN TRANSACTION");
  }

  /**
   * Commit or roll back the current batch.
   * @param {boolean} [commit=true] — pass false to roll back
   */
  endBatch(commit = true) {
    this._db.run(commit ? "COMMIT" : "ROLLBACK");
  }

  // ── Write operations ──────────────────────────────────────────────────

  /**
   * Add or update an entity node.
   * If the entity already exists, its properties are merged (shallow merge)
   * rather than replaced, so that fields from multiple sources are preserved.
   *
   * @param {string} name
   * @param {'person'|'project'|'concept'|'tool'|'unknown'} [type]
   * @param {object} [properties]
   * @returns {string} entity ID
   */
  addEntity(name, type = "unknown", properties = {}) {
    const eid = entityId(name);
    const existing = this._db.get("SELECT properties, type FROM entities WHERE id = ?", eid);
    const mergedProps = (() => {
      try {
        return existing ? { ...JSON.parse(existing.properties || "{}"), ...properties } : properties;
      } catch (_) {
        return properties; // corrupt JSON — discard and use fresh
      }
    })();
    // Keep the most-specific type seen so far (person > project > concept > tool > unknown)
    const TYPE_RANK = { person: 5, project: 4, concept: 3, tool: 2, unknown: 1 };
    const rank = (t) => TYPE_RANK[t] ?? 0;
    const resolvedType =
      rank(type) > rank(existing ? existing.type : "unknown") ? type : (existing ? existing.type : type);
    const props = JSON.stringify(mergedProps);
    this._db.run(
      "INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)",
      eid, name, resolvedType, props
    );
    return eid;
  }

  /**
   * Add a relationship triple: subject → predicate → object.
   *
   * @param {string} subject
   * @param {string} predicate  - e.g. "uses", "works_on", "is_author_of"
   * @param {string} object
   * @param {{ validFrom?: string, validTo?: string, confidence?: number,
   *           sourceId?: string, sourceFile?: string }} [opts]
   * @returns {string} triple ID
   */
  addTriple(subject, predicate, object, opts = {}) {
    const sid        = entityId(subject);
    const oid        = entityId(object);
    const pred       = predicate.toLowerCase().replace(/\s+/g, "_").slice(0, 64);
    const validFrom  = opts.validFrom    || null;
    const validTo    = opts.validTo      || null;
    const confidence = opts.confidence   ?? 0.5;
    const sourceId   = opts.sourceId      || null;
    const sourceFile = opts.sourceFile    || null;
    const sourceScope = opts.sourceScope  || "project";

    // Auto-create entity nodes
    this._db.run("INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)", sid, subject);
    this._db.run("INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)", oid, object);

    // Check for existing active identical triple
    const existing = this._db.get(
      "SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL",
      sid, pred, oid
    );
    if (existing) return existing.id;

    const tid = tripleId(sid, pred, oid, validFrom);
    this._db.run(
      `INSERT INTO triples (id,subject,predicate,object,valid_from,valid_to,confidence,source_id,source_file,source_scope)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      tid, sid, pred, oid, validFrom, validTo, confidence, sourceId, sourceFile, sourceScope
    );
    return tid;
  }

  /**
   * Seed multiple entity nodes at once.
   * @param {{ name: string, type?: string, properties?: object }[]} entities
   */
  seedEntities(entities) {
    for (const e of entities) {
      this.addEntity(e.name, e.type || "unknown", e.properties || {});
    }
  }

  /**
   * Invalidate a relationship — set its valid_to date.
   * @param {string} subject
   * @param {string} predicate
   * @param {string} object
   * @param {string} [ended] - ISO date string; defaults to today
   */
  invalidate(subject, predicate, object, ended) {
    const sid  = entityId(subject);
    const oid  = entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, "_");
    const when = ended || today();
    this._db.run(
      "UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL",
      when, sid, pred, oid
    );
  }

  /**
   * Ingest extracted entities and facts from a memory record.
   * Call this after entity extraction to populate the KG.
   *
   * @param {object} record - memory record with `id`, `entities[]`, `facts[]`, optional `source_file`
   */
  ingestRecord(record) {
    const facts    = record.facts    || [];
    const entities = record.entities || [];
    const recordId  = record.id      || null;
    const sourceFile = record.source_file || null;

    for (const entity of entities) {
      if (entity.confidence >= 0.6) {
        this.addEntity(entity.name, entity.type || "unknown", {
          confidence: entity.confidence,
          frequency: entity.frequency,
        });
      }
    }

    for (const fact of facts) {
      // Normalise: a fact may be a plain string, an {entity_type} object,
      // or a full { subject, predicate, object } triple.
      if (typeof fact === "string") {
        // Plain string — no structured triple to extract; skip silently.
        continue;
      }

      const subject   = fact.subject      || null;
      const predicate = fact.predicate    || null;
      const object    = fact.object       || null;

      if (subject && object) {
        // Full triple: use the provided predicate (may be absent — handled below).
        const resolvedPredicate = predicate || "is_a";
        this.addTriple(subject, resolvedPredicate, object, {
          confidence: fact.confidence || 1.0,
          sourceId: recordId,
          sourceFile: sourceFile,
        });
      } else if (fact.entity_type) {
        // Entity-classification signal: subject is the entity name,
        // predicate defaults to "is_a", object is the entity_type.
        const entityName = fact.name || subject;
        if (entityName) {
          this.addTriple(entityName, "is_a", fact.entity_type, {
            confidence: fact.confidence || 0.7,
            sourceId: recordId,
            sourceFile: sourceFile,
          });
        }
      }
      // Facts that are neither a triple nor entity-classification are skipped.
    }
  }

  // ── Query operations ───────────────────────────────────────────────────

  /**
   * Get all relationships for an entity.
   *
   * @param {string} name
   * @param {{ asOf?: string, direction?: 'outgoing'|'incoming'|'both' }} [opts]
   * @returns {object[]}
   */
  queryEntity(name, opts = {}) {
    const eid       = entityId(name);
    const direction = opts.direction || "outgoing";
    const asOf      = opts.asOf      || null;

    /** @type {object[]} */
    const results = [];

    /**
     * @param {'outgoing'|'incoming'} dir
     * @param {string} sql
     * @param {any[]} params
     * @param {string} otherCol
     */
    const runQuery = (dir, sql, params, otherCol) => {
      for (const row of this._db.all(sql, ...params)) {
        results.push({
          direction: dir,
          subject:  dir === "outgoing" ? name : row.sub_name,
          predicate: row.predicate,
          object:   dir === "outgoing" ? row.obj_name : name,
          valid_from:  row.valid_from,
          valid_to:    row.valid_to,
          confidence:  row.confidence,
          source_id:   row.source_id,
          current:     row.valid_to === null,
        });
      }
    };

    const temporal = asOf
      ? " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)"
      : "";

    if (direction !== "incoming") {
      runQuery(
        "outgoing",
        `SELECT t.*, o.name as obj_name
           FROM triples t
           JOIN entities o ON t.object = o.id
          WHERE t.subject = ?${temporal}`,
        asOf ? [eid, asOf, asOf] : [eid],
        "obj_name"
      );
    }

    if (direction !== "outgoing") {
      runQuery(
        "incoming",
        `SELECT t.*, s.name as sub_name
           FROM triples t
           JOIN entities s ON t.subject = s.id
          WHERE t.object = ?${temporal}`,
        asOf ? [eid, asOf, asOf] : [eid],
        "sub_name"
      );
    }

    return results;
  }

  /**
   * Query all triples with a given predicate type.
   * @param {string} predicate
   * @param {{ asOf?: string }} [opts]
   * @returns {object[]}
   */
  queryRelationship(predicate, opts = {}) {
    const pred = predicate.toLowerCase().replace(/\s+/g, "_");
    const asOf = opts.asOf || null;
    const temporal = asOf
      ? " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)"
      : "";
    const params = asOf ? [pred, asOf, asOf] : [pred];

    return this._db.all(
      `SELECT t.*, s.name as sub_name, o.name as obj_name
         FROM triples t
         JOIN entities s ON t.subject = s.id
         JOIN entities o ON t.object  = o.id
        WHERE t.predicate = ?${temporal}`,
      ...params
    ).map(row => ({
      subject:   row.sub_name,
      predicate: row.predicate,
      object:    row.obj_name,
      valid_from:  row.valid_from,
      valid_to:    row.valid_to,
      current:     row.valid_to === null,
    }));
  }

  /**
   * Timeline — all facts for an entity in chronological order.
   * @param {string} [name]
   * @returns {object[]}
   */
  timeline(name) {
    if (name) {
      const eid = entityId(name);
      return this._db.all(
        `SELECT t.*, s.name as sub_name, o.name as obj_name
           FROM triples t
           JOIN entities s ON t.subject = s.id
           JOIN entities o ON t.object  = o.id
          WHERE t.subject = ? OR t.object = ?
          ORDER BY CASE WHEN t.valid_from IS NULL THEN 1 ELSE 0 END, t.valid_from ASC
          LIMIT 200`,
        eid, eid
      ).map(r => ({
        subject:   r.sub_name,
        predicate: r.predicate,
        object:    r.obj_name,
        valid_from:  r.valid_from,
        valid_to:    r.valid_to,
        current:     r.valid_to === null,
      }));
    }
    return this._db.all(
      `SELECT t.*, s.name as sub_name, o.name as obj_name
         FROM triples t
         JOIN entities s ON t.subject = s.id
         JOIN entities o ON t.object  = o.id
        ORDER BY CASE WHEN t.valid_from IS NULL THEN 1 ELSE 0 END, t.valid_from ASC
        LIMIT 200`
    ).map(r => ({
      subject:   r.sub_name,
      predicate: r.predicate,
      object:    r.obj_name,
      valid_from:  r.valid_from,
      valid_to:    r.valid_to,
      current:     r.valid_to === null,
    }));
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  /** @returns {{ entities: number, triples: number, currentFacts: number,
   *             expiredFacts: number, relationshipTypes: string[] }} */
  stats() {
    const entities     = this._db.get("SELECT COUNT(*) as cnt FROM entities").cnt;
    const triples      = this._db.get("SELECT COUNT(*) as cnt FROM triples").cnt;
    const currentFacts = this._db.get("SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL").cnt;
    const predicates   = this._db
      .all("SELECT DISTINCT predicate FROM triples ORDER BY predicate")
      .map(r => r.predicate);

    return {
      entities,
      triples,
      currentFacts,
      expiredFacts: triples - currentFacts,
      relationshipTypes: predicates,
    };
  }

  /**
   * Get a single entity by name.
   * @param {string} name
   * @returns {{ ok: true, id: string, name: string, type: string, properties: object } | null}
   */
  getEntity(name) {
    const row = this._db.get("SELECT * FROM entities WHERE id = ?", entityId(name));
    if (!row) return null;
    let props = {};
    try { props = JSON.parse(row.properties || "{}"); } catch (_) { /* corrupt — use {} */ }
    return {
      ok: true,
      id: row.id,
      name: row.name,
      type: row.type,
      properties: props,
      created_at: row.created_at,
    };
  }

  /**
   * Search entities by name with multi-token support and relevance scoring.
   *
   * - Splits query on whitespace; each token must appear somewhere in the name.
   * - Relevance score (higher = better):
   *     3 = exact prefix match on the full name
   *     2 = full name starts with all tokens (in order, contiguous prefix)
   *     1 = all tokens appear somewhere in the name
   *   Entities missing any token score 0 and are excluded.
   *
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   * @returns {object[]}
   */
  searchEntities(query, opts = {}) {
    const limit = opts.limit ?? 20;
    const tokens = (query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (tokens.length === 0) {
      return [];
    }

    // Fetch a generous working set (SQL LIKE on each token would be expensive
    // to construct safely, so we filter in JS after a single broad fetch).
    const rows = this._db.all(
      "SELECT * FROM entities ORDER BY name LIMIT 200"
    );

    /** @param {string} name @returns {number} relevance score */
    const score = (name) => {
      const lower = name.toLowerCase();
      const allMatch = tokens.every((t) => lower.includes(t));
      if (!allMatch) return 0;

      // Exact prefix (whole name starts with full query)
      if (lower.startsWith(query.toLowerCase())) return 3;

      // All tokens present and name starts with the first token
      if (lower.startsWith(tokens[0])) return 2;

      return 1;
    };

    return rows
      .map((row) => {
        let props = {};
        try { props = JSON.parse(row.properties || "{}"); } catch (_) { /* corrupt */ }
        return {
          id:         row.id,
          name:       row.name,
          type:       row.type,
          relevance:  score(row.name),
          properties: props,
        };
      })
      .filter((e) => e.relevance > 0)
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);
  }

  /**
   * Return all entities of a given type.
   * @param {'person'|'project'|'concept'|'tool'|'unknown'} type
   * @returns {object[]}
   */
  getEntitiesByType(type) {
    return this._db
      .all("SELECT * FROM entities WHERE type = ? ORDER BY name", type)
      .map((row) => {
        let props = {};
        try { props = JSON.parse(row.properties || "{}"); } catch (_) { /* corrupt */ }
        return {
          id:         row.id,
          name:       row.name,
          type:       row.type,
          properties: props,
          created_at: row.created_at,
        };
      });
  }

  // ── Temporal / scoped query methods ────────────────────────────────────

  /**
   * Upsert a relationship triple: expire any active identical triple first,
   * then insert the new version with updated validity window and confidence.
   * Use this when the same fact can change over time (e.g., role reassignment).
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {string} object
   * @param {{ validFrom?: string, validTo?: string, confidence?: number,
   *           sourceId?: string, sourceFile?: string, sourceScope?: string }} [opts]
   * @returns {string} new triple ID
   */
  upsertTriple(subject, predicate, object, opts = {}) {
    if (typeof subject !== "string" || typeof predicate !== "string" || typeof object !== "string") {
      throw new Error("upsertTriple: subject/predicate/object must be strings");
    }
    const sid        = entityId(subject);
    const oid        = entityId(object);
    const pred       = predicate.toLowerCase().replace(/\s+/g, "_").slice(0, 64);
    const validFrom  = opts.validFrom   || new Date().toISOString();
    const validTo    = opts.validTo     || null;
    const confidence = opts.confidence  ?? 0.5;
    const sourceId   = opts.sourceId    || null;
    const sourceFile = opts.sourceFile  || null;
    const sourceScope = opts.sourceScope || "project";

    // Expire all currently-active identical triples so only one is current at a time
    this._db.run(
      "UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL",
      validFrom, sid, pred, oid
    );

    const tid = tripleId(sid, pred, oid, validFrom);
    this._db.run(
      `INSERT INTO triples (id,subject,predicate,object,valid_from,valid_to,confidence,source_id,source_file,source_scope)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      tid, sid, pred, oid, validFrom, validTo, confidence, sourceId, sourceFile, sourceScope
    );
    return tid;
  }

  /**
   * Query triples currently valid at a point in time (valid_to IS NULL or > validAt).
   *
   * @param {object} opts
   * @param {string} [opts.entityName]  — filter by entity name (LIKE %entityName%)
   * @param {string} [opts.validAt]     — ISO timestamp; defaults to now
   * @param {number} [opts.limit]        — max rows returned (default 50)
   * @returns {object[]}
   */
  queryCurrentTriples({ entityName = "", validAt = null, limit = 50 } = {}) {
    const time = validAt || new Date().toISOString();

    let sql;
    let params;
    if (entityName) {
      // Normalize entityName so LIKE matches entityId()-stored subjects
      const normalized = entityId(entityName);
      sql = `SELECT * FROM triples
             WHERE subject LIKE ? AND (valid_to IS NULL OR valid_to > ?)
             ORDER BY confidence DESC, valid_from DESC
             LIMIT ?`;
      params = [`%${normalized}%`, time, limit];
    } else {
      sql = `SELECT * FROM triples
             WHERE (valid_to IS NULL OR valid_to > ?)
             ORDER BY confidence DESC, valid_from DESC
             LIMIT ?`;
      params = [time, limit];
    }

    const rows = this._db.all(sql, ...params);
    return rows.map((row) => ({
        subject:     row.subject,
        predicate:   row.predicate,
        object:      row.object,
        valid_from:  row.valid_from,
        valid_to:    row.valid_to,
        confidence:  row.confidence,
        source_scope: row.source_scope,
        current:     row.valid_to === null,
      }));
  }

  /**
   * Increment the confidence score for an entity.
   * When the same entity is observed across multiple projects it becomes more trusted.
   *
   * @param {string} entityName
   * @param {number} [delta=0.05] — amount to add (capped at 1.0)
   */
  incrementConfidence(entityName, delta = 0.05) {
    const eid = entityId(entityName);

    // Find all active triples for this entity (as subject or object)
    const rows = this._db.all(
      `SELECT id, confidence FROM triples
          WHERE (subject = ? OR object = ?)
            AND (valid_to IS NULL OR valid_to > ?)
          LIMIT 100`,
      eid, eid, new Date().toISOString()
    );

    this._db.exec("BEGIN TRANSACTION");
    try {
      for (const row of rows) {
        const current = row.confidence ?? 0.5;
        const updated = Math.min(1.0, current + delta);
        this._db.run("UPDATE triples SET confidence = ? WHERE id = ?", updated, row.id);
      }
      this._db.exec("COMMIT");
    } catch(e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { KnowledgeGraph, entityId, resolveKgPath };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, action, ...args] = process.argv;
  const vaultRoot = process.env.AI_MEMORY_OBSIDIAN_VAULT || "";

  const kg = new KnowledgeGraph({ vaultRoot });

  const run = () => {
    try {
      switch (action) {
        case "add": {
          const [subject, predicate, object] = args;
          if (!subject || !predicate || !object) {
            console.error("Usage: node knowledge-graph.js add <subject> <predicate> <object> [--valid-from YYYY-MM-DD] [--source-scope project|shared|archive]");
            process.exit(1);
          }
          const vfIdx    = args.indexOf("--valid-from");
          const validFrom = vfIdx >= 0 ? args[vfIdx + 1] : null;
          const ssIdx    = args.indexOf("--source-scope");
          const sourceScope = ssIdx >= 0 ? args[ssIdx + 1] : "project";
          const tid = kg.addTriple(subject, predicate, object, { validFrom, sourceScope });
          console.log(`Added: ${subject} --${predicate}--> ${object}  [${tid}]`);
          break;
        }
        case "upsert": {
          const [subject, predicate, object] = args;
          if (!subject || !predicate || !object) {
            console.error("Usage: node knowledge-graph.js upsert <subject> <predicate> <object>");
            process.exit(1);
          }
          const tid = kg.upsertTriple(subject, predicate, object);
          console.log(`Upserted: ${subject} --${predicate}--> ${object}  [${tid}]`);
          break;
        }
        case "query": {
          const [name] = args;
          if (!name) { console.error("Usage: node knowledge-graph.js query <name>"); process.exit(1); }
          const results = kg.queryEntity(name);
          console.log(`\n=== ${name} (${results.length} relationships) ===`);
          for (const r of results) {
            const tag = r.current ? " [current]" : ` [expired ${r.valid_to}]`;
            console.log(`  [${r.direction}] ${r.subject} --${r.predicate}--> ${r.object}${tag}`);
          }
          break;
        }
        case "stats": {
          console.log(JSON.stringify(kg.stats(), null, 2));
          break;
        }
        case "timeline": {
          console.log(JSON.stringify(kg.timeline(args[0] || undefined), null, 2));
          break;
        }
        case "invalidate": {
          const [subject, predicate, object, ended] = args;
          kg.invalidate(subject, predicate, object, ended);
          console.log(`Invalidated: ${subject} --${predicate}--> ${object}`);
          break;
        }
        case "search": {
          const [query] = args;
          if (!query) { console.error("Usage: node knowledge-graph.js search <name>"); process.exit(1); }
          const results = kg.searchEntities(query);
          console.log(`Found ${results.length} entities:`);
          for (const e of results) console.log(`  ${e.name} [${e.type}]`);
          break;
        }
        default:
          console.error("Actions: add | upsert | query | stats | timeline | invalidate | search");
          process.exit(1);
      }
    } finally {
      kg.close();
    }
  };

  run();
}
