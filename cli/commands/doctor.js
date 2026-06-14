/**
 * `doctor` command — runs environment / vault / port diagnostics.
 *
 * Implementation moved here from the monolithic ai-memory.js. We keep the
 * exact same set of checks (Node version, Python, PowerShell Core, vault
 * root, vault structure, critical ports, install layout) and the same
 * pass/fail/warn output format.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CRITICAL_PORTS } from "../../shared-mcp/port-registry.js";
import { createCheckCollector } from "../lib/check.js";
import { resolveVaultRoot, AI_MEMORY_ROOT } from "../lib/resolve-vault-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NAMES = ["doctor"];

export function getCommand(name) {
  if (name === "doctor") {
    return { run: runDoctorChecks, desc: "Diagnose common setup problems" };
  }
  return null;
}

/**
 * Detect "python --version" output.
 * @returns {Promise<string>}
 */
function detectPython() {
  return new Promise((resolve) => {
    const child = spawn("python", ["--version"], { shell: true, windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("close", () => { resolve(output.trim()); });
    child.on("error", () => { resolve(""); });
  });
}

/**
 * Detect "pwsh --version" output.
 * @returns {Promise<string>}
 */
function detectPwsh() {
  return new Promise((resolve) => {
    const child = spawn("pwsh", ["--version"], { shell: true, windowsHide: true });
    let output = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("close", () => { resolve(output.trim()); });
    child.on("error", () => { resolve(""); });
  });
}

/**
 * Check whether a TCP port is already in use on 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => { resolve(true); });
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port, "127.0.0.1");
  });
}

export async function runDoctorChecks() {
  const collector = createCheckCollector();

  const nodeVersion = process.version.replace(/^v/, "").split(".").map(Number);
  collector.add(
    nodeVersion[0] >= 18,
    `Node.js version >= 18 (found ${process.version})`,
    "Upgrade Node.js to 18 or later"
  );

  try {
    const python = await detectPython();
    if (python) {
      const match = python.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const pyMajor = parseInt(match[1], 10);
        const pyMinor = parseInt(match[2], 10);
        collector.add(
          pyMajor > 3 || (pyMajor === 3 && pyMinor >= 10),
          `Python version >= 3.10 (found ${pyMajor}.${pyMinor})`,
          "Install Python 3.10+ for full MCP support"
        );
      } else {
        collector.add(null, "Python version detected", "Could not parse Python version");
      }
    } else {
      collector.add(null, "Python availability", "Python not found — some MCP servers may not work");
    }
  } catch (_) {
    collector.add(null, "Python availability", "Python not found — some MCP servers may not work");
  }

  try {
    const pwsh = await detectPwsh();
    collector.add(Boolean(pwsh), "PowerShell Core (pwsh) available", "Install PowerShell 7+ for best experience");
  } catch (_) {
    collector.add(null, "PowerShell Core (pwsh) available", "PowerShell Core not found — pwsh is recommended");
  }

  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..", "..");
  collector.add(
    Boolean(process.env.AI_MEMORY_ROOT),
    `AI_MEMORY_ROOT is set (${aiMemoryRoot})`,
    "Set AI_MEMORY_ROOT environment variable for reliable operation"
  );

  let vaultRoot = null;
  try {
    vaultRoot = resolveVaultRoot([]);
    collector.add(
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
      collector.add(
        fs.existsSync(abs),
        `Required vault file exists: ${rel}`,
        `Create ${rel} in your vault`
      );
    }
  }

  const portsInUse = [];
  for (const port of CRITICAL_PORTS) {
    if (await isPortInUse(port)) portsInUse.push(port);
  }
  collector.add(
    portsInUse.length === 0,
    `Shared MCP ports [${CRITICAL_PORTS.join(", ")}] available (${portsInUse.length} in use: ${portsInUse.join(", ") || "none"})`,
    portsInUse.length > 0 ? `Stop other services using ports ${portsInUse.join(", ")}` : undefined
  );

  const homeAiMemory = path.join(os.homedir(), ".ai-memory");
  const isInstalled = fs.existsSync(homeAiMemory);
  const isSourceTree = fs.existsSync(path.join(AI_MEMORY_ROOT, "bus", "memory-bus.ps1"));
  collector.add(
    isInstalled || isSourceTree,
    `ai-memory installed (${isInstalled ? "installed" : "source tree"})`,
    "Run the installer to set up ai-memory properly"
  );

  collector.print();

  const { passed, failed, warnings } = collector.totals();
  process.stdout.write("\n");
  process.stdout.write(`${passed} checks passed, ${failed} failed, ${warnings} warnings\n`);
  process.stdout.write("\n");

  if (failed === 0) {
    process.stdout.write("Your setup looks good! Run 'ai-memory mcp:start' to start the shared memory bus.\n");
  } else {
    process.stdout.write("Run 'ai-memory mcp:status' or check docs/TROUBLESHOOTING.md for fixes.\n");
  }

  process.exit(collector.exitCode());
}
