const VALUE_OPTIONS = new Map([
  ["--mode", "--mode"],
  ["--top-k", "--top-k"],
  ["--topK", "--top-k"],
  ["--route", "--route"],
  ["--tool", "--tool"],
  ["--project", "--project"],
  ["--scope", "--scope"],
  ["--source-kind", "--source-kind"],
  ["--sourceKind", "--source-kind"],
  ["--workspace", "--workspace"],
  ["--task-state", "--task-state"],
  ["--taskState", "--task-state"],
  ["--mmr-lambda", "--mmr-lambda"],
]);

const BOOLEAN_OPTIONS = new Map([
  ["--json", "--json"],
  ["--prefer-summaries", "--prefer-summaries"],
  ["--preferSummaries", "--prefer-summaries"],
  ["--server", "--server"],
  ["--mmr", "--mmr"],
]);

function parseCliArgs(argv) {
  const state = {
    jsonOnly: false,
    serverMode: false,
    mmr: false,
    mode: "bm25",
    modeExplicit: false,
    topK: 10,
    topKExplicit: false,
    forwardArgs: [],
    queryParts: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [rawName, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const valueOptionName = VALUE_OPTIONS.get(rawName);
    if (valueOptionName) {
      const optionValue = inlineValue !== undefined ? inlineValue : argv[index + 1];
      if (optionValue !== undefined) {
        state.forwardArgs.push(valueOptionName, optionValue);
        if (valueOptionName === "--mode") {
          state.mode = optionValue;
          state.modeExplicit = true;
        }
        if (valueOptionName === "--top-k") {
          state.topK = Number.parseInt(optionValue, 10) || 10;
          state.topKExplicit = true;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }
    }

    const booleanOptionName = BOOLEAN_OPTIONS.get(rawName);
    if (booleanOptionName) {
      if (booleanOptionName === "--json") {
        state.jsonOnly = true;
      } else if (booleanOptionName === "--server") {
        state.serverMode = true;
      } else if (booleanOptionName === "--mmr") {
        state.mmr = true;
        state.forwardArgs.push(booleanOptionName);
      } else {
        state.forwardArgs.push(booleanOptionName);
      }
      continue;
    }

    if (arg === "--") {
      state.queryParts.push(...argv.slice(index + 1));
      break;
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

function buildUsage() {
  return 'Usage: node semantic-search.js [--mode bm25|dense|hybrid] [--route task|mixed|durable|recent|reference|auto] [--tool name] [--source-kind kind] [--top-k N] [--mmr] [--mmr-lambda 0.7] [--json] "query"';
}

function buildPythonSearchArgs({ scriptPath, parsed, query }) {
  if (parsed.serverMode) {
    return [scriptPath, ...parsed.forwardArgs];
  }
  // Auto-upgrade to hybrid when MMR is requested — MMR needs both BM25 and dense scores
  const args = [...parsed.forwardArgs];
  if (parsed.mmr && !parsed.modeExplicit) {
    // Remove any existing --mode so we can override it
    const modeIdx = args.indexOf("--mode");
    if (modeIdx >= 0) args.splice(modeIdx, 2);
    args.unshift("--mode", "hybrid");
  }
  return [scriptPath, ...args, "--json", query];
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

function formatPayloadText(payload) {
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

  return lines.join("\n").trimEnd() + "\n";
}

module.exports = {
  buildPythonSearchArgs,
  buildUsage,
  formatPayloadText,
  formatResult,
  parseCliArgs,
};
