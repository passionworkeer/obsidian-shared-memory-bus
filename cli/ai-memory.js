#!/usr/bin/env node
/**
 * ai-memory: Unified CLI for the Obsidian Shared Memory Bus
 * Usage: ai-memory <command> [options]
 */

"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Environment & paths
// ---------------------------------------------------------------------------

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ||
  path.resolve(__dirname, "..");

// Load vault-root helper from bus/ so we get the full resolution chain
function loadVaultRootHelper() {
  const candidates = [
    path.join(AI_MEMORY_ROOT, "bus", "vault-root.js"),
    path.join(AI_MEMORY_ROOT, "vault-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return require(c);
    }
  }
  return null;
}

const vaultRootHelper = loadVaultRootHelper();

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function getVersion() {
  // Check AI_MEMORY_ROOT/package.json first (installed layout)
  // then cli/package.json (project layout / symlinked install)
  for (const pkgPath of [
    path.join(AI_MEMORY_ROOT, "package.json"),
    path.join(__dirname, "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Vault root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Obsidian vault root using multiple strategies.
 * @param {string[]} flags  - CLI flags (e.g. ["--workspace", "/path"])
 * @returns {string}
 */
function resolveVaultRoot(flags) {
  // 1. Explicit --workspace flag
  const workspaceIdx = flags.indexOf("--workspace");
  if (workspaceIdx !== -1 && flags[workspaceIdx + 1]) {
    return path.resolve(flags[workspaceIdx + 1]);
  }

  // 2. AI_MEMORY_OBSIDIAN_VAULT env
  const envVault = process.env.AI_MEMORY_OBSIDIAN_VAULT;
  if (envVault && fs.existsSync(envVault)) {
    return path.resolve(envVault);
  }

  // 3. AI_MEMORY_ROOT/config.json
  const configPath = path.join(AI_MEMORY_ROOT, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg.vaultRoot && fs.existsSync(cfg.vaultRoot)) {
        return path.resolve(cfg.vaultRoot);
      }
    } catch { /* ignore */ }
  }

  // 4. ~/.ai-memory/vault-root.txt
  const homeVaultTxt = path.join(os.homedir(), ".ai-memory", "vault-root.txt");
  if (fs.existsSync(homeVaultTxt)) {
    const vault = fs.readFileSync(homeVaultTxt, "utf8").trim();
    if (vault && fs.existsSync(vault)) {
      return path.resolve(vault);
    }
  }

  // 5. Fall back to bus/vault-root.js helper (reads Obsidian config, etc.)
  if (vaultRootHelper && typeof vaultRootHelper.resolveVaultRoot === "function") {
    return vaultRootHelper.resolveVaultRoot();
  }

  throw new Error(
    "no-obsidian-vault: Set AI_MEMORY_OBSIDIAN_VAULT, create " +
    "$AI_MEMORY_ROOT/config.json with vaultRoot, " +
    "create ~/.ai-memory/vault-root.txt, or open an Obsidian vault first."
  );
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

const COMMANDS = {
  // Bus commands
  "bus:sync": {
    desc: "Run memory-bus SyncAll",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "SyncAll"],
  },
  "bus:generate": {
    desc: "Generate artifacts",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "Generate"],
  },
  "bus:status": {
    desc: "Show bus status",
    category: "Bus",
    ps: "bus/memory-bus.ps1",
    args: ["-Action", "Status"],
  },

  // Dream commands
  "dream:run": {
    desc: "Run memory dream consolidation",
    category: "Dream",
    ps: "ops/run-memory-dream.ps1",
    args: [],
  },
  "dream:dry-run": {
    desc: "Dry-run dream consolidation",
    category: "Dream",
    ps: "ops/run-memory-dream.ps1",
    args: ["-DryRun"],
  },
  "dream:writeback": {
    desc: "Dream consolidation with writeback",
    category: "Dream",
    ps: "ops/run-memory-dream.ps1",
    args: ["-Writeback"],
  },

  // Embeddings commands
  "embeddings:build": {
    desc: "Build embeddings index",
    category: "Embeddings",
    js: "bus/generate-embeddings.js",
    args: [],
  },
  "embeddings:status": {
    desc: "Show embeddings index status",
    category: "Embeddings",
    js: "ops/check-memory-integrity.js",
    args: ["--json"],
  },
  "embeddings:force": {
    desc: "Force rebuild embeddings",
    category: "Embeddings",
    js: "bus/generate-embeddings.js",
    args: ["--force"],
  },

  // Layer commands
  "layers:build": {
    desc: "Build memory layers",
    category: "Layers",
    js: "ops/build-memory-layers.js",
    args: [],
  },

  // Handoff commands
  "handoff:build": {
    desc: "Build handoff pack",
    category: "Handoff",
    js: "ops/build-handoff-pack.js",
    args: [],
  },

  // Hygiene commands
  "hygiene:report": {
    desc: "Generate memory hygiene report",
    category: "Hygiene",
    js: "ops/generate-memory-hygiene-report.js",
    args: ["--json"],
  },

  // MCP commands
  "mcp:start": {
    desc: "Start shared MCP",
    category: "MCP",
    ps: "shared-mcp/start-default-shared-mcp.ps1",
    args: [],
  },
  "mcp:status": {
    desc: "Show shared MCP status",
    category: "MCP",
    ps: "shared-mcp/status-shared-mcp.ps1",
    args: [],
  },
  "mcp:stop": {
    desc: "Stop shared MCP",
    category: "MCP",
    ps: "shared-mcp/stop-shared-mcp.ps1",
    args: [],
  },

  // Search command (direct, no MCP round-trip)
  "search": {
    desc: "Search shared memory (hybrid mode)",
    category: "Search",
    js: "retrieval/semantic-search.js",
    args: ["--mode", "hybrid"],
  },

  // Integrity
  "check": {
    desc: "Run memory integrity check",
    category: "Integrity",
    js: "ops/check-memory-integrity.js",
    args: [],
  },

  // Help (hidden)
  "help": { desc: "Show this help", hidden: true },
};

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

const ALIASES = {
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
  "layers": "layers:build",
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

function showHelp() {
  const version = getVersion();
  const lines = [];
  lines.push(`ai-memory v${version} — Unified CLI for the Obsidian Shared Memory Bus\n`);
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
// Command dispatcher
// ---------------------------------------------------------------------------

/**
 * Returns true if a script's param() block declares -VaultRoot.
 * Checks the first 20 lines to avoid reading the whole file.
 */
function scriptHasVaultRootParam(scriptAbs) {
  try {
    const content = fs.readFileSync(scriptAbs, { encoding: "utf8", maxLength: 8192 });
    const preamble = content.slice(0, 4096);
    return /param\s*\([\s\S]*?[-$\s]VaultRoot\b/i.test(preamble);
  } catch {
    return false;
  }
}

/**
 * Spawn a PowerShell script with proper vault-root plumbing.
 */
function spawnPowerShell(scriptPath, extraArgs, vaultRoot, flags) {
  const scriptAbs = resolveScriptPath(scriptPath);

  // Only inject -VaultRoot for scripts that declare it in their param block.
  // Most scripts resolve vault root internally via runtime-platform.ps1.
  const injectVaultRoot = scriptHasVaultRootParam(scriptAbs);

  const psArgs = [
    ...(injectVaultRoot ? ["-VaultRoot", vaultRoot] : []),
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptAbs,
    ...extraArgs,
  ];

  // Forward --dry-run if present (inject before -File)
  if (flags.includes("--dry-run") && !psArgs.includes("-DryRun")) {
    // Insert -DryRun before -File
    const fileIdx = psArgs.indexOf("-File");
    if (fileIdx !== -1) {
      psArgs.splice(fileIdx, 0, "-DryRun");
    } else {
      psArgs.push("-DryRun");
    }
  }

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", psArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      cwd: AI_MEMORY_ROOT,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        process.stderr.write(stderr);
      } else if (stdout) {
        process.stdout.write(stdout);
      }
      resolve({ exitCode: code || 0 });
    });

    child.on("error", (err) => {
      process.stderr.write(`spawn error: ${err.message}\n`);
      resolve({ exitCode: 1 });
    });
  });
}

/**
 * Resolve a script path, handling both the project layout (ops/, bus/, etc.
 * subdirectories) and the flat installed layout (~/.ai-memory/).
 */
function resolveScriptPath(scriptPath) {
  const withSubdir = path.join(AI_MEMORY_ROOT, scriptPath);
  if (fs.existsSync(withSubdir)) {
    return withSubdir;
  }
  // Flat installed layout: strip the leading subdirectory segment.
  // Normalise separators since registry paths always use '/'.
  const normalised = scriptPath.replace(/[\/\\]+/g, "/");
  const segments = normalised.split("/");
  if (segments.length >= 2) {
    const flat = path.join(AI_MEMORY_ROOT, segments.slice(1).join("/"));
    if (fs.existsSync(flat)) {
      return flat;
    }
  }
  // Fall back to the subdir path even if it doesn't exist (let Node report the error)
  return withSubdir;
}

/**
 * Spawn a Node.js script.
 */
function spawnNode(scriptPath, extraArgs, flags, vaultRoot) {
  const scriptAbs = resolveScriptPath(scriptPath);

  // Merge forwarded flags
  const forwarded = [];
  if (flags.includes("--json") && !extraArgs.includes("--json")) {
    forwarded.push("--json");
  }
  if (flags.includes("--dry-run") && !extraArgs.includes("--dry-run")) {
    forwarded.push("--dry-run");
  }
  if (flags.includes("--strict") && !extraArgs.includes("--strict")) {
    forwarded.push("--strict");
  }

  // Set vault root env so the child script can pick it up
  const childEnv = { ...process.env, AI_MEMORY_OBSIDIAN_VAULT: vaultRoot };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptAbs, ...extraArgs, ...forwarded], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: childEnv,
      cwd: path.dirname(scriptAbs),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        process.stderr.write(stderr);
      } else if (stdout) {
        // Pretty-print JSON if --json was forwarded and output looks like JSON
        if (flags.includes("--json")) {
          try {
            const parsed = JSON.parse(stdout);
            process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
          } catch {
            process.stdout.write(stdout);
          }
        } else {
          process.stdout.write(stdout);
        }
      }
      resolve({ exitCode: code || 0 });
    });

    child.on("error", (err) => {
      process.stderr.write(`spawn error: ${err.message}\n`);
      resolve({ exitCode: 1 });
    });
  });
}

/**
 * Run a command definition.
 * @param {object} cmd   - Command from COMMANDS
 * @param {string[]} subArgs  - Positional args after the subcommand
 * @param {string[]} flags    - Global flags
 * @param {string} vaultRoot  - Resolved vault root
 */
async function runCommand(cmd, subArgs, flags, vaultRoot) {
  // --help / -h on any command shows basic help
  if (flags.includes("--help") || flags.includes("-h")) {
    process.stdout.write(`ai-memory ${cmd._alias || Object.keys(COMMANDS).find(k => COMMANDS[k] === cmd)}\n`);
    process.stdout.write(`  ${cmd.desc}\n`);
    process.stdout.write(`  Script: ${cmd.ps || cmd.js}\n`);
    process.stdout.write(`  Args: ${[...subArgs, ...cmd.args].join(" ")}\n`);
    return { exitCode: 0 };
  }

  if (cmd.ps) {
    return spawnPowerShell(cmd.ps, [...subArgs, ...cmd.args], vaultRoot, flags);
  } else if (cmd.js) {
    return spawnNode(cmd.js, [...subArgs, ...cmd.args], flags, vaultRoot);
  } else {
    process.stderr.write(`Unknown command type.\n`);
    return { exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = process.argv.slice(2);

  // Split into flags (--key or --key=value) and positional arguments
  const flags = raw.filter((a) => a.startsWith("--"));
  const positional = raw.filter((a) => !a.startsWith("--"));

  // Handle --version early
  if (flags.includes("--version")) {
    process.stdout.write(`${getVersion()}\n`);
    process.exit(0);
    return;
  }

  const subcmd = positional[0] || "help";
  const subArgs = positional.slice(1);

  // Resolve alias
  const aliasTarget = ALIASES[subcmd];
  const resolvedSubcmd = aliasTarget || subcmd;

  // Show help when no args or explicit help
  if (subcmd === "help" || (!ALIASES[subcmd] && !COMMANDS[resolvedSubcmd])) {
    showHelp();
    process.exit(0);
    return;
  }

  const cmd = COMMANDS[resolvedSubcmd];
  if (!cmd || cmd.hidden) {
    showHelp();
    process.exit(0);
    return;
  }

  // Tag the command with its resolved alias so help can show it
  cmd._alias = resolvedSubcmd;

  let vaultRoot;
  try {
    vaultRoot = resolveVaultRoot(flags);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }

  const result = await runCommand(cmd, subArgs, flags, vaultRoot);
  process.exit(result.exitCode);
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err.message}\n`);
  process.exit(1);
});
