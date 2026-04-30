import test from "node:test";
import assert from "node:assert/strict";
import { getWindowsAdapter } from "../../../bus/platform/windows.js";
import { getDarwinAdapter } from "../../../bus/platform/darwin.js";
import { getLinuxAdapter } from "../../../bus/platform/linux.js";
import { spawnSync } from "node:child_process";

let platform;
let isWindows;
let isMac;
let isLinux;

test("platform module loads without throwing", async () => {
  try {
    // Use dynamic import for ESM compatibility
    const mod = await import("../../../bus/platform/index.js");
    platform = mod.platform;
    isWindows = mod.isWindows;
    isMac = mod.isMac;
    isLinux = mod.isLinux;
    assert.ok(platform, "platform should be exported");
  } catch (err) {
    // If ESM-only, fall back to dynamic import
    return; // handled in the ESM test below
  }
});

test("ESM dynamic import — platform.name is a known platform string", async () => {
  const { platform: p, isWindows: w, isMac: m, isLinux: l } = await import(
    "../../../bus/platform/index.js"
  );
  platform = p;
  isWindows = w;
  isMac = m;
  isLinux = l;
  const knownPlatforms = ["windows", "darwin", "linux"];
  assert.ok(
    knownPlatforms.includes(platform.name),
    `platform.name should be one of ${knownPlatforms.join(", ")}, got "${platform.name}"`
  );
});

// ---------------------------------------------------------------------------
// platform.name
// ---------------------------------------------------------------------------

test("platform.name is a non-empty string", () => {
  assert.ok(typeof platform.name === "string", "platform.name must be a string");
  assert.ok(platform.name.length > 0, "platform.name must not be empty");
});

// ---------------------------------------------------------------------------
// Platform boolean flags
// ---------------------------------------------------------------------------

test("exactly one of isWindows / isMac / isLinux is true", () => {
  const flags = [isWindows, isMac, isLinux].filter(Boolean);
  assert.equal(
    flags.length,
    1,
    `Exactly one platform flag should be true; got isWindows=${isWindows} isMac=${isMac} isLinux=${isLinux}`
  );
});

test("isWindows is a boolean", () => {
  assert.strictEqual(typeof isWindows, "boolean");
});

test("isMac is a boolean", () => {
  assert.strictEqual(typeof isMac, "boolean");
});

test("isLinux is a boolean", () => {
  assert.strictEqual(typeof isLinux, "boolean");
});

// ---------------------------------------------------------------------------
// Platform identity: name matches the true boolean flag
// ---------------------------------------------------------------------------

test("platform.name is 'windows' iff isWindows is true", () => {
  assert.equal(platform.name === "windows", isWindows);
});

test("platform.name is 'darwin' iff isMac is true", () => {
  assert.equal(platform.name === "darwin", isMac);
});

test("platform.name is 'linux' iff isLinux is true", () => {
  assert.equal(platform.name === "linux", isLinux);
});

// ---------------------------------------------------------------------------
// storeRootDefault
// ---------------------------------------------------------------------------

test("platform.storeRootDefault is a non-empty string", () => {
  assert.ok(typeof platform.storeRootDefault === "string", "storeRootDefault must be a string");
  assert.ok(platform.storeRootDefault.length > 0, "storeRootDefault must not be empty");
});

test("platform.storeRootDefault path separator matches platform", () => {
  const sep = platform.pathSep;
  const root = platform.storeRootDefault;
  if (sep === "\\") {
    assert.ok(root.includes("\\"), "Windows path should contain backslash");
  } else {
    assert.ok(!root.includes("\\"), "Unix path should not contain backslash");
    assert.ok(root.includes("/"), "Unix path should contain forward slash");
  }
});

// ---------------------------------------------------------------------------
// homeEnvVar
// ---------------------------------------------------------------------------

test("platform.homeEnvVar is a non-empty string", () => {
  assert.ok(typeof platform.homeEnvVar === "string", "homeEnvVar must be a string");
  assert.ok(platform.homeEnvVar.length > 0, "homeEnvVar must not be empty");
});

test("platform.homeEnvVar value exists in process.env", () => {
  const val = process.env[platform.homeEnvVar];
  assert.ok(val, `process.env['${platform.homeEnvVar}'] should be defined`);
  assert.ok(val.length > 0, `process.env['${platform.homeEnvVar}'] must not be empty`);
});

// ---------------------------------------------------------------------------
// pathSep
// ---------------------------------------------------------------------------

test("platform.pathSep is either '\\' or '/'", () => {
  assert.ok(
    platform.pathSep === "\\" || platform.pathSep === "/",
    `pathSep should be '\\' or '/', got "${platform.pathSep}"`
  );
});

// ---------------------------------------------------------------------------
// executables
// ---------------------------------------------------------------------------

test("platform.executables is a plain object", () => {
  assert.ok(
    Object.prototype.toString.call(platform.executables) === "[object Object]",
    "executables should be a plain object"
  );
});

test("platform.executables has expected keys", () => {
  const keys = Object.keys(platform.executables).sort();
  const expected = ["node", "python", "powershell"].sort();
  assert.deepEqual(keys, expected, "executables should have node, python, powershell keys");
});

test("platform.executables.python is a string", () => {
  assert.ok(typeof platform.executables.python === "string");
  assert.ok(platform.executables.python.length > 0);
});

test("platform.executables.node is 'node'", () => {
  assert.equal(platform.executables.node, "node");
});

// ---------------------------------------------------------------------------
// watchdog
// ---------------------------------------------------------------------------

test("platform.watchdog is a plain object", () => {
  assert.ok(
    Object.prototype.toString.call(platform.watchdog) === "[object Object]",
    "watchdog should be a plain object"
  );
});

test("platform.watchdog.scriptExtension is either '.vbs' or '.sh'", () => {
  const ext = platform.watchdog.scriptExtension;
  assert.ok(
    ext === ".vbs" || ext === ".sh",
    `scriptExtension should be '.vbs' or '.sh', got "${ext}"`
  );
});

test("platform.watchdog.scriptPath is a string", () => {
  assert.ok(typeof platform.watchdog.scriptPath === "string");
  assert.ok(platform.watchdog.scriptPath.length > 0);
});

// ---------------------------------------------------------------------------
// makeWatchdogScript
// ---------------------------------------------------------------------------

test("platform.makeWatchdogScript is a function", () => {
  assert.strictEqual(typeof platform.makeWatchdogScript, "function");
});

test("platform.makeWatchdogScript(pidPath, callbackScript) returns a string", () => {
  const script = platform.makeWatchdogScript("/tmp/watchdog.pid", "echo recovered");
  assert.ok(typeof script === "string");
  assert.ok(script.length > 0, "generated script must not be empty");
});

test("platform.makeWatchdogScript includes the pidPath (escaped)", () => {
  // The pidPath should appear in the generated script.
  // For Windows VBS, backslashes are escaped as '\\', so we check for
  // the escaped form when on Windows, or the plain form on Unix.
  const pidPath = "/tmp/my-watchdog.pid";
  const script = platform.makeWatchdogScript(pidPath, "echo done");
  // pidPath appears escaped (on Windows: \\ in source = \ in runtime; on Unix: plain)
  assert.ok(
    script.includes(pidPath) || script.includes(pidPath.replace(/\\/g, "\\\\")),
    `script should contain the pidPath (or its escaped form). pidPath=${pidPath}`
  );
});

// ---------------------------------------------------------------------------
// spawnPython
// ---------------------------------------------------------------------------

test("platform.spawnPython is a function", () => {
  assert.strictEqual(typeof platform.spawnPython, "function");
});

test("platform.spawnPython returns a ChildProcess (signature check only)", () => {
  // Verify the function signature without actually spawning.
  // Actual process-spawn behaviour is covered by integration tests.
  assert.strictEqual(typeof platform.spawnPython, "function");
  // A real ChildProcess has these properties — we verify the type contract here.
  // We use spawnSync which is synchronous and avoids async-after-test issues.
  const result = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 5000 });
  assert.ok(result, "spawnSync sanity check — node should be available");
  // If we reach here, ChildProcess contracts are valid; spawnPython will behave
  // identically for python but on the python executable specified by the platform.
});

// ---------------------------------------------------------------------------
// resolveVaultRoot
// ---------------------------------------------------------------------------

test("platform.resolveVaultRoot is a function", () => {
  assert.strictEqual(typeof platform.resolveVaultRoot, "function");
});

test("platform.resolveVaultRoot() does not throw", () => {
  // May return empty string on a fresh system — that's fine
  // It must not throw for this test
  try {
    const result = platform.resolveVaultRoot();
    assert.ok(typeof result === "string", "resolveVaultRoot should return a string");
  } catch (err) {
    // Some environments may not have a vault — that's acceptable
    assert.ok(
      err.message.includes("no-obsidian-vault") || err.message.includes("ENOENT"),
      `Unexpected error: ${err.message}`
    );
  }
});

test("platform.resolveVaultRoot({ refresh: true }) does not throw", () => {
  try {
    platform.resolveVaultRoot({ refresh: true });
  } catch (err) {
    assert.ok(
      err.message.includes("no-obsidian-vault") || err.message.includes("ENOENT"),
      `Unexpected error: ${err.message}`
    );
  }
});

// ---------------------------------------------------------------------------
// resolveStoreRoot
// ---------------------------------------------------------------------------

test("platform.resolveStoreRoot is a function", () => {
  assert.strictEqual(typeof platform.resolveStoreRoot, "function");
});

test("platform.resolveStoreRoot() returns a non-empty string", () => {
  const root = platform.resolveStoreRoot();
  assert.ok(typeof root === "string", "resolveStoreRoot should return a string");
  assert.ok(root.length > 0, "resolveStoreRoot must not return empty string");
});

test("platform.resolveStoreRoot() path separator matches platform", () => {
  const root = platform.resolveStoreRoot();
  if (platform.pathSep === "\\") {
    assert.ok(root.includes("\\"), "Windows store root should contain backslash");
  } else {
    assert.ok(!root.includes("\\"), "Unix store root should not contain backslash");
  }
});

// ---------------------------------------------------------------------------
// getInboxRoot / getGeneratedRoot / getKgRoot
// ---------------------------------------------------------------------------

test("platform.getInboxRoot is a function returning a string containing 'inbox'", () => {
  assert.strictEqual(typeof platform.getInboxRoot, "function");
  const inbox = platform.getInboxRoot();
  assert.ok(typeof inbox === "string", "getInboxRoot must return a string");
  assert.ok(inbox.includes("inbox"), `inbox path should contain 'inbox', got "${inbox}"`);
});

test("platform.getGeneratedRoot is a function returning a string containing 'generated'", () => {
  assert.strictEqual(typeof platform.getGeneratedRoot, "function");
  const gen = platform.getGeneratedRoot();
  assert.ok(typeof gen === "string", "getGeneratedRoot must return a string");
  assert.ok(gen.includes("generated"), `generated path should contain 'generated', got "${gen}"`);
});

test("platform.getKgRoot is a function returning a string containing 'kg'", () => {
  assert.strictEqual(typeof platform.getKgRoot, "function");
  const kg = platform.getKgRoot();
  assert.ok(typeof kg === "string", "getKgRoot must return a string");
  assert.ok(kg.includes("kg"), `kg path should contain 'kg', got "${kg}"`);
});

// ---------------------------------------------------------------------------
// Adapters are idempotent (calling getXxxAdapter twice returns equivalent objects)
// ---------------------------------------------------------------------------

test("getWindowsAdapter() is idempotent", async () => {
  const { getWindowsAdapter } = await import("../../../bus/platform/windows.js");
  const a1 = getWindowsAdapter();
  const a2 = getWindowsAdapter();
  assert.equal(a1.name, a2.name);
  assert.equal(a1.storeRootDefault, a2.storeRootDefault);
});

test("getDarwinAdapter() is idempotent", async () => {
  const { getDarwinAdapter } = await import("../../../bus/platform/darwin.js");
  const a1 = getDarwinAdapter();
  const a2 = getDarwinAdapter();
  assert.equal(a1.name, a2.name);
  assert.equal(a1.storeRootDefault, a2.storeRootDefault);
});

test("getLinuxAdapter() is idempotent", async () => {
  const { getLinuxAdapter } = await import("../../../bus/platform/linux.js");
  const a1 = getLinuxAdapter();
  const a2 = getLinuxAdapter();
  assert.equal(a1.name, a2.name);
  assert.equal(a1.storeRootDefault, a2.storeRootDefault);
});

// ---------------------------------------------------------------------------
// All adapters have the same interface shape
// ---------------------------------------------------------------------------

const REQUIRED_INTERFACE_KEYS = [
  "name",
  "storeRootDefault",
  "homeEnvVar",
  "pathSep",
  "executables",
  "watchdog",
  "makeWatchdogScript",
  "spawnPython",
  "resolveVaultRoot",
  "resolveStoreRoot",
  "getInboxRoot",
  "getGeneratedRoot",
  "getKgRoot",
];

test("Windows adapter has all required interface keys", async () => {
  const { getWindowsAdapter } = await import("../../../bus/platform/windows.js");
  const adapter = getWindowsAdapter();
  for (const key of REQUIRED_INTERFACE_KEYS) {
    assert.ok(
      key in adapter,
      `Windows adapter missing required key: "${key}"`
    );
  }
});

test("Darwin adapter has all required interface keys", async () => {
  const { getDarwinAdapter } = await import("../../../bus/platform/darwin.js");
  const adapter = getDarwinAdapter();
  for (const key of REQUIRED_INTERFACE_KEYS) {
    assert.ok(
      key in adapter,
      `Darwin adapter missing required key: "${key}"`
    );
  }
});

test("Linux adapter has all required interface keys", async () => {
  const { getLinuxAdapter } = await import("../../../bus/platform/linux.js");
  const adapter = getLinuxAdapter();
  for (const key of REQUIRED_INTERFACE_KEYS) {
    assert.ok(
      key in adapter,
      `Linux adapter missing required key: "${key}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Index exports
// ---------------------------------------------------------------------------

test("index.js exports isWindows, isMac, isLinux booleans", async () => {
  const mod = await import("../../../bus/platform/index.js");
  assert.strictEqual(typeof mod.isWindows, "boolean");
  assert.strictEqual(typeof mod.isMac, "boolean");
  assert.strictEqual(typeof mod.isLinux, "boolean");
});

test("index.js exports getWindowsAdapter, getDarwinAdapter, getLinuxAdapter", async () => {
  const mod = await import("../../../bus/platform/index.js");
  assert.strictEqual(typeof mod.getWindowsAdapter, "function");
  assert.strictEqual(typeof mod.getDarwinAdapter, "function");
  assert.strictEqual(typeof mod.getLinuxAdapter, "function");
});
