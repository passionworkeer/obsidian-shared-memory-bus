#!/usr/bin/env node
/**
 * ai-memory: Unified CLI for the Obsidian Shared Memory Bus
 * Usage: ai-memory <command> [options]
 *
 * This is the entrypoint. The bulk of the logic lives in
 * ./commands/ and ./lib/. The entrypoint's job is to:
 *   1. Parse argv
 *   2. Handle --version and --doctor early
 *   3. Dispatch the subcommand
 */
import { parseArgs } from "./lib/parse-args.js";
import { getVersion } from "./lib/registry.js";
import { dispatch } from "./commands/index.js";
import { runDoctorChecks } from "./commands/doctor.js";

async function main() {
  const raw = process.argv.slice(2);
  const { flags, positional } = parseArgs(raw);

  // --version: print and exit
  if (flags.includes("--version")) {
    process.stdout.write(`${getVersion()}\n`);
    process.exit(0);
    return;
  }

  // --doctor: run diagnostics in-process (legacy flag, kept for back-compat)
  if (flags.includes("--doctor")) {
    await runDoctorChecks();
    return;
  }

  const subcmd = positional[0] || "help";
  const subArgs = positional.slice(1);

  const result = await dispatch(subcmd, subArgs, flags);
  process.exit(result.exitCode);
}

main().catch((err) => {
  process.stderr.write(`Unhandled error: ${err.message}\n`);
  process.exit(1);
});
