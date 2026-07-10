/**
 * Subcommand dispatcher.
 *
 * Imports the registry and each command module. Looks up a subcommand
 * (after alias resolution) and either:
 *   - calls an in-process async function (e.g. `doctor` via doctorCmd.run)
 *   - or shell-outs to a PowerShell/Node script via spawnPowerShell/spawnNode
 */
import { COMMANDS, ALIASES, showHelp, KNOWN_FLAGS } from "../lib/registry.js";
import { spawnPowerShell, spawnNode } from "../lib/spawn-powershell.js";
import { resolveVaultRoot } from "../lib/resolve-vault-root.js";
import * as initCmd from "./init.js";
import * as statusCmd from "./status.js";
import * as doctorCmd from "./doctor.js";
import * as syncCmd from "./sync.js";
import * as watchCmd from "./watch.js";

/**
 * Resolve a subcommand name to a runner.
 *
 * Returns `null` if the name has no runner. Walks aliases first, then
 * each command module's `getCommand`, then falls back to the COMMANDS
 * registry for shell-out commands.
 */
export function resolveRunner(name) {
  const aliasName = ALIASES[name] || name;

  // In-process runners (per-module).
  const modules = [initCmd, statusCmd, doctorCmd, syncCmd, watchCmd];
  for (const mod of modules) {
    const r = mod.getCommand(aliasName);
    if (r && typeof r.run === "function") {
      return { runner: r.run, aliasName };
    }
  }

  // Shell-out commands registered in COMMANDS.
  const entry = COMMANDS[aliasName];
  if (entry) {
    return {
      runner: (subArgs, flags, vaultRoot) => runShellCommand(entry, subArgs, flags, vaultRoot, aliasName),
      aliasName,
    };
  }
  return null;
}

function runShellCommand(cmd, subArgs, flags, vaultRoot, aliasName) {
  if (flags.includes("--help") || flags.includes("-h")) {
    process.stdout.write(`ai-memory ${aliasName}\n`);
    process.stdout.write(`  ${cmd.desc}\n`);
    process.stdout.write(`  Script: ${cmd.ps || cmd.js}\n`);
    process.stdout.write(`  Args: ${[...subArgs, ...cmd.args].join(" ")}\n`);
    return Promise.resolve({ exitCode: 0 });
  }

  // Reject unknown flags (defensive)
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--workspace") {
      index += 1;
      continue;
    }
    if (!KNOWN_FLAGS.has(flag) && !flag.startsWith("--workspace=")) {
      process.stderr.write(`error: unknown global flag '${flag}'. See ai-memory --help.\n`);
      return Promise.resolve({ exitCode: 1 });
    }
  }

  if (!cmd.ps && !cmd.js) {
    process.stderr.write(`error: internal error — command '${aliasName}' has no script defined.\n`);
    return Promise.resolve({ exitCode: 1 });
  }

  if (cmd.ps) {
    return spawnPowerShell(cmd.ps, [...subArgs, ...cmd.args], vaultRoot, flags);
  }
  return spawnNode(cmd.js, [...subArgs, ...cmd.args], flags, vaultRoot);
}

/**
 * Top-level dispatch. Returns `{ exitCode }` so the entrypoint can exit.
 *
 * @param {string} subcmd
 * @param {string[]} subArgs
 * @param {string[]} flags
 */
export async function dispatch(subcmd, subArgs, flags) {
  // Help / unknown subcommand
  const resolved = resolveRunner(subcmd);
  if (!resolved) {
    showHelp();
    return { exitCode: 0 };
  }

  // Hidden commands (e.g. `help`) fall through to showHelp.
  const registryEntry = COMMANDS[resolved.aliasName];
  if (registryEntry && registryEntry.hidden) {
    showHelp();
    return { exitCode: 0 };
  }

  // The `doctor` command runs in-process; it calls process.exit()
  // internally and never returns an exitCode.
  if (resolved.aliasName === "doctor") {
    return doctorCmd.runDoctorChecks();
  }

  let vaultRoot;
  try {
    vaultRoot = resolveVaultRoot(flags);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return { exitCode: 1 };
  }

  return resolved.runner(subArgs, flags, vaultRoot);
}
