import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const USER_HOME = process.env.USERPROFILE || "";
const APP_DATA = process.env.APPDATA || path.join(USER_HOME, "AppData", "Roaming");
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(USER_HOME, "AppData", "Local");

// ---------------------------------------------------------------------------
// Env var cache (matches the pattern in omni-memory-server.js)
// ---------------------------------------------------------------------------

const WINDOWS_ENV_CACHE = new Map();

// ---------------------------------------------------------------------------
// readWindowsEnvironmentVariable
// Reads a Windows registry environment variable (User or Machine scope).
// Falls back to '' on any error.
// ---------------------------------------------------------------------------

function readWindowsEnvironmentVariable(name) {
  if (WINDOWS_ENV_CACHE.has(name)) {
    return WINDOWS_ENV_CACHE.get(name);
  }

  const escapedName = String(name || "").replace(/'/g, "''");
  const command = [
    `$value = [Environment]::GetEnvironmentVariable('${escapedName}', 'User')`,
    "if ([string]::IsNullOrWhiteSpace($value)) {",
    `  $value = [Environment]::GetEnvironmentVariable('${escapedName}', 'Machine')`,
    "}",
    "if (-not [string]::IsNullOrWhiteSpace($value)) { [Console]::Out.Write($value) }",
  ].join(" ");

  let value = "";
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      value = String(result.stdout || "").trim();
    }
  } catch (_error) {
    value = "";
  }

  WINDOWS_ENV_CACHE.set(name, value);
  return value;
}

// ---------------------------------------------------------------------------
// firstNonEmptyEnv — checks process.env first, then registry
// ---------------------------------------------------------------------------

function firstNonEmptyEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const name of names) {
    const value = readWindowsEnvironmentVariable(name);
    if (value) {
      return value;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// runWindowsPowerShellProbe
// ---------------------------------------------------------------------------

function runWindowsPowerShellProbe(scriptLines = []) {
  if (!Array.isArray(scriptLines) || scriptLines.length === 0) {
    return { ok: false, stdout: "", stderr: "", status: null };
  }
  try {
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", scriptLines.join("\n")], {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: !probe.error && probe.status === 0,
      stdout: String(probe.stdout || "").trim(),
      stderr: String(probe.stderr || "").trim(),
      status: probe.status,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: String(error || ""),
      status: null,
    };
  }
}

// ---------------------------------------------------------------------------
// resolvePowerShellCommand
// ---------------------------------------------------------------------------

function resolvePowerShellCommand() {
  // Always prefer powershell.exe on Windows
  try {
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (!probe.error && probe.status === 0) {
      return "powershell.exe";
    }
  } catch (_error) {
    // fall through
  }
  return firstNonEmptyEnv("AI_MEMORY_PWSH") || "powershell.exe";
}

// ---------------------------------------------------------------------------
// VBS watchdog path — placed in Windows Startup folder
// ---------------------------------------------------------------------------

const WATCHDOG_VBS_NAME = "AI Memory Watchdog.vbs";

function getWatchdogScriptPath() {
  return path.join(
    APP_DATA,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    WATCHDOG_VBS_NAME,
  );
}

// ---------------------------------------------------------------------------
// makeWatchdogScript
// Generates a VBScript that:
//   1. Writes the current PID to pidPath
//   2. Loops, monitoring that PID
//   3. If the monitored process dies, runs callbackScript
// ---------------------------------------------------------------------------

function makeWatchdogScript(pidPath, callbackScript) {
  // Escape for VBScript single-quoted strings:
  // 1. Backslash → '\\'  (prevents \X being interpreted as VBS escape)
  // 2. Single-quote → "''"
  const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "''");
  const escapedPidPath = esc(pidPath);
  const escapedCallback = esc(callbackScript);

  return `\
' AI Memory Watchdog Supervisor (VBScript)
' Generated by obsidian-shared-memory-bus bus/platform/windows.js
Option Explicit

Dim pidPath, callbackScript, targetPid, objFSO, objShell, intervalSec
pidPath = '${escapedPidPath}'
callbackScript = '${escapedCallback}'
intervalSec = 15

Set objFSO = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("WScript.Shell")

' Write current PID so the supervisor can be identified
Dim f
Set f = objFSO.CreateTextFile(pidPath, True)
f.Write CStr(WScript.CreateObject("WScript.Shell").Exec("cmd /c echo %PID%").StdOut.ReadAll())
f.Close()

Function IsProcessRunning(pid)
    On Error Resume Next
    Dim p
    Set p = objShell.Exec("tasklist /FI " & Chr(34) & "PID eq " & pid & Chr(34))
    Dim output
    If Not p Is Nothing Then
        output = p.StdOut.ReadAll()
        IsProcessRunning = (InStr(output, " " & pid & " ") > 0 Or InStr(output, vbCrLf & pid & " ") > 0)
    Else
        IsProcessRunning = False
    End If
    On Error GoTo 0
End Function

Do
    WScript.Sleep intervalSec * 1000

    ' Read target PID from pidPath (first non-empty line)
    If objFSO.FileExists(pidPath) Then
        Dim lines, i, line
        lines = Split(objFSO.OpenTextFile(pidPath).ReadAll(), vbCrLf)
        targetPid = ""
        For i = 0 To UBound(lines)
            line = Trim(lines(i))
            If line <> "" Then
                targetPid = line
                Exit For
            End If
        Next
    End If

    If targetPid <> "" Then
        If Not IsProcessRunning(targetPid) Then
            ' Target died — invoke callback
            On Error Resume Next
            objShell.Run callbackScript, 0, False
            On Error GoTo 0
            ' Exit supervisor after callback fires
            Exit Do
        End If
    End If
Loop
`;
}

// ---------------------------------------------------------------------------
// spawnPython
// Wraps spawn('python', args, options) with windowsHide: true and a UTF env.
// ---------------------------------------------------------------------------

function spawnPython(args, options = {}) {
  const PYTHONUTF8 = process.env.PYTHONUTF8 || "1";
  const PYTHONIOENCODING = process.env.PYTHONIOENCODING || "utf-8";

  return spawn("python", args, {
    ...options,
    windowsHide: true,
    env: {
      ...(options.env || process.env),
      PYTHONUTF8,
      PYTHONIOENCODING,
    },
  });
}

// ---------------------------------------------------------------------------
// Utility: isDirectory
// ---------------------------------------------------------------------------

function isDirectory(candidate) {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Default store candidates (non-Obsidian)
// ---------------------------------------------------------------------------

function getDefaultStoreCandidates() {
  return [
    "E:\\Obsidian Vault",
    "D:\\Obsidian Vault",
  ];
}

// ---------------------------------------------------------------------------
// resolveVaultRoot — DEPRECATED: alias for resolveStoreRoot
// ---------------------------------------------------------------------------

/**
 * @deprecated Use resolveStoreRoot() instead. resolveVaultRoot is kept for
 * backward compatibility only and will be removed in a future version.
 */
function resolveVaultRoot(options = {}) {
  return resolveStoreRoot(options);
}

// ---------------------------------------------------------------------------
// Store root resolution
// ---------------------------------------------------------------------------

const MIN_FREE_SPACE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function getDriveFreeSpace(driveLetter) {
  try {
    const psScript = `[math]::Round((Get-PSDrive -Name '${driveLetter}' | Select-Object -ExpandProperty Free) / 1KB)`;
    const out = spawnSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`,
      { windowsHide: true, timeout: 5000, encoding: "utf8" }
    );
    const kb = parseFloat(String(out.stdout || "").trim());
    return isNaN(kb) ? 0 : Math.round(kb * 1024);
  } catch {
    return 0;
  }
}

function detectBestDrive() {
  const candidates = [];
  for (let i = 68; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      const freeBytes = getDriveFreeSpace(letter);
      if (freeBytes >= MIN_FREE_SPACE_BYTES) {
        candidates.push({ letter, freeBytes });
      }
    } catch {
      // Drive not accessible
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.freeBytes - a.freeBytes);
  const best = candidates[0];
  return { drive: best.letter + ":", path: path.join(best.letter + ":", ".ai-memory"), freeBytes: best.freeBytes };
}

const DEFAULT_STORE_ROOT = "E:\\.ai-memory";
let cachedStoreRoot = null;

function resolveStoreRoot(options = {}) {
  if (cachedStoreRoot && !options.refresh) return cachedStoreRoot;

  for (const envKey of ["AI_MEMORY_STORE", "AI_MEMORY_STORE_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate) {
      cachedStoreRoot = path.resolve(candidate);
      return cachedStoreRoot;
    }
  }

  const best = detectBestDrive();
  if (best) {
    cachedStoreRoot = best.path;
    return cachedStoreRoot;
  }

  const aiMemoryRoot = process.env.AI_MEMORY_ROOT || "";
  const fallback = aiMemoryRoot
    ? path.join(aiMemoryRoot, ".ai-memory")
    : DEFAULT_STORE_ROOT;

  cachedStoreRoot = fallback;
  return fallback;
}

function getInboxRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "inbox");
}

function getGeneratedRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "generated");
}

function getKgRoot(storeRoot) {
  return path.join(storeRoot || resolveStoreRoot(), "kg");
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

let _adapter = null;

function getWindowsAdapter() {
  if (_adapter) return _adapter;

  _adapter = {
    name: "windows",
    storeRootDefault: DEFAULT_STORE_ROOT,
    homeEnvVar: "USERPROFILE",
    pathSep: "\\",
    executables: {
      python: "python",
      node: "node",
      powershell: "powershell.exe",
    },
    watchdog: {
      scriptExtension: ".vbs",
      scriptPath: getWatchdogScriptPath(),
    },
    makeWatchdogScript,
    spawnPython,
    resolveVaultRoot,
    resolveStoreRoot,
    getDefaultStoreCandidates,
    getInboxRoot,
    getGeneratedRoot,
    getKgRoot,
    // Internal utilities exposed for use by omni-memory-server.js
    readWindowsEnvironmentVariable,
    firstNonEmptyEnv,
    runWindowsPowerShellProbe,
    resolvePowerShellCommand,
    isDirectory,
  };

  return _adapter;
}

export { getWindowsAdapter };
