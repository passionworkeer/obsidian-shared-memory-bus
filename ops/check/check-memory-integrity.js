import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fallbackStoreRootHelper() {
  return {
    resolveStoreRoot() {
      return (
        process.env.AI_MEMORY_STORE ||
        process.env.AI_MEMORY_STORE_ROOT ||
        process.env.AI_MEMORY_ROOT ||
        path.join(os.homedir(), ".ai-memory")
      );
    },
  };
}

function loadStoreRootHelper() {
  const candidates = [
    // Script-local (installed flat layout: ~/.ai-memory/store-root.js)
    path.join(__dirname, "store-root.js"),
    // Bus sibling (project layout: ops/check -> ../../bus/)
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    // Sibling bus/ (project layout: ops/ and bus/ are siblings under project root)
    path.join(__dirname, "..", "bus", "store-root.js"),
    path.join(__dirname, "bus", "store-root.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }

  return fallbackStoreRootHelper();
}

const storeRootModule = await loadStoreRootHelper();
const { resolveStoreRoot } = storeRootModule.default || storeRootModule;
const memoryContractModule = await import("../memory/memory-contract.js");
const { buildMemoryIntegrityReport } = memoryContractModule;

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
  const storeRoot = resolveStoreRoot();
  const report = buildMemoryIntegrityReport({
    structuredRoot: path.join(storeRoot, "structured"),
    generatedRoot: path.join(storeRoot, "generated"),
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
