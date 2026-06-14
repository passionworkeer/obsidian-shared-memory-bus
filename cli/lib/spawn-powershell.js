import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { AI_MEMORY_ROOT } from "./resolve-vault-root.js";

/**
 * Resolve a script path, handling both the project layout (ops/, bus/, etc.
 * subdirectories) and the flat installed layout (~/.ai-memory/).
 */
export function resolveScriptPath(scriptPath) {
  const withSubdir = path.join(AI_MEMORY_ROOT, scriptPath);
  if (fs.existsSync(withSubdir)) {
    return withSubdir;
  }
  // Flat installed layout: strip the leading subdirectory segment.
  // Normalise separators since registry paths always use '/'.
  const normalised = scriptPath.replace(/[/\\]+/g, "/");
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
export function spawnPowerShell(scriptPath, extraArgs, vaultRoot, flags) {
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
    const childEnv = {
      ...process.env,
      AI_MEMORY_STORE: vaultRoot,
      AI_MEMORY_STORE_ROOT: vaultRoot,
      AI_MEMORY_OBSIDIAN_VAULT: vaultRoot,
    };
    let child;
    try {
      child = spawn("powershell.exe", psArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: childEnv,
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
 * Spawn a Node.js script.
 */
export function spawnNode(scriptPath, extraArgs, flags, vaultRoot) {
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
    const envParts = Object.entries({
      ...process.env,
      AI_MEMORY_STORE: vaultRoot,
      AI_MEMORY_STORE_ROOT: vaultRoot,
      AI_MEMORY_OBSIDIAN_VAULT: vaultRoot,
    })
      .filter(([k]) => k.startsWith("AI_MEMORY_"))
      .map(([k, v]) => `${k}=${v}`);
    process.stdout.write(`[dry-run] ${exe} ${[scriptAbs, ...allArgs].map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(" ")}\n`);
    if (envParts.length) {
      process.stdout.write(`[dry-run]   env: ${envParts.join(" ")}\n`);
    }
    return Promise.resolve({ exitCode: 0 });
  }

  // Set vault root env so the child script can pick it up
  const childEnv = {
    ...process.env,
    AI_MEMORY_STORE: vaultRoot,
    AI_MEMORY_STORE_ROOT: vaultRoot,
    AI_MEMORY_OBSIDIAN_VAULT: vaultRoot,
  };

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
