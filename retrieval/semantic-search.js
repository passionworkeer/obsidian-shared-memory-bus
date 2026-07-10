// semantic-search.js
// Usage:
//   node semantic-search.js "query" 5
//   node semantic-search.js --mode hybrid --top-k 8 "query"
//   node semantic-search.js --json --route task --tool openclaw --source-kind blackboard "query"

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPythonSearchArgs,
  buildUsage,
  formatPayloadText,
  parseCliArgs,
} from "./semantic-search-cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..");
const pythonRuntimeHelperPath = fs.existsSync(path.join(__dirname, "python-runtime.js"))
  ? path.join(__dirname, "python-runtime.js")
  : path.join(__dirname, "..", "bus", "python-runtime.js");
const { resolvePythonRuntime, withPythonArgs } = await import(pathToFileURL(pythonRuntimeHelperPath).href);
const PYTHON = resolvePythonRuntime();

function resolveSearchScript() {
  for (const candidate of [
    path.join(__dirname, "semantic_search.py"),
    path.join(RUNTIME_ROOT, "semantic_search.py"),
    path.join(RUNTIME_ROOT, "retrieval", "semantic_search.py"),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(__dirname, "semantic_search.py");
}

const SCRIPT = resolveSearchScript();

function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const query = parsed.queryParts.join(" ").trim();

  if (!query && !parsed.serverMode) {
    console.error(buildUsage());
    process.exit(1);
  }
  if (!PYTHON.available) {
    console.error(`Python runtime unavailable: ${PYTHON.error || "unknown-error"}`);
    process.exit(1);
  }

  const args = buildPythonSearchArgs({ scriptPath: SCRIPT, parsed, query });
  const stdio = parsed.serverMode ? "inherit" : ["ignore", "pipe", "pipe"];
  const child = spawn(PYTHON.command, withPythonArgs(PYTHON, args), {
    stdio,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });

  if (parsed.serverMode) {
    child.on("close", (code) => {
      process.exit(code || 0);
    });
    return;
  }

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.on("close", (code) => {
    if (code !== 0) {
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
      process.exit(code || 1);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      process.stdout.write(stdout);
      process.exit(0);
      return;
    }

    if (parsed.jsonOnly) {
      process.stdout.write(JSON.stringify(payload, null, 2));
      process.exit(0);
      return;
    }

    process.stdout.write(formatPayloadText(payload));
    process.exit(0);
  });
}

main();
