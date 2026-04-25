/**
 * ops/adapters/generated/memory-contract-schema.js
 *
 * AUTO-GENERATED — do not edit by hand.
 * Source: ops/adapters/schema-registry.json
 *
 * This file is derived from the canonical schema registry. It provides
 * schema constants for use by ops/memory/memory-contract.js.
 * If this file is missing, memory-contract.js falls back to inline definitions.
 */

"use strict";

// Schema version constants
const MEMORY_RECORD_SCHEMA_VERSION = 2;
const MEMORY_INTEGRITY_CONTRACT_VERSION = 2;

// Required record fields (mirrored in retrieval/schema_validation.py)
const REQUIRED_RECORD_FIELDS = [
  "schemaVersion",
  "id",
  "tool",
  "type",
  "title",
  "source",
  "scope",
  "memory_level"
];

// Allowed enum sets
const ALLOWED_SCOPES = new Set([
  "user",
  "feedback",
  "project",
  "reference",
  "summary",
  "task",
  "run"
]);
const ALLOWED_VISIBILITY = new Set([
  "shared",
  "private"
]);
const ALLOWED_SOURCE_KINDS = new Set([
  "writeback",
  "hook",
  "session",
  "event",
  "blackboard",
  "run",
  "cron",
  "task"
]);
const ALLOWED_MEMORY_LEVELS = new Set([
  "durable",
  "session",
  "event",
  "task"
]);
const ALLOWED_DURABLE_TYPES = new Set([
  "user",
  "feedback",
  "project",
  "reference"
]);
const ALLOWED_TIERS = new Set([
  1,
  2,
  3,
  4,
  5
]);

// Registry metadata
const SCHEMA_REGISTRY_VERSION = 1;
const SCHEMA_REGISTRY_GENERATED_AT = "2026-04-25T04:17:58.984Z";

module.exports = {
  ALLOWED_DURABLE_TYPES,
  ALLOWED_MEMORY_LEVELS,
  ALLOWED_SCOPES,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_TIERS,
  ALLOWED_VISIBILITY,
  MEMORY_INTEGRITY_CONTRACT_VERSION,
  MEMORY_RECORD_SCHEMA_VERSION,
  REQUIRED_RECORD_FIELDS,
  SCHEMA_REGISTRY_GENERATED_AT,
  SCHEMA_REGISTRY_VERSION,
};
