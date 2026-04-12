"use strict";

// ---------------------------------------------------------------------------
// Platform detection — done once at module load time
// ---------------------------------------------------------------------------

const PLATFORM = process.platform;  // 'win32' | 'darwin' | 'linux'

// ---------------------------------------------------------------------------
// Load platform-specific adapters (lazy — only the active one is fully used)
// ---------------------------------------------------------------------------

const { getWindowsAdapter } = require("./windows.js");
const { getDarwinAdapter } = require("./darwin.js");
const { getLinuxAdapter } = require("./linux.js");

// ---------------------------------------------------------------------------
// Export the active platform adapter
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof getWindowsAdapter>} */
const platform = (() => {
  switch (PLATFORM) {
    case "win32":
      return getWindowsAdapter();
    case "darwin":
      return getDarwinAdapter();
    case "linux":
      return getLinuxAdapter();
    default:
      // Unknown platform — fall back to Linux adapter
      return getLinuxAdapter();
  }
})();

const isWindows = PLATFORM === "win32";
const isMac     = PLATFORM === "darwin";
const isLinux   = PLATFORM === "linux";

// ---------------------------------------------------------------------------
// Re-export individual adapters for test / tooling use
// ---------------------------------------------------------------------------

module.exports = {
  // The active platform adapter (singleton per process)
  platform,

  // Platform identity booleans
  isWindows,
  isMac,
  isLinux,

  // Individual adapter factories (useful for cross-platform testing)
  getWindowsAdapter,
  getDarwinAdapter,
  getLinuxAdapter,
};
