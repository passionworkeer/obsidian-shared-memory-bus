"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local");
const PROGRAM_FILES = process.env.ProgramFiles || "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

function isUsableCommand(command) {
  if (!command) {
    return false;
  }

  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } catch (_error) {
    return false;
  }
}

function getExistingFile(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : "";
}

function getLatestPythonFromDirectory(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return "";
  }

  try {
    const directories = fs
      .readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^python/i.test(entry.name))
      .map((entry) => path.join(rootPath, entry.name, "python.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => right.localeCompare(left));
    return directories[0] || "";
  } catch (_error) {
    return "";
  }
}

function getCandidateCommands() {
  const commands = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  const files = [
    getExistingFile(process.env.AI_MEMORY_PYTHON || ""),
    getExistingFile(path.join(USER_HOME, "pipx", "shared", "Scripts", "python.exe")),
    getLatestPythonFromDirectory(path.join(LOCAL_APP_DATA, "Programs", "Python")),
    getLatestPythonFromDirectory(PROGRAM_FILES),
    getLatestPythonFromDirectory(PROGRAM_FILES_X86),
  ];

  return [...new Set([...files.filter(Boolean), ...commands])];
}

function resolvePythonCommand() {
  for (const candidate of getCandidateCommands()) {
    if (isUsableCommand(candidate)) {
      return candidate;
    }
  }
  return "";
}

function withResolvedPython(env = process.env) {
  const resolved = resolvePythonCommand();
  if (!resolved) {
    return { ...env };
  }
  return {
    ...env,
    AI_MEMORY_PYTHON: resolved,
  };
}

module.exports = {
  resolvePythonCommand,
  withResolvedPython,
};
