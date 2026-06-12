#!/usr/bin/env node
// Resolves a per-user pid file and invokes the platform-appropriate
// watchdog supervisor (watchdog.sh on POSIX, watchdog.ps1 on Windows).
// Usage: node scripts/watchdog.js <callback-script-or-command>
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const callback = process.argv[2];
if (!callback) {
  console.error("Usage: node scripts/watchdog.js <callback-script-or-command>");
  process.exit(2);
}

const pidFile = process.env.AI_MEMORY_WATCHDOG_PID
  || (process.env.AI_MEMORY_ROOT
        ? path.join(process.env.AI_MEMORY_ROOT, "watchdog.pid")
        : path.join(os.homedir(), ".ai-memory", "watchdog.pid"));

const isWindows = process.platform === "win32";
const supervisor = isWindows
  ? path.join(__dirname, "watchdog.ps1")
  : path.join(__dirname, "watchdog.sh");

if (!existsSync(supervisor)) {
  console.error(`[watchdog] supervisor not found: ${supervisor}`);
  process.exit(1);
}

const cmd = isWindows
  ? ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", supervisor, "-PidFile", pidFile, "-Callback", callback]
  : ["bash", supervisor, pidFile, callback];

console.log(`[watchdog] pid_file=${pidFile}`);
console.log(`[watchdog] callback=${callback}`);

const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
