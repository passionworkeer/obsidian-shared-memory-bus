#!/usr/bin/env node
/**
 * ai-memory: Unified CLI for the Obsidian Shared Memory Bus
 * Usage: ai-memory <command> [options]
 */

import { spawn } from "child_process";
import net from "net";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment & paths
// ---------------------------------------------------------------------------

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ||
  path.resolve(__dirname, "..");

// Load vault-root helper from bus/ so we get the full resolution chain
async function loadVaultRootHelper() {
  const { pathToFileURL } = await import("url");
  const candidates = [
    path.join(AI_MEMORY_ROOT, "bus", "vault-root.js"),
    path.join(AI_MEMORY_ROOT, "vault-root.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const mod = await import(pathToFileURL(c));
      return mod.default || mod;
    }
  }
  return null;
}

const vaultRootHelper = await loadVaultRootHelper();

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

function showHelp() {
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

  if (!fs.existsSync(scriptAbs)) {
    process.stderr.write(`error: script not found: ${scriptAbs}\n`);
    return Promise.resolve({ exitCode: 1 });
  }

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

  if (flags.includes("--dry-run")) {
    const exe = "powershell.exe";
    process.stdout.write(`[dry-run] ${exe} ${psArgs.map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(" ")}\n`);
    return Promise.resolve({ exitCode: 0 });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", psArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        cwd: AI_MEMORY_ROOT,
      });
    } catch (err) {
      process.stderr.write(`failed to spawn powershell.exe: ${err.message}\n`);
      resolve({ exitCode: 1 });
      return;
    }

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
      process.stderr.write(`powershell.exe error: ${err.message}\n`);
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

  if (!fs.existsSync(scriptAbs)) {
    process.stderr.write(`error: script not found: ${scriptAbs}\n`);
    return Promise.resolve({ exitCode: 1 });
  }

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

  const allArgs = [...extraArgs, ...forwarded];

  if (flags.includes("--dry-run")) {
    const exe = process.execPath;
    const envParts = Object.entries({ ...process.env, AI_MEMORY_OBSIDIAN_VAULT: vaultRoot })
      .filter(([k]) => k.startsWith("AI_MEMORY_"))
      .map(([k, v]) => `${k}=${v}`);
    process.stdout.write(`[dry-run] ${exe} ${[scriptAbs, ...allArgs].map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(" ")}\n`);
    if (envParts.length) {
      process.stdout.write(`[dry-run]   env: ${envParts.join(" ")}\n`);
    }
    return Promise.resolve({ exitCode: 0 });
  }

  // Set vault root env so the child script can pick it up
  const childEnv = { ...process.env, AI_MEMORY_OBSIDIAN_VAULT: vaultRoot };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [scriptAbs, ...allArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: childEnv,
        cwd: path.dirname(scriptAbs),
      });
    } catch (err) {
      process.stderr.write(`failed to spawn ${process.execPath}: ${err.message}\n`);
      resolve({ exitCode: 1 });
      return;
    }

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
      process.stderr.write(`node process error: ${err.message}\n`);
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

  // Reject unknown flags (defensive)
  const KNOWN_FLAGS = new Set([
    "--help", "-h", "--version", "--workspace", "--json", "--dry-run", "--strict",
  ]);
  for (const flag of flags) {
    if (!KNOWN_FLAGS.has(flag) && !flag.startsWith("--workspace=")) {
      process.stderr.write(`error: unknown global flag '${flag}'. See ai-memory --help.\n`);
      return { exitCode: 1 };
    }
  }

  if (!cmd.ps && !cmd.js) {
    process.stderr.write(`error: internal error — command '${cmd._alias}' has no script defined.\n`);
    return { exitCode: 1 };
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
// Doctor checks
// ---------------------------------------------------------------------------

async function runDoctorChecks() {
  const checks = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  function check(pass, label, suggestion) {
    if (pass === true) {
      checks.push({ type: "pass", label });
      passed++;
    } else if (pass === false) {
      checks.push({ type: "fail", label, suggestion });
      failed++;
    } else {
      checks.push({ type: "warn", label, suggestion });
      warnings++;
    }
  }

  const nodeVersion = process.version.replace(/^v/, "").split(".").map(Number);
  check(
    nodeVersion[0] >= 18,
    `Node.js version >= 18 (found ${process.version})`,
    "Upgrade Node.js to 18 or later"
  );

  try {
    const python = await new Promise((resolve) => {
      const child = spawn(
        "python",
        ["--version"],
        { shell: true, windowsHide: true }
      );
      let output = "";
      child.stdout.on("data", (d) => { output += d.toString(); });
      child.stderr.on("data", (d) => { output += d.toString(); });
      child.on("close", () => { resolve(output.trim()); });
      child.on("error", () => { resolve(""); });
    });
    if (python) {
      const match = python.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const pyMajor = parseInt(match[1], 10);
        const pyMinor = parseInt(match[2], 10);
        check(
          pyMajor > 3 || (pyMajor === 3 && pyMinor >= 10),
          `Python version >= 3.10 (found ${pyMajor}.${pyMinor})`,
          "Install Python 3.10+ for full MCP support"
        );
      } else {
        check(null, "Python version detected", "Could not parse Python version");
      }
    } else {
      check(null, "Python availability", "Python not found — some MCP servers may not work");
    }
  } catch (_) {
    check(null, "Python availability", "Python not found — some MCP servers may not work");
  }

  try {
    const pwsh = await new Promise((resolve) => {
      const child = spawn(
        "pwsh",
        ["--version"],
        { shell: true, windowsHide: true }
      );
      let output = "";
      child.stdout.on("data", (d) => { output += d.toString(); });
      child.stderr.on("data", (d) => { output += d.toString(); });
      child.on("close", () => { resolve(output.trim()); });
      child.on("error", () => { resolve(""); });
    });
    check(Boolean(pwsh), "PowerShell Core (pwsh) available", "Install PowerShell 7+ for best experience");
  } catch (_) {
    check(null, "PowerShell Core (pwsh) available", "PowerShell Core not found — pwsh is recommended");
  }

  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..");
  check(
    Boolean(process.env.AI_MEMORY_ROOT),
    `AI_MEMORY_ROOT is set (${aiMemoryRoot})`,
    "Set AI_MEMORY_ROOT environment variable for reliable operation"
  );

  let vaultRoot = null;
  try {
    vaultRoot = resolveVaultRoot([]);
    check(
      fs.existsSync(vaultRoot),
      `Vault root exists (${vaultRoot})`,
      "Set AI_MEMORY_OBSIDIAN_VAULT to your Obsidian vault path"
    );
  } catch (_) {
    vaultRoot = null;
  }

  if (vaultRoot) {
    const requiredPaths = [
      "00-System/ai-memory",
      "02-KB/OBSIDIAN.md",
      "02-KB/MEMORY.md",
    ];
    for (const rel of requiredPaths) {
      const abs = path.join(vaultRoot, rel.replace(/\//g, path.sep));
      check(
        fs.existsSync(abs),
        `Required vault file exists: ${rel}`,
        `Create ${rel} in your vault`
      );
    }
  }

  const portsInUse = [];
  const criticalPorts = [9331, 9332, 9333, 9334, 9335, 9338];
  for (const port of criticalPorts) {
    const inUse = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => { resolve(true); });
      server.once("listening", () => { server.close(); resolve(false); });
      server.listen(port, "127.0.0.1");
    });
    if (inUse) portsInUse.push(port);
  }
  check(
    portsInUse.length === 0,
    `Shared MCP ports 9331-9338 available (${portsInUse.length} in use: ${portsInUse.join(", ") || "none"})`,
    portsInUse.length > 0 ? `Stop other services using ports ${portsInUse.join(", ")}` : undefined
  );

  const homeAiMemory = path.join(os.homedir(), ".ai-memory");
  const isInstalled = fs.existsSync(homeAiMemory);
  const isSourceTree = fs.existsSync(path.join(AI_MEMORY_ROOT, "bus", "memory-bus.ps1"));
  check(
    isInstalled || isSourceTree,
    `ai-memory installed (${isInstalled ? "installed" : "source tree"})`,
    "Run the installer to set up ai-memory properly"
  );

  process.stdout.write("\n");
  for (const c of checks) {
    if (c.type === "pass") {
      process.stdout.write(`\u2705 PASS: ${c.label}\n`);
    } else if (c.type === "fail") {
      process.stdout.write(`\u274C FAIL: ${c.label}\n`);
      if (c.suggestion) {
        process.stdout.write(`   Fix: ${c.suggestion}\n`);
      }
    } else {
      process.stdout.write(`\u26A0  WARN: ${c.label}\n`);
      if (c.suggestion) {
        process.stdout.write(`   Suggestion: ${c.suggestion}\n`);
      }
    }
  }

  process.stdout.write("\n");
  process.stdout.write(`${passed} checks passed, ${failed} failed, ${warnings} warnings\n`);
  process.stdout.write("\n");

  if (failed === 0) {
    process.stdout.write("Your setup looks good! Run 'ai-memory mcp:start' to start the shared memory bus.\n");
  } else {
    process.stdout.write("Run 'ai-memory mcp:status' or check docs/TROUBLESHOOTING.md for fixes.\n");
  }

  process.exit(failed === 0 ? 0 : 1);
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

  // Handle --doctor early (before command dispatch)
  if (flags.includes("--doctor")) {
    return runDoctorChecks();
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
