"use strict";
const path = require("path");

function _homedir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function _env(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function resolveStoreRoot() {
  return (
    _env("AI_MEMORY_STORE") ||
    _env("AI_MEMORY_STORE_ROOT") ||
    _env("AI_MEMORY_ROOT") ||
    path.join(_homedir(), ".ai-memory")
  );
}

function getDefaultStoreCandidates() {
  const home = _homedir();
  return [
    path.join(home, ".ai-memory"),
    path.join(home, ".local", "share", "ai-memory"),
    path.join(home, "Library", "Application Support", "ai-memory"),
  ];
}

module.exports = { resolveStoreRoot, getDefaultStoreCandidates };
