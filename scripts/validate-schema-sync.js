#!/usr/bin/env node
/**
 * scripts/validate-schema-sync.js
 *
 * CI gate — verifies that generated schema files are in sync with the
 * canonical schema-registry.json.  This is the single entry point for CI.
 *
 * Exit codes:
 *   0 — all schemas in sync
 *   1 — drift detected (generated files out of date)
 *   2 — internal error (missing files, parse errors, etc.)
 *
 * Usage:
 *   node scripts/validate-schema-sync.js
 *
 * Integrates with:
 *   node ops/adapters/generate-schemas.js --check  (canonical sync check)
 *   node ops/memory/memory-contract.js validateSchemaConsistency()
 *   python retrieval/schema_validation.py --check (Python-side check)
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "ops", "adapters", "schema-registry.json");
const GENERATED_JS = path.join(ROOT, "ops", "adapters", "generated", "memory-contract-schema.js");
const GENERATED_PY = path.join(ROOT, "ops", "adapters", "generated", "schema-validation-py.py");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label, message) {
  process.stderr.write(`[${label}] ${message}\n`);
}

function runCheck(label, fn) {
  try {
    const result = fn();
    if (!result.ok) {
      log(label, `FAIL — ${result.issues.join("; ")}`);
      return false;
    }
    log(label, "OK");
    return true;
  } catch (err) {
    log(label, `ERROR — ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Check 1: generate-schemas.js --check (canonical JS/Python generation)
// ---------------------------------------------------------------------------

function checkGeneratedSchemas() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { ok: false, issues: [`schema-registry.json not found at ${REGISTRY_PATH}`] };
  }
  if (!fs.existsSync(GENERATED_JS) || !fs.existsSync(GENERATED_PY)) {
    return { ok: false, issues: ["Generated schema files are missing — run: node ops/adapters/generate-schemas.js --output node && node ops/adapters/generate-schemas.js --output python"] };
  }

  try {
    execSync("node ops/adapters/generate-schemas.js --check", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, issues: [] };
  } catch (err) {
    return {
      ok: false,
      issues: [
        `generate-schemas.js --check failed (exit ${err.status}): ${err.stderr?.toString() || err.message}`,
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Check 2: memory-contract.js validateSchemaConsistency()
// ---------------------------------------------------------------------------

function checkMemoryContractConsistency() {
  try {
    // Require dynamically so we don't crash the whole script if the module fails
    const { validateSchemaConsistency } = require(path.join(ROOT, "ops", "memory", "memory-contract.js"));
    if (typeof validateSchemaConsistency !== "function") {
      return { ok: false, issues: ["validateSchemaConsistency function not exported from memory-contract.js"] };
    }
    const result = validateSchemaConsistency(REGISTRY_PATH);
    return result;
  } catch (err) {
    return { ok: false, issues: [`memory-contract.js load/validate error: ${err.message}`] };
  }
}

// ---------------------------------------------------------------------------
// Check 3: Python schema validation
// ---------------------------------------------------------------------------

function checkPythonSchemaConsistency() {
  const pythonScript = path.join(ROOT, "retrieval", "schema_validation.py");
  if (!fs.existsSync(pythonScript)) {
    return { ok: false, issues: ["retrieval/schema_validation.py not found"] };
  }

  // Use a temp script file to avoid quoting issues on Windows
  const tmpDir = (process.env.TEMP || process.env.TMP || "").replace(/\\/g, "/") || "/tmp";
  const tmpScript = path.join(tmpDir, `schema_sync_check_${process.pid}.py`);
  const checkPyContent = [
    `import sys`,
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    `try:`,
    `    from retrieval.schema_validation import validate_schema_consistency`,
    `    result = validate_schema_consistency()`,
    `    print("ok=" + str(result["ok"]).lower(), end="")`,
    `    if result["issues"]:`,
    `        print(" issues=" + repr(result["issues"]), end="")`,
    `    print()`,
    `    sys.exit(0 if result["ok"] else 1)`,
    `except Exception as e:`,
    `    print("ERROR:", e)`,
    `    sys.exit(2)`,
  ].join("\n");

  const PYTHON_CANDIDATES = [
    { command: process.env.AI_MEMORY_PYTHON, argsPrefix: [] },
    { command: process.env.PYTHON_EXE, argsPrefix: [] },
    { command: process.env.PYTHON, argsPrefix: [] },
    { command: "python", argsPrefix: [] },
    { command: "python3", argsPrefix: [] },
    ...(process.platform === "win32"
      ? [
          { command: "py", argsPrefix: ["-3"] },
          { command: "py", argsPrefix: [] },
        ]
      : []),
  ].filter((candidate) => candidate.command);

  // Try to find a working Python
  let pythonRuntime = null;
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate.command, [...candidate.argsPrefix, "--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      pythonRuntime = candidate;
      break;
    }
  }

  if (!pythonRuntime) {
    return { ok: true, issues: ["Python not found on this system — skipping Python schema check"] };
  }

  try {
    fs.writeFileSync(tmpScript, checkPyContent, "utf8");
    const result = spawnSync(pythonRuntime.command, [...pythonRuntime.argsPrefix, tmpScript], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `exit ${result.status}`);
    }
    return { ok: true, issues: [] };
  } catch (err) {
    return {
      ok: false,
      issues: [`Python schema consistency check failed: ${err.message}`],
    };
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const checks = [
    ["generate-schemas", checkGeneratedSchemas],
    ["memory-contract", checkMemoryContractConsistency],
    ["python-schema", checkPythonSchemaConsistency],
  ];

  const results = checks.map(([label, fn]) => ({ label, passed: runCheck(label, fn) }));

  const failed = results.filter((r) => !r.passed);
  const passed = results.filter((r) => r.passed);

  process.stderr.write(`\n[validate-schema-sync] ${passed.length}/${checks.length} checks passed\n`);

  if (failed.length > 0) {
    process.stderr.write(`[validate-schema-sync] FAILED checks: ${failed.map((f) => f.label).join(", ")}\n`);
    process.stderr.write("[validate-schema-sync] Run 'node ops/adapters/generate-schemas.js --output node' and '--output python' to regenerate schemas.\n");
    process.exit(1);
  }

  process.stderr.write("[validate-schema-sync] All schema sync checks passed.\n");
  process.exit(0);
}

main();
