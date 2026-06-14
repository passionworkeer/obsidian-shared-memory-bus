import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const LOCAL_APP_DATA = IS_WINDOWS
  ? process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local")
  : "";
const PROGRAM_FILES = IS_WINDOWS ? process.env.ProgramFiles || "C:\\Program Files" : "";
const PROGRAM_FILES_X86 = IS_WINDOWS ? process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)" : "";
const DATA_HOME =
  process.env.XDG_DATA_HOME ||
  (IS_MACOS ? path.join(USER_HOME, "Library", "Application Support") : path.join(USER_HOME, ".local", "share"));

let cachedRuntime = null;

function runProbe(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
      error: result.error ? String(result.error.message || result.error) : "",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: String(error && error.message ? error.message : error),
    };
  }
}

function buildRuntime(command, argsPrefix, source) {
  const probe = runProbe(command, [...argsPrefix, "--version"]);
  return {
    command,
    argsPrefix,
    source,
    available: probe.ok,
    version: probe.stdout || probe.stderr || "",
    error: probe.ok ? "" : probe.error || probe.stderr || `probe-exit-${probe.status}`,
  };
}

function resolveAbsoluteCandidate(candidate, source) {
  if (!candidate || !fs.existsSync(candidate)) {
    return null;
  }
  return buildRuntime(candidate, [], source);
}

function resolveLatestPythonFromDirectory(rootPath, source) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return null;
  }

  try {
    const executablePath = IS_WINDOWS ? "python.exe" : path.join("bin", "python3");
    const candidates = fs
      .readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^python/i.test(entry.name))
      .map((entry) => path.join(rootPath, entry.name, executablePath))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => right.localeCompare(left));

    if (candidates.length === 0) {
      return null;
    }

    return buildRuntime(candidates[0], [], source);
  } catch (_error) {
    return null;
  }
}

function resolveUvInstalledPython() {
  const baseDir = path.join(DATA_HOME, "uv", "python");
  if (!fs.existsSync(baseDir)) {
    return null;
  }

  const candidates = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => (IS_WINDOWS ? path.join(baseDir, entry.name, "python.exe") : path.join(baseDir, entry.name, "bin", "python3")))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => right.localeCompare(left));

  if (candidates.length === 0) {
    return null;
  }

  return buildRuntime(candidates[0], [], "uv-cache");
}

function resolveViaUvCommand() {
  const uvCandidates = [
    String(process.env.UV_COMMAND || "").trim(),
    path.join(USER_HOME, ".local", "bin", IS_WINDOWS ? "uv.exe" : "uv"),
    !IS_WINDOWS && IS_MACOS ? "/opt/homebrew/bin/uv" : "",
    "uv",
  ].filter(Boolean);

  for (const uvCommand of uvCandidates) {
    const probe = runProbe(uvCommand, ["python", "find"]);
    if (!probe.ok) {
      continue;
    }
    const resolvedPath = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      continue;
    }
    return buildRuntime(resolvedPath, [], "uv");
  }

  return null;
}

function resolvePythonRuntime() {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const condaPrefix = String(process.env.CONDA_PREFIX || "").trim();
  const envCommand = String(process.env.AI_MEMORY_PYTHON || "").trim();
  if (envCommand) {
    const runtime = envCommand.includes("\\") || envCommand.includes("/") || /^[A-Za-z]:/.test(envCommand)
      ? resolveAbsoluteCandidate(envCommand, "env")
      : buildRuntime(envCommand, [], "env");
    if (runtime && runtime.available) {
      cachedRuntime = runtime;
      return cachedRuntime;
    }
  }

  for (const candidate of [
    buildRuntime("python", [], "path"),
    buildRuntime("python3", [], "path"),
    buildRuntime("py", ["-3"], "launcher"),
  ]) {
    if (candidate.available) {
      cachedRuntime = candidate;
      return cachedRuntime;
    }
  }

  for (const runtime of [
    resolveViaUvCommand(),
    resolveUvInstalledPython(),
    ...(IS_WINDOWS
      ? [
          resolveAbsoluteCandidate(path.join(USER_HOME, "pipx", "shared", "Scripts", "python.exe"), "pipx-shared"),
          resolveLatestPythonFromDirectory(path.join(LOCAL_APP_DATA, "Programs", "Python"), "local-python"),
          resolveLatestPythonFromDirectory(PROGRAM_FILES, "program-files"),
          resolveLatestPythonFromDirectory(PROGRAM_FILES_X86, "program-files-x86"),
          condaPrefix ? resolveAbsoluteCandidate(path.join(condaPrefix, "python.exe"), "conda-prefix") : null,
          resolveAbsoluteCandidate(path.join(USER_HOME, "pytorch-env", "Scripts", "python.exe"), "pytorch-env"),
        ]
      : [
          condaPrefix ? resolveAbsoluteCandidate(path.join(condaPrefix, "bin", "python"), "conda-prefix") : null,
          resolveAbsoluteCandidate(path.join(USER_HOME, ".local", "bin", "python3"), "user-local"),
          resolveAbsoluteCandidate("/usr/bin/python3", "system"),
          resolveAbsoluteCandidate("/usr/local/bin/python3", "system"),
          resolveAbsoluteCandidate("/opt/homebrew/bin/python3", "homebrew"),
        ]),
  ]) {
    if (runtime && runtime.available) {
      cachedRuntime = runtime;
      return cachedRuntime;
    }
  }

  if (IS_WINDOWS) {
    for (const runtime of [
      resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python313", "python.exe"), "python313"),
      resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"), "python312"),
      resolveAbsoluteCandidate(path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"), "python311"),
    ]) {
      if (runtime && runtime.available) {
        cachedRuntime = runtime;
        return cachedRuntime;
      }
    }
  }

  cachedRuntime = {
    command: "python",
    argsPrefix: [],
    source: "fallback",
    available: false,
    version: "",
    error: "python-runtime-not-found",
  };
  return cachedRuntime;
}

function withPythonArgs(runtime, args) {
  return [...(runtime.argsPrefix || []), ...(Array.isArray(args) ? args : [])];
}

export {
  resolvePythonRuntime,
  withPythonArgs,
};
