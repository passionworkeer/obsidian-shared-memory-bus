// ops/knowledge/knowledge-graph/methods.js
//
// Query methods for KnowledgeGraph, attached to the prototype via Object.assign.
// Keeping these separate from class-core.js lets the class definition stay
// focused on lifecycle and write operations while this file handles read paths.

import { entityId } from "./db.js";

/**
 * Get all relationships for an entity.
 *
 * @param {string} name
 * @param {{ asOf?: string, direction?: 'outgoing'|'incoming'|'both' }} [opts]
 * @returns {object[]}
 */
function queryEntity(name, opts = {}) {
  const eid       = entityId(name);
  const direction = opts.direction || "outgoing";
  const asOf      = opts.asOf      || null;

  /** @type {object[]} */
  const results = [];

  /**
   * @param {'outgoing'|'incoming'} dir
   * @param {string} sql
   * @param {any[]} params
   * @param {string} _otherCol
   */
  const runQuery = (dir, sql, params, _otherCol) => {
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
function queryRelationship(predicate, opts = {}) {
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
function timeline(name) {
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

/** @returns {{ entities: number, triples: number, currentFacts: number,
 *             expiredFacts: number, relationshipTypes: string[] }} */
function stats() {
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
function getEntity(name) {
  const row = this._db.get("SELECT * FROM entities WHERE id = ?", entityId(name));
  if (!row) return null;
  let props = {};
  try { props = JSON.parse(row.properties || "{}"); } catch { /* corrupt — use {} */ }
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
function searchEntities(query, opts = {}) {
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
      try { props = JSON.parse(row.properties || "{}"); } catch { /* corrupt */ }
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
function getEntitiesByType(type) {
  return this._db
    .all("SELECT * FROM entities WHERE type = ? ORDER BY name", type)
    .map((row) => {
      let props = {};
      try { props = JSON.parse(row.properties || "{}"); } catch { /* corrupt */ }
      return {
        id:         row.id,
        name:       row.name,
        type:       row.type,
        properties: props,
        created_at: row.created_at,
      };
    });
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
function queryCurrentTriples({ entityName = "", validAt = null, limit = 50 } = {}) {
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

// ---------------------------------------------------------------------------
// Attach all query methods to the KnowledgeGraph prototype.
// Imported lazily by ./knowledge-graph.js so this file stays free of cycles.
// ---------------------------------------------------------------------------

export function attachQueryMethods(KnowledgeGraphClass) {
  Object.assign(KnowledgeGraphClass.prototype, {
    queryEntity,
    queryRelationship,
    timeline,
    stats,
    getEntity,
    searchEntities,
    getEntitiesByType,
    queryCurrentTriples,
  });
}