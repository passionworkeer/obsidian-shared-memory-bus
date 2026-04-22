const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildMemoryIntegrityReport } = require("./memory/memory-contract.js");

function loadVaultRootHelper() {
  const candidates = [
    path.join(__dirname, "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
    path.join(__dirname, "bus", "vault-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`vault-root-helper-missing: tried ${candidates.join(", ")}`);
}

function resolveRuntimePath(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
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
  const commandArgs = [];

  if (process.platform === "win32") {
    commandArgs.push("-NoProfile", "-ExecutionPolicy", "Bypass");
  } else {
    commandArgs.push("-NoProfile");
  }

  commandArgs.push("-File", scriptPath, ...args);

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
  return {
    name,
    startedAt,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const { resolveVaultRoot } = loadVaultRootHelper();
const VAULT_ROOT = resolveVaultRoot();
const AI_MEMORY_ROOT = path.join(VAULT_ROOT, "00-System", "ai-memory");
const STRUCTURED_ROOT = path.join(AI_MEMORY_ROOT, "structured");
const GENERATED_ROOT = path.join(AI_MEMORY_ROOT, "generated");
const FORCE = process.argv.includes("--force");

const BUILD_MEMORY_LAYERS_SCRIPT = resolveRuntimePath([
  path.join(__dirname, "build-memory-layers.js"),
  path.join(__dirname, "..", "ops", "build-memory-layers.js"),
]);
const BUILD_HANDOFF_PACK_SCRIPT = resolveRuntimePath([
  path.join(__dirname, "build-handoff-pack.js"),
  path.join(__dirname, "..", "ops", "build-handoff-pack.js"),
]);
const RUN_MEMORY_DREAM_SCRIPT = resolveRuntimePath([
  path.join(__dirname, "run-memory-dream.ps1"),
  path.join(__dirname, "..", "ops", "run-memory-dream.ps1"),
]);

function main() {
  const before = buildMemoryIntegrityReport({
    structuredRoot: STRUCTURED_ROOT,
    generatedRoot: GENERATED_ROOT,
  });
  const beforeProblems = getGeneratedArtifactProblems(before);
  const refreshed = FORCE || beforeProblems.length > 0;
  const steps = [];

  if (refreshed) {
    steps.push(executeStep("build-memory-layers", () => runNodeScript(BUILD_MEMORY_LAYERS_SCRIPT)));
    if (!steps[steps.length - 1].ok) {
      return finish(false, refreshed, before, steps);
    }

    steps.push(executeStep("build-handoff-pack", () => runNodeScript(BUILD_HANDOFF_PACK_SCRIPT)));
    if (!steps[steps.length - 1].ok) {
      return finish(false, refreshed, before, steps);
    }

    steps.push(
      executeStep("run-memory-dream", () => runPowerShellScript(RUN_MEMORY_DREAM_SCRIPT, ["-Force"]))
    );
    if (!steps[steps.length - 1].ok) {
      return finish(false, refreshed, before, steps);
    }
  }

  return finish(true, refreshed, before, steps);
}

function finish(preStepOk, refreshed, before, steps) {
  const after = buildMemoryIntegrityReport({
    structuredRoot: STRUCTURED_ROOT,
    generatedRoot: GENERATED_ROOT,
  });
  const afterProblems = getGeneratedArtifactProblems(after);
  const ok = preStepOk && afterProblems.length === 0;
  const payload = {
    ok,
    refreshed,
    force: FORCE,
    before: summarizeIntegrity(before),
    after: summarizeIntegrity(after),
    beforeProblemCount: getGeneratedArtifactProblems(before).length,
    afterProblemCount: afterProblems.length,
    steps,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main();
