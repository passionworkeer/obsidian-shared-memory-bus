#!/usr/bin/env node
/**
 * local-ai-memory-bus — unified CLI entry for npx.
 *
 * Usage:
 *   npx local-ai-memory-bus                 start the MCP memory server (default)
 *   npx local-ai-memory-bus start           ...same as above
 *   npx local-ai-memory-bus setup [--target=<agent|all>]   configure AI agents
 *   npx local-ai-memory-bus <init|doctor|status|sync|watch|help>   delegate to ai-memory CLI
 *   npx local-ai-memory-bus --version
 *
 * This is a thin dispatcher. Heavy logic lives in start.js / setup-mcp.js / cli/.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const rawArgs = process.argv.slice(2);
const cmd = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "start";
const rest = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.slice(1) : rawArgs;

const DELEGATED = new Set(["init", "doctor", "status", "sync", "watch", "help"]);

function runNode(scriptPath, args) {
  const child = spawn(process.execPath, [join(__dirname, scriptPath), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (err) => {
    process.stderr.write(`Failed to run ${scriptPath}: ${err.message}\n`);
    process.exit(1);
  });
  child.on("close", (code) => process.exit(code || 0));
}

if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (rawArgs.includes("--help") || rawArgs.includes("-h") || cmd === "help") {
  process.stdout.write(
    `local-ai-memory-bus v${pkg.version}\n` +
      `Multi-agent shared local memory (MCP).\n\n` +
      `Commands:\n` +
      `  start                  Start the MCP memory server (default)\n` +
      `  setup [--target=<a|all>]  Configure AI agents (claude/cursor/kiro/windsurf/cline/roo/goose/qoder)\n` +
      `  init                   Initialize memory store + first sync\n` +
      `  doctor                 Diagnose the installation\n` +
      `  status                 Show memory overview\n` +
      `  sync                   Run a one-shot cross-tool sync\n` +
      `  watch                  Start the watchdog observer\n` +
      `  --version, -v          Print version\n\n` +
      `Default (no args) = start. See README.md / docs/guides/INTEGRATION.md.\n`,
  );
  process.exit(0);
}

switch (cmd) {
  case "start":
  case "server":
  case undefined:
    runNode("start.js", rest);
    break;
  case "setup":
  case "setup-mcp":
    runNode("setup-mcp.js", rest);
    break;
  default:
    if (DELEGATED.has(cmd)) {
      runNode("cli/ai-memory.js", [cmd, ...rest]);
    } else {
      process.stderr.write(
        `Unknown command: ${cmd}\nRun "local-ai-memory-bus help" for usage.\n`,
      );
      process.exit(2);
    }
}
