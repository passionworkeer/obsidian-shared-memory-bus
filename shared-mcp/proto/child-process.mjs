import { spawn, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  resolveStdioLaunchSpec,
  resolvePowerShellExe,
} from './windows-shim.mjs';
import {
  child,
  setChild,
  setInitialized,
  setInitResponse,
  setInitPromise,
  setChildBuffer,
  pendingRequests,
  sendRawRequest,
  sendNotification,
  clearRestartTimer,
  normalizeInitializeResult,
  rejectAllPending,
  processChildStdout,
  log,
  logError,
  childExtraEnv,
  serverId,
  defaultProtocolVersion,
  startupTimeoutMs,
  bumpNextRequestId,
  initResponse,
  setBootstrapChild,
  setTeardownChild,
} from './rpc.mjs';

export function killTree(pid) {
  if (!pid || pid <= 0) {
    return;
  }
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      // /F = force kill, /T = kill process tree (children + grandchildren)
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
      }
    }
  } catch {
  }
}

// Kill any zombie npx/npm processes from previous child instances that survived
// a prior taskkill (e.g. grandchild processes reparented to Session Manager).
// Scans for node processes whose command line mentions "@upstash/context7-mcp",
// "@modelcontextprotocol/server-sequential-thinking", or "@playwright/mcp" and
// kills them directly with taskkill /F.
export function killZombieNpxProcesses() {
  if (process.platform !== 'win32') {
    return;
  }
  const zombiePatterns = [
    '@upstash/context7-mcp',
    '@modelcontextprotocol/server-sequential-thinking',
    '@playwright/mcp',         // matches npx wrapper commands
    '@playwright/mcp/cli.js',   // matches reparented playwright CLI child processes
  ];
  try {
    // WMIC is available on all Windows and supports wide command-line matching
    const output = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }
    );
    const lines = output.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const fields = line.split(',');
      if (fields.length < 3) continue;
      const pidField = fields[1]?.trim();
      const cmdField = fields.slice(2).join(',').replace(/^"(.*)"$/, '$1');
      if (!pidField || !cmdField) continue;
      const pid = parseInt(pidField, 10);
      if (isNaN(pid) || pid === process.pid) continue;
      for (const pattern of zombiePatterns) {
        if (cmdField.includes(pattern)) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, timeout: 3000 });
            log(`killed zombie npx process ${pid} (${pattern})`);
          } catch {
          }
          break;
        }
      }
    }
  } catch {
  }
}

export function teardownChild(reason) {
  setInitialized(false);
  setInitResponse(null);
  setInitPromise(null);
  setChildBuffer('');
  rejectAllPending(reason);

  if (!child) {
    return;
  }

  const currentChild = child;
  setChild(null);

  try {
    currentChild.stdout?.removeAllListeners();
    currentChild.stderr?.removeAllListeners();
    currentChild.removeAllListeners();
  } catch {
  }

  // Kill the entire process tree so no grandchild zombies survive.
  killTree(currentChild.pid);
}

// Pure decision helper: whether a child that exited with the given code/signal
// should be considered restart-eligible. Currently all exits are retryable;
// the per-process max-attempts cap lives in restart.mjs. Exposed as a testable
// seam so callers/tests can reason about the policy without spawning subprocesses.
export function shouldRestart(exitCode, _signal = null, _opts = {}) {
  // signal is intentionally unused for now; opts reserved for future policy
  // (e.g. treating a clean SIGTERM-based shutdown as terminal). Kept in
  // signature so the public helper is stable if policy is added later.
  return true;
}

export function handleChildExit(code, signal) {
  // Reject all pending requests with a clear error so callers know why
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`child process exited with code ${code}, signal ${signal}`));
    pendingRequests.delete(id);
  }

  const reason = `child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  logError(reason);
  teardownChild(reason);
  if (shouldRestart(code, signal)) {
    scheduleRestart(reason);
  }
}

import { scheduleRestart } from './restart.mjs';

export function spawnChildProcess() {
  // Scavenge zombie npx processes from previous (failed) child instances
  // before starting a new one, to prevent zombie accumulation.
  killZombieNpxProcesses();
  clearRestartTimer();
  const launchSpec = resolveStdioLaunchSpec();
  log(`starting singleton child via: ${launchSpec.filePath} ${launchSpec.args.join(' ')}`.trim());

  // Track the temp batch path (from cmdFallbackViaBat) so we can clean it up.
  const batPath = launchSpec._batPath || null;

  if (process.platform === 'win32') {
    const exeNorm = launchSpec.filePath.replace(/\\/g, '/').toLowerCase();
    const isPowerShell = exeNorm.endsWith('/powershell.exe') || exeNorm.endsWith('/pwsh.exe');

    if (!isPowerShell) {
      // Write the child's launch command to a temp .bat so PowerShell can
      // invoke it via cmd /c without needing its own visible window.
      const psExe = resolvePowerShellExe();
      const childBatPath = join(process.env.TEMP || process.env.TMP || '/tmp',
        `mcp-child-${process.pid}-${Date.now()}.bat`);

      // Build the literal command that the batch file will run.
      // Arguments that contain spaces are double-quoted; double-quotes inside
      // an argument are escaped by doubling them — the standard CMD convention.
      const childArgsLine = launchSpec.args
        .map(a => `"${String(a).replace(/"/g, '""')}"`)
        .join(' ');
      const childCmdLine = `"${launchSpec.filePath}" ${childArgsLine}`;
      writeFileSync(childBatPath,
        `@echo off\r\n${childCmdLine}\r\nexit /B !ERRORLEVEL!\r\n`,
        { encoding: 'utf8' });

      // PowerShell launched with -WindowStyle Hidden has no console window.
      // cmd.exe started by PowerShell inherits that hidden console, so no
      // window appears at any depth of the tree (npx → npm → node → script).
      const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-Command',
        `cmd /d /c "${childBatPath}"; exit $LASTEXITCODE`,
      ];

      log(`spawning hidden PowerShell intermediary: ${psExe} ${psArgs.join(' ')}`.trim());
      const newChild = spawn(psExe, psArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...childExtraEnv },
      });
      setChild(newChild);

      // Clean up the temp batch file when the child (PowerShell) exits.
      newChild.on('exit', () => {
        try { unlinkSync(childBatPath); } catch { /* best-effort */ }
      });

      newChild.stdout.on('data', processChildStdout);
      newChild.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text) logError(`child stderr: ${text}`);
      });
      newChild.on('exit', handleChildExit);
      newChild.on('error', (error) => logError(`child process error: ${error.message}`));
      return;
    }

    // PowerShell direct path (obsidian / MiniMax runners): inject
    // -WindowStyle Hidden so the window stays invisible even when node's
    // windowsHide flag alone is insufficient.
    const hasPs1 = launchSpec.args.some(a => a.replace(/\\/g, '/').toLowerCase().endsWith('.ps1'));
    if (hasPs1 && !launchSpec.args.includes('-WindowStyle')) {
      log('injecting -WindowStyle Hidden into PowerShell .ps1 launch');
      launchSpec.args = ['-WindowStyle', 'Hidden', ...launchSpec.args];
    }
  }

  const newChild = spawn(launchSpec.filePath, launchSpec.args, {
    shell: false,
    windowsHide: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...childExtraEnv },
  });
  setChild(newChild);

  // Clean up the temp batch file when the child exits.
  if (batPath) {
    newChild.on('exit', () => {
      try { unlinkSync(batPath); } catch { /* best-effort */ }
    });
  }

  newChild.stdout.on('data', processChildStdout);
  newChild.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) {
      logError(`child stderr: ${text}`);
    }
  });
  newChild.on('exit', handleChildExit);
  newChild.on('error', (error) => {
    logError(`child process error: ${error.message}`);
  });
}

export async function bootstrapChild(protocolVersion = defaultProtocolVersion) {
  spawnChildProcess();

  const initId = `bootstrap-${Date.now()}-${bumpNextRequestId()}`;
  const initializeRequest = {
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {
        roots: {
          listChanged: true,
        },
        sampling: {},
      },
      clientInfo: {
        name: 'shared-mcp-proxy',
        version: '1.0.0',
      },
    },
  };

  const response = await sendRawRequest(initializeRequest, startupTimeoutMs);
  if (response?.error) {
    throw new Error(response.error.message || 'child initialize failed');
  }

  setInitResponse(normalizeInitializeResult(response?.result, protocolVersion));
  setInitialized(true);
  sendNotification({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  log(
    `child initialized with protocol ${initResponse.protocolVersion} and server ${initResponse.serverInfo?.name || serverId}`,
  );
}

// Wire rpc.mjs's late-bound hooks to our implementations.
setBootstrapChild(bootstrapChild);
setTeardownChild(teardownChild);