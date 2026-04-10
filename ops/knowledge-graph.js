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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
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
    this._db.exec("PRAGMA journal_mode = WAL");
    this._db.exec("PRAGMA foreign_keys = ON");
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
        confidence   REAL DEFAULT 1.0,
        source_id    TEXT,
        source_file  TEXT,
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

  // ── Write operations ──────────────────────────────────────────────────

  /**
   * Add or update an entity node.
   * @param {string} name
   * @param {'person'|'project'|'concept'|'tool'|'unknown'} [type]
   * @param {object} [properties]
   * @returns {string} entity ID
   */
  addEntity(name, type = "unknown", properties = {}) {
    const eid = entityId(name);
    const props = JSON.stringify(properties || {});
    this._db.run(
      "INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)",
      eid, name, type, props
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
    const sid  = entityId(subject);
    const oid  = entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, "_").slice(0, 64);
    const validFrom   = opts.validFrom   || null;
    const validTo     = opts.validTo     || null;
    const confidence  = opts.confidence  ?? 1.0;
    const sourceId    = opts.sourceId     || null;
    const sourceFile  = opts.sourceFile   || null;

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
      `INSERT INTO triples (id,subject,predicate,object,valid_from,valid_to,confidence,source_id,source_file)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      tid, sid, pred, oid, validFrom, validTo, confidence, sourceId, sourceFile
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
    const facts   = record.facts   || [];
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
      if (fact.subject && fact.predicate && fact.object) {
        this.addTriple(fact.subject, fact.predicate, fact.object, {
          confidence: fact.confidence || 1.0,
          sourceId: recordId,
          sourceFile: sourceFile,
        });
      }
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
          ORDER BY t.valid_from ASC NULLS LAST
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
        ORDER BY t.valid_from ASC NULLS LAST
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
    return {
      ok: true,
      id: row.id,
      name: row.name,
      type: row.type,
      properties: JSON.parse(row.properties || "{}"),
      created_at: row.created_at,
    };
  }

  /**
   * Search entities by name (partial match).
   * @param {string} query
   * @returns {object[]}
   */
  searchEntities(query) {
    return this._db
      .all("SELECT * FROM entities WHERE name LIKE ? ORDER BY name LIMIT 20", `%${query}%`)
      .map(row => ({
        id:         row.id,
        name:       row.name,
        type:       row.type,
        properties: JSON.parse(row.properties || "{}"),
      }));
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
            console.error("Usage: node knowledge-graph.js add <subject> <predicate> <object> [--valid-from YYYY-MM-DD]");
            process.exit(1);
          }
          const vfIdx = args.indexOf("--valid-from");
          const validFrom = vfIdx >= 0 ? args[vfIdx + 1] : null;
          const tid = kg.addTriple(subject, predicate, object, { validFrom });
          console.log(`Added: ${subject} --${predicate}--> ${object}  [${tid}]`);
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
          console.error("Actions: add | query | stats | timeline | invalidate | search");
          process.exit(1);
      }
    } finally {
      kg.close();
    }
  };

  run();
}
