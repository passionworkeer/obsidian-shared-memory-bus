// Unit tests for shared-mcp/proto/windows-shim.mjs — pure resolver functions.
// Covers splitCommandLine (fully pure), cmdFallbackViaBat (fs-writing but
// deterministic), and contract checks for the process-dependent resolvers
// (resolveWindowsCommandPath, resolveWindowsCmdShimLaunchSpec,
// resolveStdioLaunchSpec, resolvePowerShellExe).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SHIM_URL = pathToFileURL(path.join(REPO_ROOT, "shared-mcp/proto/windows-shim.mjs")).href;

const {
  splitCommandLine,
  resolveWindowsCommandPath,
  resolveWindowsCmdShimLaunchSpec,
  cmdFallbackViaBat,
  resolveStdioLaunchSpec,
  resolvePowerShellExe,
  setStdioCommand,
} = await import(SHIM_URL);

// Linux runners do not guarantee TEMP/TMP; always create fixtures under the
// platform temp directory and set TEMP only for the code path being tested.
function createFixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "win-shim-test-"));
}

test("module exports the expected resolver surface", () => {
  assert.equal(typeof splitCommandLine, "function");
  assert.equal(typeof resolveWindowsCommandPath, "function");
  assert.equal(typeof resolveWindowsCmdShimLaunchSpec, "function");
  assert.equal(typeof cmdFallbackViaBat, "function");
  assert.equal(typeof resolveStdioLaunchSpec, "function");
  assert.equal(typeof resolvePowerShellExe, "function");
  assert.equal(typeof setStdioCommand, "function");
});

test("splitCommandLine tokenizes a simple command", () => {
  assert.deepEqual(splitCommandLine("npx -y foo"), ["npx", "-y", "foo"]);
});

test("splitCommandLine keeps quoted segments as single tokens", () => {
  assert.deepEqual(
    splitCommandLine('node "C:\\Program Files\\app\\index.js" --flag "a b"'),
    ["node", "C:\\Program Files\\app\\index.js", "--flag", "a b"]
  );
});

test("splitCommandLine returns [] for empty input", () => {
  assert.deepEqual(splitCommandLine(""), []);
  assert.deepEqual(splitCommandLine("   "), []);
});

test("resolveWindowsCommandPath returns '' on non-Windows or empty token (no spawn)", () => {
  if (process.platform !== "win32") {
    assert.equal(resolveWindowsCommandPath("npx"), "");
  }
  assert.equal(resolveWindowsCommandPath(""), "");
});

test("resolveWindowsCmdShimLaunchSpec returns null when the command cannot be resolved", () => {
  const spec = resolveWindowsCmdShimLaunchSpec("definitely-not-a-real-cmd-xyz", ["--arg"], "node");
  assert.equal(spec, null);
});

test("cmdFallbackViaBat produces a .bat launch spec with the executable and args", () => {
  const tmpDir = createFixtureDirectory();
  const prevTemp = process.env.TEMP;
  const prevTmp = process.env.TMP;
  process.env.TEMP = tmpDir;
  try {
    const spec = cmdFallbackViaBat("C:\\node\\node.exe", ["script.js", "--x"]);

    assert.equal(spec.filePath, "cmd.exe");
    assert.deepEqual(spec.args.slice(0, 2), ["/d", "/c"]);
    const batPath = spec.args[2];
    assert.match(batPath, /mcp-hidden-.*\.bat$/, "bat path name pattern");
    assert.ok(fs.existsSync(batPath), "temp .bat was written");

    const bat = fs.readFileSync(batPath, "utf8");
    assert.match(bat, /^@echo off\r\n/, "starts with @echo off");
    assert.ok(bat.includes('"C:\\node\\node.exe"'), "embeds the executable");
    assert.ok(bat.includes('"script.js"'), "embeds first arg");
    assert.ok(bat.includes('"--x"'), "embeds second arg");
    assert.match(bat, /exit \/B !ERRORLEVEL!\r\n$/, "exits with errorlevel");

    fs.unlinkSync(batPath);
  } finally {
    if (prevTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = prevTemp;
    if (prevTmp === undefined) delete process.env.TMP;
    else process.env.TMP = prevTmp;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("cmdFallbackViaBat injects -WindowStyle Hidden for powershell.exe", () => {
  const tmpDir = createFixtureDirectory();
  const prevTemp = process.env.TEMP;
  const prevTmp = process.env.TMP;
  process.env.TEMP = tmpDir;
  try {
    const spec = cmdFallbackViaBat("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-Command", "echo hi"]);
    const batPath = spec.args[2];
    const bat = fs.readFileSync(batPath, "utf8");
    assert.ok(bat.includes("-WindowStyle"), "hidden window flag injected");
    assert.ok(bat.includes('"Hidden"'), "Hidden value present");
    fs.unlinkSync(batPath);
  } finally {
    if (prevTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = prevTemp;
    if (prevTmp === undefined) delete process.env.TMP;
    else process.env.TMP = prevTmp;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("cmdFallbackViaBat injects -WindowStyle Hidden for pwsh.exe", () => {
  const tmpDir = createFixtureDirectory();
  const prevTemp = process.env.TEMP;
  const prevTmp = process.env.TMP;
  process.env.TEMP = tmpDir;
  try {
    const spec = cmdFallbackViaBat("C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile"]);
    const batPath = spec.args[2];
    const bat = fs.readFileSync(batPath, "utf8");
    assert.ok(bat.includes("-WindowStyle"), "hidden window flag injected for pwsh");
    fs.unlinkSync(batPath);
  } finally {
    if (prevTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = prevTemp;
    if (prevTmp === undefined) delete process.env.TMP;
    else process.env.TMP = prevTmp;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("setStdioCommand is wired into resolveStdioLaunchSpec (empty command throws)", () => {
  setStdioCommand("");
  assert.throws(() => resolveStdioLaunchSpec(), /no launch tokens/i);
});
