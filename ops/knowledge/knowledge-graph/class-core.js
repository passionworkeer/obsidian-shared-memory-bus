// ops/knowledge/knowledge-graph/class-core.js
//
// KnowledgeGraph class shell, lifecycle (constructor, init, close,
// batch transaction support), and write operations (addEntity, addTriple,
// seedEntities, invalidate, ingestRecord, upsertTriple, incrementConfidence).
// Query methods are attached to the prototype in ./methods.js.

import fs from "node:fs";
import path from "node:path";
import { Db, entityId, today, tripleId } from "./db.js";

export class KnowledgeGraph {
  /**
   * @param {{ dbPath?: string, vaultRoot?: string, storeRoot?: string }} [opts]
   */
  constructor(opts = {}) {
    // vaultRoot kept for backward compat but now treated as store root
    this.dbPath = opts.dbPath || path.join(opts.storeRoot || opts.vaultRoot || "", "kg", "knowledge-graph.sqlite3");
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
      } catch {
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