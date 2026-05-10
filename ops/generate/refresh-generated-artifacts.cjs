"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { fileURLToPath } = require("url");
const { pathToFileURL } = require("url");

// __dirname for CJS
// __dirname for CJS — available natively in CommonJS scope
// (CJS provides __dirname automatically)

// Helper for ESM module imports
function toFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

// memory-contract.js is ESM with top-level await — must use toFileUrl
function loadMemoryContractHelper() {
  const candidates = [
    path.join(__dirname, "memory-contract.js"),
    path.join(__dirname, "..", "memory", "memory-contract.js"),
    path.join(__dirname, "memory", "memory-contract.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(toFileUrl(candidate));
    }
  }
  throw new Error(`memory-contract-helper-missing: tried ${candidates.join(", ")}`);
}

function resolveRuntimePath(candidates) {
  // Search in: project root (where package.json lives), and key subdirectories
  const projectRoot = path.join(__dirname, "..", "..");
  const searchRoots = [
    process.cwd(),
    projectRoot,
    path.join(projectRoot, "ops", "build"),
    path.join(projectRoot, "ops", "run"),
  ];
  for (const root of searchRoots) {
    for (const candidate of candidates) {
      const absPath = path.join(root, candidate);
      if (fs.existsSync(absPath)) {
        return absPath;
      }
    }
  }
  throw new Error(`runtime-script-missing: tried ${candidates.join(", ")}`);
}

function resolvePowerShellExecutable() {
  if (process.env.AI_MEMORY_PWSH && process.env.AI_MEMORY_PWSH.trim()) {
    return process.env.AI_MEMORY_PWSH.trim();
  }
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function summarizeOutput(value) {
  return String(value || "").trim();
}

function summarizeIntegrity(report) {
  const generatedArtifacts = {};
  for (const [key, artifact] of Object.entries(report.generatedArtifacts || {})) {
    generatedArtifacts[key] = {
      exists: Boolean(artifact.exists),
      status: String(artifact.status || ""),
      alignmentReason: String(artifact.alignmentReason || ""),
      missingSourceStructuredSignature: Boolean(artifact.missingSourceStructuredSignature),
      contractAligned: artifact.contractAligned !== false,
      recordSchemaAligned: artifact.recordSchemaAligned !== false,
    };
  }
  return {
    status: String(report.status || ""),
    issues: Array.isArray(report.issues) ? report.issues : [],
    structuredSignature: report.structuredSignature || null,
    generatedArtifacts,
  };
}

function getGeneratedArtifactProblems(report) {
  const problems = [];
  for (const [key, artifact] of Object.entries(report.generatedArtifacts || {})) {
    if (!artifact.exists) {
      problems.push(`${key}:missing`);
      continue;
    }
    if (artifact.status === "stale" || artifact.status === "error") {
      problems.push(`${key}:${artifact.status}`);
    }
    if (artifact.missingSourceStructuredSignature) {
      problems.push(`${key}:missing-source-signature`);
    }
    if (artifact.contractAligned === false) {
      problems.push(`${key}:contract-mismatch`);
    }
    if (artifact.recordSchemaAligned === false) {
      problems.push(`${key}:record-schema-mismatch`);
    }
  }
  return problems;
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    exitCode: result.status,
    stdout: summarizeOutput(result.stdout),
    stderr: summarizeOutput(result.stderr || (result.error ? result.error.message : "")),
  };
}

function runPowerShellScript(scriptPath, args = []) {
  const executable = resolvePowerShellExecutable();
  const commandArgs = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args]
    : ["-NoProfile", "-File", scriptPath, ...args];
  const result = spawnSync(executable, commandArgs, {
    cwd: path.dirname(scriptPath),
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    exitCode: result.status,
    stdout: summarizeOutput(result.stdout),
    stderr: summarizeOutput(result.stderr || (result.error ? result.error.message : "")),
  };
}

function executeStep(name, runner) {
  const startedAt = new Date().toISOString();
  const result = runner();
  return { name, startedAt, ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function main() {
  // Load memory-contract (ESM with top-level await) via toFileUrl
  const mcModule = await loadMemoryContractHelper();
  const buildMemoryIntegrityReport = mcModule.buildMemoryIntegrityReport;

  // vault-root.cjs is pure CJS — require it by absolute path
  const vaultRootPath = path.join(__dirname, "..", "..", "bus", "vault-root.cjs");
  const { resolveVaultRoot } = require(vaultRootPath);
  const STORE_ROOT = resolveVaultRoot();
  const STRUCTURED_ROOT = path.join(STORE_ROOT, "structured");
  const GENERATED_ROOT = path.join(STORE_ROOT, "generated");
  const FORCE = process.argv.includes("--force");

  const BUILD_MEMORY_LAYERS_SCRIPT = resolveRuntimePath([
    "build-memory-layers.js",
  ]);
  const BUILD_HANDOFF_PACK_SCRIPT = resolveRuntimePath([
    "build-handoff-pack.js",
  ]);
  const RUN_MEMORY_DREAM_SCRIPT = resolveRuntimePath([
    "run-memory-dream.ps1",
  ]);

  const before = buildMemoryIntegrityReport({ structuredRoot: STRUCTURED_ROOT, generatedRoot: GENERATED_ROOT });
  const beforeProblems = getGeneratedArtifactProblems(before);
  const refreshed = FORCE || beforeProblems.length > 0;
  const steps = [];

  if (refreshed) {
    steps.push(executeStep("build-memory-layers", () => runNodeScript(BUILD_MEMORY_LAYERS_SCRIPT)));
    if (!steps[steps.length - 1].ok) return finish(false, refreshed, before, steps, buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT);

    steps.push(executeStep("build-handoff-pack", () => runNodeScript(BUILD_HANDOFF_PACK_SCRIPT)));
    if (!steps[steps.length - 1].ok) return finish(false, refreshed, before, steps, buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT);

    steps.push(executeStep("run-memory-dream", () => runPowerShellScript(RUN_MEMORY_DREAM_SCRIPT, ["-Force"])));
    if (!steps[steps.length - 1].ok) return finish(false, refreshed, before, steps, buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT);
  }

  return finish(true, refreshed, before, steps, buildMemoryIntegrityReport, STRUCTURED_ROOT, GENERATED_ROOT);
}

function finish(preStepOk, refreshed, before, steps, buildMemoryIntegrityReport, structuredRoot, generatedRoot) {
  const after = buildMemoryIntegrityReport({ structuredRoot, generatedRoot });
  const afterProblems = getGeneratedArtifactProblems(after);
  const ok = preStepOk && afterProblems.length === 0;
  const payload = {
    ok,
    refreshed,
    force: process.argv.includes("--force"),
    before: summarizeIntegrity(before),
    after: summarizeIntegrity(after),
    beforeProblemCount: getGeneratedArtifactProblems(before).length,
    afterProblemCount: afterProblems.length,
    steps,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
