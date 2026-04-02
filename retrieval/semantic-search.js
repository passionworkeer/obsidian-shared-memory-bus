// semantic-search.js
// Usage:
//   node semantic-search.js "query" 5
//   node semantic-search.js --mode hybrid --top-k 8 "query"
//   node semantic-search.js --json --mode dense "query"

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || __dirname;
const { resolvePythonRuntime, withPythonArgs } = require(
  fs.existsSync(path.join(__dirname, "python-runtime.js"))
    ? path.join(__dirname, "python-runtime.js")
    : path.join(__dirname, "..", "bus", "python-runtime.js")
);
const PYTHON = resolvePythonRuntime();
const SCRIPT = path.join(AI_MEMORY_ROOT, "semantic-search.py");

function parseArgs(argv) {
  const state = {
    jsonOnly: false,
    mode: "bm25",
    topK: 10,
    topKExplicit: false,
    queryParts: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      state.jsonOnly = true;
      continue;
    }
    if (arg === "--mode" && argv[index + 1]) {
      state.mode = argv[index + 1];
      index += 1;
      continue;
    }
    if ((arg === "--top-k" || arg === "--topK") && argv[index + 1]) {
      state.topK = Number.parseInt(argv[index + 1], 10) || 10;
      state.topKExplicit = true;
      index += 1;
      continue;
    }
    state.queryParts.push(arg);
  }

  if (!state.topKExplicit && state.queryParts.length >= 2) {
    const maybeTopK = state.queryParts[state.queryParts.length - 1];
    if (/^\d+$/.test(maybeTopK)) {
      state.topK = Number.parseInt(maybeTopK, 10) || 10;
      state.queryParts.pop();
    }
  }

  return state;
}

function formatResult(result) {
  const location = [result.tool, result.project].filter(Boolean).join(" | ") || result.tool || "unknown";
  const sources =
    Array.isArray(result.sources) && result.sources.length > 0 ? ` [${result.sources.join("+")}]` : "";
  return [
    `[${result.rank}] ${location}${result.t ? ` | ${result.t}` : ""}${sources}`,
    `    ${result.title || result.excerpt || result.id}`,
    result.excerpt ? `    ${result.excerpt}` : "",
    `    score=${result.score}${
      result.bm25Score !== null && result.bm25Score !== undefined ? ` bm25=${result.bm25Score}` : ""
    }${result.denseScore !== null && result.denseScore !== undefined ? ` dense=${result.denseScore}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const query = parsed.queryParts.join(" ").trim();

  if (!query) {
    console.error('Usage: node semantic-search.js [--mode bm25|dense|hybrid] [--top-k N] [--json] "query"');
    process.exit(1);
  }
  if (!PYTHON.available) {
    console.error(`Python runtime unavailable: ${PYTHON.error || "unknown-error"}`);
    process.exit(1);
  }

  const args = [SCRIPT, "--mode", parsed.mode, "--top-k", String(parsed.topK), "--json", query];
  const child = spawn(PYTHON.command, withPythonArgs(PYTHON, args), {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
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

    const lines = [];
    lines.push(`Requested mode: ${payload.requestedMode}`);
    lines.push(`Effective mode: ${payload.effectiveMode}`);
    if (payload.fallbackReason) {
      lines.push(`Fallback: ${payload.fallbackReason}`);
    }
    lines.push(`Entries scanned: ${payload.entryCount}`);
    lines.push(`Embeddings available: ${payload.hasEmbeddings ? "yes" : "no"}`);
    lines.push("");

    if (!Array.isArray(payload.results) || payload.results.length === 0) {
      lines.push("No results found.");
    } else {
      for (const result of payload.results) {
        lines.push(formatResult(result));
        lines.push("");
      }
    }

    process.stdout.write(lines.join("\n").trimEnd() + "\n");
    process.exit(0);
  });
}

main();
