const fs = require("fs");
const path = require("path");

function loadVaultRootHelper() {
  const candidates = [
    // Script-local (installed flat layout: ~/.ai-memory/vault-root.js)
    path.join(__dirname, "vault-root.js"),
    // Sibling bus/ (project layout: ops/ and bus/ are siblings under project root)
    path.join(__dirname, "..", "bus", "vault-root.js"),
    path.join(__dirname, "bus", "vault-root.js"),
    // Bus sibling (installed flat: ~/.ai-memory/bus/vault-root.js)
    path.join(__dirname, "..", "..", "bus", "vault-root.js"),
    // AI_MEMORY_ROOT direct (when AI_MEMORY_ROOT is project root)
    path.join(__dirname, "..", "..", "..", "bus", "vault-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }

  throw new Error(`vault-root-helper-missing: tried ${candidates.join(", ")}`);
}

const { resolveVaultRoot } = loadVaultRootHelper();
const { buildMemoryIntegrityReport } = require("./memory/memory-contract.js");

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    strict: argv.includes("--strict"),
  };
}

function renderHumanSummary(report) {
  const lines = [];
  lines.push(`Integrity status: ${report.status}`);
  lines.push(`Contract version: ${report.contractVersion}`);
  lines.push(`Record schema version: ${report.recordSchemaVersion}`);
  lines.push(`Structured signature: ${report.structuredSignature.hash}`);
  lines.push(`Total records: ${report.totals.recordCount}`);
  lines.push(`Invalid records: ${report.totals.invalidRecordCount}`);
  lines.push(`Malformed lines: ${report.totals.malformedLineCount}`);
  lines.push(`Duplicate ids: ${report.totals.duplicateIdCount}`);

  if (Array.isArray(report.issues) && report.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of report.issues) {
      lines.push(`- ${issue}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const vaultRoot = resolveVaultRoot();
  const aiMemoryRoot = path.join(vaultRoot, "00-System", "ai-memory");
  const report = buildMemoryIntegrityReport({
    structuredRoot: path.join(aiMemoryRoot, "structured"),
    generatedRoot: path.join(aiMemoryRoot, "generated"),
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHumanSummary(report));
  }

  if (parsed.strict && report.status !== "ok") {
    process.exitCode = 1;
  }
}

main();
