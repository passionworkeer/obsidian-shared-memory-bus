#!/usr/bin/env node
/**
 * ops/adapters/migrate-schema.js
 *
 * Migration functions between schema versions.
 *
 * Usage:
 *   node ops/adapters/migrate-schema.js --dry-run   Show migration paths
 *   node ops/adapters/migrate-schema.js             Migrate record (reads JSON from stdin)
 *
 * Exports:
 *   migrateRecordFromV1ToV2(record)  — migrate memory record v1 → v2
 *   migrateRecordFromV2ToV3(record)  — placeholder for future v2 → v3
 *   migrateEmbeddingFromV0ToV1(vector) — migrate embedding v0 → v1
 *   listMigrationPaths()             — return available migration paths
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGISTRY_PATH = path.join(__dirname, "schema-registry.json");

// ---------------------------------------------------------------------------
// Load registry
// ---------------------------------------------------------------------------

let registry;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
} catch (err) {
  console.error(`Failed to load schema registry: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Migration: memory-record-v1 → v2
// ---------------------------------------------------------------------------

/**
 * Migrate a memory record from v1 schema to v2 schema.
 *
 * Key changes from v1 to v2:
 *   - schemaVersion: set to 2
 *   - tombstone field: REMOVED (replaced by lifecycle.archived + archive-manifest.jsonl)
 *   - lifecycle.archived: ADDED (value derived from tombstone if present)
 *
 * @param {object} record - Source record (may have schemaVersion=1 or absent)
 * @returns {object} - Migrated record (new object, source unchanged)
 */
function migrateRecordFromV1ToV2(record) {
  if (!record || typeof record !== "object") {
    throw new Error("migrate-record-from-v1-to-v2: source record must be a plain object");
  }

  // Already at v2 or later — no-op
  if (record.schemaVersion === 2) {
    return { ...record };
  }

  const migrated = { ...record };

  // Update schema version
  migrated.schemaVersion = 2;

  // Migrate tombstone → lifecycle.archived
  if ("tombstone" in migrated) {
    migrated.lifecycle = { archived: Boolean(migrated.tombstone) };
    delete migrated.tombstone;
  } else {
    // Ensure lifecycle exists even without tombstone
    migrated.lifecycle = migrated.lifecycle && typeof migrated.lifecycle === "object"
      ? { ...migrated.lifecycle }
      : {};
  }

  // Remove any v1-only fields that don't exist in v2
  // (none currently known, but this hook allows future cleanup)

  return migrated;
}

// ---------------------------------------------------------------------------
// Migration: memory-record-v2 → v3 (placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder for future v2 → v3 migration.
 * v3 schema is not yet defined; throws to avoid silent no-op on user data.
 *
 * @param {object} record
 * @returns {object} - Never returns; throws until v3 schema is defined.
 * @throws {Error} Always — v3 migration is not implemented.
 */
function migrateRecordFromV2ToV3(record) {
  if (!record || typeof record !== "object") {
    throw new Error("migrate-record-from-v2-to-v3: source record must be a plain object");
  }
  throw new Error(
    "migrate-record-from-v2-to-v3: v3 schema is not yet defined — see docs/PROJECT_AUDIT_*.md §I-MED-1",
  );
}

// ---------------------------------------------------------------------------
// Migration: embedding-vector-v0 → v1
// ---------------------------------------------------------------------------

/**
 * Migrate an embedding vector from v0 to v1.
 *
 * v1 changes:
 *   - version: set to 1
 *   - dimensions: computed from len(vector) if not present
 *   - createdAt: set to current ISO timestamp if not present
 *
 * @param {object} vector - Source embedding (version 0 or absent)
 * @returns {object} - Migrated embedding (new object, source unchanged)
 */
function migrateEmbeddingFromV0ToV1(vector) {
  if (!vector || typeof vector !== "object") {
    throw new Error("migrate-embedding-from-v0-to-v1: source vector must be a plain object");
  }

  // Already at v1 or later — no-op
  if (vector.version === 1) {
    return { ...vector };
  }

  const migrated = { ...vector };

  migrated.version = 1;

  if (!migrated.dimensions && Array.isArray(migrated.vector)) {
    migrated.dimensions = migrated.vector.length;
  }

  if (!migrated.createdAt) {
    migrated.createdAt = new Date().toISOString();
  }

  return migrated;
}

// ---------------------------------------------------------------------------
// Registry introspection
// ---------------------------------------------------------------------------

/**
 * Return a list of available migration paths from the registry.
 * @returns {Array<{from, to, description}>}
 */
function listMigrationPaths() {
  return Object.entries(registry.migrationPaths || {}).map(([key, path]) => ({
    from: key.split("→")[0],
    to: key.split("→")[1],
    description: path.description,
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--dry-run")) {
  console.log("Available migration paths:");
  for (const migration of listMigrationPaths()) {
    console.log(`  ${migration.from} → ${migration.to}`);
    console.log(`    ${migration.description}`);
    console.log("");
  }
  process.exit(0);
}

// Read JSON from stdin and migrate
let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8").trim());
} catch {
  console.error("Usage: echo '{...}' | node migrate-schema.js");
  console.error("Or:    node migrate-schema.js --dry-run");
  process.exit(1);
}

let migrated;
if (input.embedding && !input.schemaVersion) {
  migrated = migrateEmbeddingFromV0ToV1(input);
} else if (input.schemaVersion === 1) {
  migrated = migrateRecordFromV1ToV2(input);
} else if (input.schemaVersion === 2) {
  migrated = migrateRecordFromV2ToV3(input);
} else {
  console.error(`Unknown schema version: ${input.schemaVersion}`);
  process.exit(1);
}

console.log(JSON.stringify(migrated, null, 2));

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  migrateEmbeddingFromV0ToV1,
  migrateRecordFromV1ToV2,
  migrateRecordFromV2ToV3,
  listMigrationPaths,
};