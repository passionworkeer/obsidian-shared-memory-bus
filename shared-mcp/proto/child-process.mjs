import { spawn, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
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

/**
 * Global command-line based process cleanup is inherently unsafe because a
 * matching npx package may belong to another repository or another user
 * session. It is therefore disabled unless the operator explicitly opts in.
 */
export function shouldRunGlobalZombieCleanup(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== 'win32') return false;
  const raw = String(env.AI_MEMORY_FORCE_GLOBAL_NPX_CLEANUP || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/**
 * Best-effort emergency cleanup for operators who explicitly accept the risk
 * of command-line based matching. Normal lifecycle cleanup must use killTree
 * with the PID owned by this proxy.
 *
 * @returns {number} number of matching process trees successfully terminated
 */
export function killZombieNpxProcesses({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!shouldRunGlobalZombieCleanup(env, platform)) {
    return 0;
  }

  const zombiePatterns = [
    '@upstash/context7-mcp',
    '@modelcontextprotocol/server-sequential-thinking',
    '@playwright/mcp',
    '@playwright/mcp/cli.js',
  ];

  logError(
    'AI_MEMORY_FORCE_GLOBAL_NPX_CLEANUP is enabled; scanning system-wide Node processes. This may terminate unrelated projects.',
  );

  let killed = 0;
  try {
    const output = execSync(
      'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
      { windowsHide: true, encoding: 'utf8', timeout: 5000 },
    );
    const lines = output.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const fields = line.split(',');
      if (fields.length < 3) continue;
      const pidField = fields.at(-1)?.trim();
      const commandField = fields.slice(1, -1).join(',').replace(/^"(.*)"$/, '$1');
      if (!pidField || !commandField) continue;
      const pid = Number.parseInt(pidField, 10);
      if (!Number.isFinite(pid) || pid === process.pid) continue;

      const pattern = zombiePatterns.find((candidate) => commandField.includes(candidate));
      if (!pattern) continue;

      try {
        execSync(`taskkill /F /T /PID ${pid}`, {
          windowsHide: true,
          timeout: 3000,
        });
        killed += 1;
        log(`killed opt-in global npx process ${pid} (${pattern})`);
      } catch {
      }
    }
  } catch (error) {
    logError(`global npx cleanup failed: ${error.message}`);
  }
  return killed;
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

  killTree(currentChild.pid);
}

export function shouldRestart(exitCode, _signal = null, _opts = {}) {
  return true;
}

export function handleChildExit(code, signal) {
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
  // Only performs a system-wide scan when the operator explicitly opted in.
  // Normal cleanup is PID-owned and handled by teardownChild/killTree.
  killZombieNpxProcesses();
  clearRestartTimer();
  const launchSpec = resolveStdioLaunchSpec();
  log(`starting singleton child via: ${launchSpec.filePath} ${launchSpec.args.join(' ')}`.trim());

  const batPath = launchSpec._batPath || null;

  if (process.platform === 'win32') {
    const exeNorm = launchSpec.filePath.replace(/\\/g, '/').toLowerCase();
    const isPowerShell = exeNorm.endsWith('/powershell.exe') || exeNorm.endsWith('/pwsh.exe');

    if (!isPowerShell) {
      const psExe = resolvePowerShellExe();
      const childBatPath = join(
        process.env.TEMP || process.env.TMP || '/tmp',
        `mcp-child-${randomBytes(16).toString('hex')}.bat`,
      );

      const childArgsLine = launchSpec.args
        .map((arg) => `"${String(arg).replace(/"/g, '""')}"`)
        .join(' ');
      const childCmdLine = `"${launchSpec.filePath}" ${childArgsLine}`;
      writeFileSync(
        childBatPath,
        `@echo off\r\n${childCmdLine}\r\nexit /B %ERRORLEVEL%\r\n`,
        { encoding: 'utf8' },
      );

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

      newChild.on('exit', () => {
        try {
          unlinkSync(childBatPath);
        } catch {
        }
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

    const hasPs1 = launchSpec.args.some((arg) =>
      arg.replace(/\\/g, '/').toLowerCase().endsWith('.ps1'),
    );
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

  if (batPath) {
    newChild.on('exit', () => {
      try {
        unlinkSync(batPath);
      } catch {
      }
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

export function spawnProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnedChild = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';
    spawnedChild.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    spawnedChild.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    spawnedChild.on('error', reject);
    spawnedChild.on('close', (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    if (options.input !== undefined) {
      spawnedChild.stdin.end(options.input);
    } else {
      spawnedChild.stdin.end();
    }
  });
}

setBootstrapChild(bootstrapChild);
setTeardownChild(teardownChild);
