// ---------------------------------------------------------------------------
// Platform detection — done once at module load time
// ---------------------------------------------------------------------------

const PLATFORM = process.platform;  // 'win32' | 'darwin' | 'linux'

// ---------------------------------------------------------------------------
// Import the three platform adapter factory functions. The module bodies
// themselves only define functions and read env vars at top level — they do
// not spawn processes or perform I/O until the factory is invoked. Only the
// factory for the active platform is actually called (see `platform` below),
// so the other two adapters' bodies are dead weight on the active path.
// ---------------------------------------------------------------------------

import { getWindowsAdapter } from "./windows.js";
import { getDarwinAdapter } from "./darwin.js";
import { getLinuxAdapter } from "./linux.js";

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

export {
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
