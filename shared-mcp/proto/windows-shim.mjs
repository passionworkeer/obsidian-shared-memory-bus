import { spawnSync, existsSync, readFileSync, writeFileSync, accessSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import process from 'node:process';

export function splitCommandLine(commandText) {
  const tokens = [];
  const matcher = /"([^"]*)"|[^\s"]+/g;
  let match = null;
  while ((match = matcher.exec(commandText)) !== null) {
    if (typeof match[1] === 'string') {
      tokens.push(match[1]);
    } else {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

export function resolveWindowsCommandPath(commandToken) {
  if (process.platform !== 'win32' || !commandToken) {
    return '';
  }

  if (/[/]/.test(commandToken) || /^[A-Za-z]:/.test(commandToken)) {
    return existsSync(commandToken) ? commandToken : '';
  }

  try {
    const result = spawnSync('where.exe', [commandToken], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) {
      return '';
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && existsSync(line)) || '';
  } catch {
    return '';
  }
}

/**
 * Expands resolveWindowsCmdShimLaunchSpec to handle multiple batch-file patterns:
 *   1. npm-style: "%_prog%" "%~dp0\...\bin\...\js"
 *   2. bare executable + script: "%~dp0\node.exe" "%~dp0\...\js"
 *   3. quoted script only: "%~dp0\python.exe" "%~dp0\scripts\script.py"
 *   4. unquoted script: %~dp0\script.py (uvx-style)
 *
 * Returns a launch spec { filePath, args } that bypasses cmd.exe entirely,
 * or null if the shim cannot be resolved.
 */
export function resolveWindowsCmdShimLaunchSpec(commandToken, passthroughArgs, fallbackNodeExe) {
  const commandPath = resolveWindowsCommandPath(commandToken);
  if (!commandPath) {
    return null;
  }

  let content = '';
  try {
    content = readFileSync(commandPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = dirname(commandPath);

  // Pattern 1: npm shim — "%_prog%" "%~dp0\node_modules\...\bin\...\js"
  const npmMatch = content.match(
    /"%_prog%"\s+"%(?:dp0|~dp0)%\\([^"\r\n]+\.(?:js|mjs|cjs))"/i,
  );
  if (npmMatch) {
    const scriptPath = normalize(join(shimDir, npmMatch[1].replace(/\\/g, '/')));
    if (existsSync(scriptPath)) {
      const bundledNodeExe = join(shimDir, 'node.exe');
      return {
        filePath: existsSync(bundledNodeExe) ? bundledNodeExe : fallbackNodeExe,
        args: [scriptPath, ...passthroughArgs],
      };
    }
  }

  // Pattern 2: direct node/python with quoted script path — node.exe "%~dp0\...\js"
  const exeScriptMatch = content.match(
    /"(%~dp0\\(?:node|python|py|python3|uvx)[\w.-]*(?:\.exe)?)"\s+"(%~dp0[^"\r\n]+\.(?:js|mjs|cjs|py))"/i,
  );
  if (exeScriptMatch) {
    const exe = exeScriptMatch[1].replace(/%~dp0%/gi, shimDir + '\\');
    const script = exeScriptMatch[2].replace(/%~dp0%/gi, shimDir + '\\');
    if (existsSync(exe) && existsSync(script)) {
      return { filePath: exe, args: [script, ...passthroughArgs] };
    }
  }

  // Pattern 3: bare script path (no leading exe) — uvx / npx style
  const bareScriptMatch = content.match(
    /"(%~dp0[^"\r\n]+\.(?:js|mjs|cjs|py))"/i,
  );
  if (bareScriptMatch) {
    const script = bareScriptMatch[1].replace(/%~dp0%/gi, shimDir + '\\');
    if (existsSync(script)) {
      // Detect interpreter from the shebang or batch context.
      // Check for node first, then python.
      const bundledNode = join(shimDir, 'node.exe');
      if (existsSync(bundledNode)) {
        return { filePath: bundledNode, args: [script, ...passthroughArgs] };
      }
      // Fall back to python from PATH (don't guess a specific path).
      const pythonShim = join(shimDir, 'python.exe');
      if (existsSync(pythonShim)) {
        return { filePath: pythonShim, args: [script, ...passthroughArgs] };
      }
      // Last resort: use fallback node (may not work for .py files but
      // avoids the visible cmd.exe window at least).
      return { filePath: fallbackNodeExe, args: [script, ...passthroughArgs] };
    }
  }

  return null;
}

/**
 * Returns a launch spec for cmd.exe that runs the given executable+args
 * via a temporary batch file. This is the most reliable way to suppress
 * the visible console window on Windows — cmd.exe /c "..." still sometimes
 * creates a flicker even with windowsHide, but cmd.exe /c batch-file avoids it.
 */
export function cmdFallbackViaBat(executable, args) {
  const batName = `mcp-hidden-${process.pid}-${Date.now()}.bat`;
  const batPath = join(process.env.TEMP || process.env.TMP || '/tmp', batName);
  // On Windows, powershell.exe child processes of cmd.exe get a visible console
  // window by default. Inject -WindowStyle Hidden so they stay invisible.
  const exeNorm = executable.replace(/\\/g, '/').toLowerCase();
  const isPowerShell = exeNorm.endsWith('/powershell.exe') || exeNorm.endsWith('/pwsh.exe');
  const psArgs = isPowerShell
    ? ['-WindowStyle', 'Hidden', ...args]
    : args;
  const argLine = psArgs.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
  writeFileSync(batPath,
    `@echo off\r\n"${executable}" ${argLine}\r\nexit /B !ERRORLEVEL!\r\n`,
    { encoding: 'utf8' });
  return {
    filePath: 'cmd.exe',
    args: ['/d', '/c', batPath],
    _batPath: batPath,  // stored for potential cleanup
  };
}

export function resolveStdioLaunchSpec() {
  const tokens = splitCommandLine(stdioCommand);
  if (tokens.length === 0) {
    throw new Error('stdio command produced no launch tokens');
  }

  const nodeExe = process.env.NODE_EXE || process.execPath;
  const isWindows = process.platform === 'win32';
  const firstToken = tokens[0];
  const resolvedFirstToken = isWindows
    ? resolveWindowsCommandPath(firstToken) || firstToken
    : firstToken;

  if (isWindows && /^npx(?:\.cmd|\.exe)?$/i.test(firstToken)) {
    const nodeDir = dirname(nodeExe);
    const npxScript = join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    try {
      accessSync(npxScript);
      return {
        filePath: nodeExe,
        args: [npxScript, ...tokens.slice(1)],
      };
    } catch {
      // Layer 1 + 3: use temp-batch approach so cmd.exe creates no window.
      return cmdFallbackViaBat('npx', tokens);
    }
  }

  if (isWindows && /\.(js|mjs|cjs)$/i.test(resolvedFirstToken)) {
    return {
      filePath: nodeExe,
      args: [resolvedFirstToken, ...tokens.slice(1)],
    };
  }

  if (isWindows && /\.(cmd|bat)$/i.test(resolvedFirstToken)) {
    // Layer 2: try expanded shim resolution first.
    const shimLaunchSpec = resolveWindowsCmdShimLaunchSpec(firstToken, tokens.slice(1), nodeExe);
    if (shimLaunchSpec) {
      return shimLaunchSpec;
    }

    // Layer 1 + 3: shim resolution failed — fall back via temp batch.
    return cmdFallbackViaBat(resolvedFirstToken, tokens.slice(1));
  }

  return {
    filePath: resolvedFirstToken,
    args: tokens.slice(1),
  };
}

/**
 * On Windows, spawn all non-PowerShell children via a hidden PowerShell
 * intermediary so that the ENTIRE process tree (powershell → cmd/npx/node →
 * grandchild node) runs inside one invisible console.
 *
 * - windowsHide: true on Node's spawn() only sets CREATE_NO_WINDOW for the
 *   direct child.  Grandchild processes (e.g. npx's internal node.exe) are
 *   not affected and may independently allocate a visible console window.
 * - PowerShell launched with -WindowStyle Hidden has no console window.
 *   Any child processes it spawns (cmd.exe, npx, node.exe …) inherit that
 *   hidden console, so no window appears at any level of the tree.
 *
 * The approach: write the full child-launch command to a temp .bat file,
 * then run it via `powershell -WindowStyle Hidden -Command "cmd /c bat;exit
 * $LASTEXITCODE"`.  PowerShell's stdin/stdout/stderr are piped to the proxy,
 * and the proxy's JSON-RPC traffic is forwarded verbatim to the grandchild.
 */
export function resolvePowerShellExe() {
  if (process.platform !== 'win32') return '';
  // Try thepwsh (PowerShell 7) first, then fall back to powershell.exe.
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = spawnSync(name, ['-Version'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
      });
      if (result.status === 0 || result.error?.code !== 'ENOENT') {
        // Found – return the full path from where.exe.
        const r2 = spawnSync('where.exe', [name], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 3000,
        });
        if (r2.status === 0 && r2.stdout) {
          const found = r2.stdout.split(/\r?\n/)[0].trim();
          if (found) return found;
        }
        return name; // fall back to bare name if where fails
      }
    } catch { /* try next */ }
  }
  return 'powershell.exe';
}

// These are placeholders that get rebound by rpc.mjs at startup.
// Functions here use them lazily so importing order doesn't matter.
let stdioCommand = '';
export function setStdioCommand(cmd) { stdioCommand = cmd; }