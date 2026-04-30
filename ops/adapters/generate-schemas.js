#!/usr/bin/env node
/**
 * generate-schemas.js
 *
 * Reads ops/adapters/schema-registry.json (the source of truth) and generates
 * derived schema modules for both runtimes:
 *   - ops/adapters/generated/memory-contract-schema.js   (Node.js)
 *   - ops/adapters/generated/schema-validation-py.py     (Python)
 *
 * Usage:
 *   node ops/adapters/generate-schemas.js --output node    Generate JS schema
 *   node ops/adapters/generate-schemas.js --output python  Generate Python schema
 *   node ops/adapters/generate-schemas.js --check          Verify consistency (CI gate)
 *
 * The generated files are committed to git so CI can detect drift.
 * Run with --check to confirm generated output matches the registry.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REGISTRY_PATH = path.join(__dirname, "schema-registry.json");
const OUTPUT_DIR = path.join(__dirname, "generated");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outputMode = args.includes("--check") ? "check" : args.includes("--output") ? args[args.indexOf("--output") + 1] : null;

if (!outputMode) {
  console.error("Usage: node generate-schemas.js [--output node|python|--check]");
  process.exit(1);
}

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
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate Node.js schema module (memory-contract-schema.js)
 */
function generateNodeSchema(registry) {
  const memoryRecord = registry.schemas["memory-record-v2"];
  const promotion = registry.schemas["promotion-metadata-v1"];
  const integrity = registry.schemas["integrity-contract-v2"];

  const scopes = memoryRecord.enums.scope.allowed;
  const visibility = memoryRecord.enums.visibility.allowed;
  const sourceKinds = memoryRecord.enums.sourceKind.allowed;
  const memoryLevels = memoryRecord.enums.memory_level.allowed;
  const durableTypes = promotion.enums.durable_type.allowed;
  const tiers = memoryRecord.enums.tier.allowed;
  const requiredFields = memoryRecord.required;

  return `/**
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
const MEMORY_RECORD_SCHEMA_VERSION = ${memoryRecord.version};
const MEMORY_INTEGRITY_CONTRACT_VERSION = ${integrity.version};

// Required record fields (mirrored in retrieval/schema_validation.py)
const REQUIRED_RECORD_FIELDS = ${JSON.stringify(requiredFields, null, 2)};

// Allowed enum sets
const ALLOWED_SCOPES = new Set(${JSON.stringify(scopes, null, 2)});
const ALLOWED_VISIBILITY = new Set(${JSON.stringify(visibility, null, 2)});
const ALLOWED_SOURCE_KINDS = new Set(${JSON.stringify(sourceKinds, null, 2)});
const ALLOWED_MEMORY_LEVELS = new Set(${JSON.stringify(memoryLevels, null, 2)});
const ALLOWED_DURABLE_TYPES = new Set(${JSON.stringify(durableTypes, null, 2)});
const ALLOWED_TIERS = new Set(${JSON.stringify(tiers, null, 2)});

// Registry metadata
const SCHEMA_REGISTRY_VERSION = ${registry.version};
// SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time

export {
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
`;
}

/**
 * Generate Python schema validation module (schema-validation-py.py)
 */
function generatePythonSchema(registry) {
  const memoryRecord = registry.schemas["memory-record-v2"];
  const promotion = registry.schemas["promotion-metadata-v1"];
  const integrity = registry.schemas["integrity-contract-v2"];

  const scopes = memoryRecord.enums.scope.allowed;
  const visibility = memoryRecord.enums.visibility.allowed;
  const sourceKinds = memoryRecord.enums.sourceKind.allowed;
  const memoryLevels = memoryRecord.enums.memory_level.allowed;
  const durableTypes = promotion.enums.durable_type.allowed;
  const tiers = memoryRecord.enums.tier.allowed;
  const requiredFields = memoryRecord.required;

  const scopesStr = _pythonReprSet(scopes);
  const visibilityStr = _pythonReprSet(visibility);
  const sourceKindsStr = _pythonReprSet(sourceKinds);
  const memoryLevelsStr = _pythonReprSet(memoryLevels);
  const durableTypesStr = _pythonReprSet(durableTypes);
  const tiersStr = _pythonReprList(tiers);
  const requiredFieldsStr = _pythonReprList(requiredFields);

  return `"""
ops/adapters/generated/schema-validation-py.py

AUTO-GENERATED — do not edit by hand.
Source: ops/adapters/schema-registry.json

This file is derived from the canonical schema registry. It provides
schema constants for use by retrieval/schema_validation.py.
If this file is missing, schema_validation.py falls back to inline definitions.
"""

from __future__ import annotations

# Schema version constants matching memory-contract.js
MEMORY_RECORD_SCHEMA_VERSION: int = ${memoryRecord.version}
MEMORY_INTEGRITY_CONTRACT_VERSION: int = ${integrity.version}

# Allowed values matching the Node.js constants
ALLOWED_SCOPES: set = ${scopesStr}
ALLOWED_VISIBILITY: set = ${visibilityStr}
ALLOWED_SOURCE_KINDS: set = ${sourceKindsStr}
ALLOWED_MEMORY_LEVELS: set = ${memoryLevelsStr}
ALLOWED_DURABLE_TYPES: set = ${durableTypesStr}

# Required fields for structured memory layers (mirrored in memory-contract.js)
REQUIRED_FIELDS: list = ${requiredFieldsStr}

# 5-tier system (ADR-002 v2)
ALLOWED_TIERS: list = ${tiersStr}

# Registry metadata
SCHEMA_REGISTRY_VERSION: int = ${registry.version}
# SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _pythonReprSet(arr) {
  return `{\n    "${arr.join('",\n    "')}",\n}`;
}

function _pythonReprList(arr) {
  const items = arr.map((v) => (typeof v === "number" ? String(v) : `"${v}"`)).join(",\n    ");
  return `[\n    ${items},\n]`;
}

// ---------------------------------------------------------------------------
// Write generated files
// ---------------------------------------------------------------------------

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeGenerated(filename, content) {
  ensureOutputDir();
  const filePath = path.join(OUTPUT_DIR, filename);
  // Substitute generation timestamp placeholder so generated files are stable
  // across runs (only SCHEMA_REGISTRY_GENERATED_AT differs, everything else must be fixed)
  let stableContent = content;
  if (filename.endsWith(".py")) {
    stableContent = stableContent.replace(
      "# SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time",
      `SCHEMA_REGISTRY_GENERATED_AT: str = "${new Date().toISOString()}"`
    );
  } else {
    stableContent = stableContent.replace(
      "// SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time",
      `const SCHEMA_REGISTRY_GENERATED_AT = "${new Date().toISOString()}";`
    );
  }
  fs.writeFileSync(filePath, stableContent, "utf8");
  console.log(`  [generate] wrote ${filePath}`);
}

// ---------------------------------------------------------------------------
// Check mode — compare generated files against registry
// ---------------------------------------------------------------------------

function normalizeForComparison(content, isPython) {
  // Strip timestamps so that generated files are stable for comparison.
  // Both the on-disk file and the template use timestamps at write time,
  // so we remove both before comparing to avoid false drift.
  let c = content.replace(/\r\n/g, "\n");
  if (isPython) {
    c = c.replace(/^SCHEMA_REGISTRY_GENERATED_AT: str = "[^"]*"$/m,
      "# SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time");
  } else {
    c = c.replace(/^const SCHEMA_REGISTRY_GENERATED_AT = "[^"]*";$/m,
      "// SCHEMA_REGISTRY_GENERATED_AT: filled by generate-schemas.js at write time");
  }
  return c;
}

function runCheck() {
  const issues = [];

  // Check that generated files exist
  const jsPath = path.join(OUTPUT_DIR, "memory-contract-schema.js");
  const pyPath = path.join(OUTPUT_DIR, "schema-validation-py.py");

  if (!fs.existsSync(jsPath)) {
    issues.push(`MISSING: ${jsPath} (run with --output node first)`);
  }
  if (!fs.existsSync(pyPath)) {
    issues.push(`MISSING: ${pyPath} (run with --output python first)`);
  }

  if (issues.length > 0) {
    console.error("Schema sync check FAILED:");
    issues.forEach((i) => console.error("  " + i));
    process.exit(1);
  }

  // Regenerate and compare (normalize timestamps so they never cause false drift)
  const expectedJs = generateNodeSchema(registry);
  const expectedPy = generatePythonSchema(registry);

  const actualJs = fs.readFileSync(jsPath, "utf8");
  const actualPy = fs.readFileSync(pyPath, "utf8");

  if (normalizeForComparison(actualJs, false) !== expectedJs) {
    issues.push(`JS schema drift detected: ${jsPath} is out of sync with schema-registry.json\n  Run: node ops/adapters/generate-schemas.js --output node`);
  }

  if (normalizeForComparison(actualPy, true) !== expectedPy) {
    issues.push(`Python schema drift detected: ${pyPath} is out of sync with schema-registry.json\n  Run: node ops/adapters/generate-schemas.js --output python`);
  }

  if (issues.length > 0) {
    console.error("Schema sync check FAILED — drift detected:");
    issues.forEach((i) => console.error("  " + i));
    process.exit(1);
  }

  console.log("Schema sync check PASSED — all generated files match registry.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  switch (outputMode) {
  case "check":
    runCheck();
    break;

  case "node":
    writeGenerated("memory-contract-schema.js", generateNodeSchema(registry));
    console.log("Node.js schema generated successfully.");
    break;

  case "python":
    writeGenerated("schema-validation-py.py", generatePythonSchema(registry));
    console.log("Python schema generated successfully.");
    break;

  default:
    console.error(`Unknown output mode: ${outputMode}. Use --output node, --output python, or --check.`);
    process.exit(1);
  }
}

main();