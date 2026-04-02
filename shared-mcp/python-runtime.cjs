"use strict";

const fs = require("fs");
const path = require("path");
function resolveRuntimeHelperPath() {
  const candidates = [
    path.join(__dirname, "..", "python-runtime.js"),
    path.join(__dirname, "..", "bus", "python-runtime.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

const { resolvePythonRuntime } = require(resolveRuntimeHelperPath());

function resolvePythonCommand() {
  const runtime = resolvePythonRuntime();
  return runtime && runtime.available ? runtime.command : "";
}

function withResolvedPython(env = process.env) {
  const runtime = resolvePythonRuntime();
  if (!runtime || !runtime.available) {
    return { ...env };
  }
  return {
    ...env,
    AI_MEMORY_PYTHON: runtime.command,
  };
}

module.exports = {
  resolvePythonCommand,
  withResolvedPython,
};
