import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Look up the CLI version by reading the nearest package.json.
 * Tries AI_MEMORY_ROOT/package.json first (installed layout), then
 * cli/package.json (project layout / symlinked install).
 *
 * @returns {string}
 */
export function getVersion() {
  for (const pkgPath of [
    path.join(process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..", ".."), "package.json"),
    path.join(__dirname, "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const COMMANDS = {
  // Bus commands
  "bus:sync": {
    desc: "Sync all sources into shared memory",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "SyncAll"],
  },
  "bus:generate": {
    desc: "Regenerate memory summaries (layers, handoff, dream)",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "Generate"],
  },
  "bus:status": {
    desc: "Show what's in shared memory right now",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "Status"],
  },

  // Dream commands
  "dream:run": {
    desc: "Consolidate memory into long-term summaries",
    category: "Dream",
    ps: "ops/run/run-memory-dream.ps1",
    args: [],
  },
  "dream:dry-run": {
    desc: "Dry-run dream consolidation",
    category: "Dream",
    ps: "ops/run/run-memory-dream.ps1",
    args: ["-DryRun"],
  },
  "dream:writeback": {
    desc: "Dream consolidation with writeback",
    category: "Dream",
    ps: "ops/run/run-memory-dream.ps1",
    args: ["-Writeback"],
  },

  // Embeddings commands
  "embeddings:build": {
    desc: "Rebuild the search index",
    category: "Embeddings",
    js: "bus/generate-embeddings.js",
    args: [],
  },
  "embeddings:status": {
    desc: "Check if search index is healthy",
    category: "Embeddings",
    js: "ops/check/check-memory-integrity.js",
    args: ["--json"],
  },
  "embeddings:force": {
    desc: "Force rebuild the search index",
    category: "Embeddings",
    js: "bus/generate-embeddings.js",
    args: ["--force"],
  },

  // Layer commands
  "layers:build": {
    desc: "Build memory layers",
    category: "Layers",
    js: "ops/build/build-memory-layers.js",
    args: [],
  },

  // Handoff commands
  "handoff:build": {
    desc: "Build handoff pack",
    category: "Handoff",
    js: "ops/build/build-handoff-pack.js",
    args: [],
  },

  // Hygiene commands
  "hygiene:report": {
    desc: "Generate memory hygiene report",
    category: "Hygiene",
    js: "ops/generate/generate-memory-hygiene-report.js",
    args: ["--json"],
  },

  // MCP commands
  "mcp:start": {
    desc: "Start the shared memory service",
    category: "MCP",
    ps: "shared-mcp/start-default-shared-mcp.ps1",
    args: [],
  },
  "mcp:status": {
    desc: "Check if shared memory service is running",
    category: "MCP",
    ps: "shared-mcp/status-shared-mcp.ps1",
    args: ["--human"],
  },
  "mcp:stop": {
    desc: "Stop the shared memory service",
    category: "MCP",
    ps: "shared-mcp/stop-shared-mcp.ps1",
    args: [],
  },

  // Search command (direct, no MCP round-trip)
  "search": {
    desc: "Search shared memory",
    category: "Search",
    js: "retrieval/semantic-search.js",
    args: ["--mode", "hybrid"],
  },

  // Integrity
  "check": {
    desc: "Validate memory integrity",
    category: "Integrity",
    js: "ops/check/check-memory-integrity.js",
    args: [],
  },

  // Diagnose
  "doctor": {
    desc: "Diagnose common setup problems",
    category: "Diagnose",
    js: "cli/ai-memory.js",
    args: ["--doctor"],
  },
  "setup": {
    desc: "Interactive setup wizard (checks prerequisites, creates vault structure)",
    category: "Diagnose",
    ps: "ops/setup/setup-wizard.ps1",
    args: [],
  },

  // Help (hidden)
  "help": { desc: "Show this help", hidden: true },
};

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

export const ALIASES = {
  // bus
  sync: "bus:sync",
  generate: "bus:generate",
  status: "bus:status",
  // dream
  "dream-dry-run": "dream:dry-run",
  "dream-writeback": "dream:writeback",
  // embeddings
  "embeddings:rebuild": "embeddings:force",
  // layers
  layers: "layers:build",
  // handoff
  handoff: "handoff:build",
  // hygiene
  hygiene: "hygiene:report",
  // mcp
  start: "mcp:start",
  stop: "mcp:stop",
  // search
  search: "search",
  // integrity
  "integrity:check": "check",
};

// ---------------------------------------------------------------------------
// Help rendering
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = [
  "Bus",
  "Dream",
  "Embeddings",
  "Layers",
  "Handoff",
  "Hygiene",
  "MCP",
  "Search",
  "Integrity",
  "Diagnose",
];

function groupByCategory(commands) {
  const groups = {};
  for (const [name, cmd] of Object.entries(commands)) {
    if (cmd.hidden) continue;
    const cat = cmd.category || "Other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ name, ...cmd });
  }
  return groups;
}

export function showHelp() {
  const version = getVersion();
  const lines = [];
  lines.push(`ai-memory v${version} — Shared memory bus for AI tools\n`);
  lines.push("Your AI tools (Claude Code, Codex, OpenCode...) share one Obsidian-backed memory.");
  lines.push("Run 'ai-memory doctor' first if something isn't working.\n");
  lines.push("Usage: ai-memory <command> [options]\n");
  lines.push("Commands:");

  const groups = groupByCategory(COMMANDS);
  for (const cat of CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    lines.push(`\n  [${cat}]`);
    for (const cmd of groups[cat]) {
      lines.push(`    ${cmd.name.padEnd(28)} ${cmd.desc}`);
    }
  }

  lines.push("\nGlobal flags:");
  lines.push("  --workspace <path>     Override vault root");
  lines.push("  --json                  JSON output (where supported)");
  lines.push("  --dry-run               Dry-run mode (where supported)");
  lines.push("  --help, -h             Show command-specific help");
  lines.push("  --version              Show CLI version");
  lines.push("\nAliases:");
  lines.push("  sync   -> bus:sync");
  lines.push("  start  -> mcp:start");
  lines.push("  stop   -> mcp:stop");
  lines.push("  search -> search");
  lines.push("  check  -> check\n");

  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Known global flags (defensive validation in runCommand)
// ---------------------------------------------------------------------------

export const KNOWN_FLAGS = new Set([
  "--help", "-h", "--version", "--workspace", "--json", "--dry-run", "--strict",
]);
