#!/usr/bin/env node

import http from 'node:http';
import process from 'node:process';
import { spawn, execSync, spawnSync } from 'node:child_process';
import { accessSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

function killTree(pid) {
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
function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const parts = [];
    let cursor = index + 1;
    while (cursor < argv.length && !argv[cursor].startsWith('--')) {
      parts.push(argv[cursor]);
      cursor += 1;
    }
    if (parts.length === 0) {
      parsed.set(key, 'true');
      continue;
    }
    parsed.set(key, parts.join(' '));
    index = cursor - 1;
  }
  return parsed;
}

const args = parseArgs(process.argv);
const serverId = args.get('server-id') || 'shared-mcp';
const port = Number(args.get('port') || 9330);
const mcpPath = args.get('path') || '/mcp';
const healthPath = args.get('health-path') || '/healthz';
const encodedStdioCommand = args.get('stdio-command-b64');
const stdioCommand = encodedStdioCommand
  ? Buffer.from(encodedStdioCommand, 'base64').toString('utf8')
  : args.get('stdio-command');
const encodedEnvJson = args.get('env-json-b64');
const childExtraEnv = encodedEnvJson
  ? JSON.parse(Buffer.from(encodedEnvJson, 'base64').toString('utf8'))
  : {};
// MCP protocol version: "2024-11-05"
// Hardcoded in 4 places: manifest.json, start-shared-mcp.ps1 (2x), singleton-stdio-mcp-proxy.mjs (here).
// Must update all 4 files together when the MCP protocol version changes.
const defaultProtocolVersion = args.get('protocol-version') || '2024-11-05';
const startupTimeoutMs = Number(args.get('startup-timeout-ms') || 30000);
const requestTimeoutMs = Number(args.get('request-timeout-ms') || 120000);

if (!stdioCommand) {
  console.error(`[shared-mcp:${serverId}] missing --stdio-command`);
  process.exit(1);
}

let child = null;
let childBuffer = '';
let initialized = false;
let initResponse = null;
let initPromise = null;
let shuttingDown = false;
let restartTimer = null;
let nextRequestId = 1;

const pendingRequests = new Map();

// Uncaught exception handlers — crash loudly with useful log
process.on('uncaughtException', (err) => {
  logError(`uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logError(`unhandledRejection: ${message}`);
});

function log(message) {
  console.log(`[shared-mcp:${serverId}] ${message}`);
}

function logError(message) {
  console.error(`[shared-mcp:${serverId}] ${message}`);
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function normalizeInitializeResult(result, protocolVersion) {
  return {
    protocolVersion:
      result?.protocolVersion ||
      protocolVersion ||
      defaultProtocolVersion,
    capabilities: result?.capabilities || {},
    serverInfo: result?.serverInfo || {
      name: serverId,
      version: 'unknown',
    },
    instructions: result?.instructions,
  };
}

function rejectAllPending(errorMessage) {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(errorMessage));
  }
  pendingRequests.clear();
}

function teardownChild(reason) {
  initialized = false;
  initResponse = null;
  initPromise = null;
  childBuffer = '';
  rejectAllPending(reason);

  if (!child) {
    return;
  }

  const currentChild = child;
  child = null;

  try {
    currentChild.stdout?.removeAllListeners();
    currentChild.stderr?.removeAllListeners();
    currentChild.removeAllListeners();
  } catch {
  }

  // Kill the entire process tree so no grandchild zombies survive.
  // (child.kill() alone only kills the shell; grandchild mcpvault survives.)
  killTree(currentChild.pid);
}

function scheduleRestart(reason) {
  if (shuttingDown || restartTimer) {
    return;
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    ensureInitialized().catch((error) => {
      logError(`automatic restart failed: ${error.message}`);
      scheduleRestart('retry-after-failed-restart');
    });
  }, 1000);

  logError(`scheduled child restart: ${reason}`);
}

function handleChildExit(code, signal) {
  // Reject all pending requests with a clear error so callers know why
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`child process exited with code ${code}, signal ${signal}`));
    pendingRequests.delete(id);
  }

  const reason = `child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  logError(reason);
  teardownChild(reason);
  scheduleRestart(reason);
}

function handleChildMessage(message) {
  if (
    message &&
    Object.prototype.hasOwnProperty.call(message, 'id') &&
    pendingRequests.has(String(message.id))
  ) {
    const pending = pendingRequests.get(String(message.id));
    pendingRequests.delete(String(message.id));
    clearTimeout(pending.timeout);
    pending.resolve(message);
    return;
  }

  if (message && message.method) {
    log(`child notification: ${message.method}`);
    return;
  }

  log(`child message without pending request: ${JSON.stringify(message)}`);
}

function processChildStdout(chunk) {
  childBuffer += chunk.toString('utf8');
  const lines = childBuffer.split(/\r?\n/);
  childBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      handleChildMessage(JSON.parse(trimmed));
    } catch (error) {
      logError(`non-JSON stdout from child: ${trimmed}`);
    }
  }
}

function sendRawRequest(message, timeoutMs = requestTimeoutMs) {
  if (!child || !child.stdin) {
    return Promise.reject(new Error('child process is not available'));
  }

  const requestId = String(message.id);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  });
}

function sendNotification(message) {
  if (!child || !child.stdin) {
    throw new Error('child process is not available');
  }

  child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
}

function splitCommandLine(commandText) {
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

function resolveWindowsCommandPath(commandToken) {
  if (process.platform !== 'win32' || !commandToken) {
    return '';
  }

  if (/[\\/]/.test(commandToken) || /^[A-Za-z]:/.test(commandToken)) {
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
function resolveWindowsCmdShimLaunchSpec(commandToken, passthroughArgs, fallbackNodeExe) {
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
function cmdFallbackViaBat(executable, args) {
  const batName = `mcp-hidden-${process.pid}-${Date.now()}.bat`;
  const batPath = join(process.env.TEMP || process.env.TMP || '/tmp', batName);
  // On Windows, powershell.exe child processes of cmd.exe get a visible console
  // window by default. Inject -WindowStyle Hidden so they stay invisible.
  const isPowerShell = executable.replace(/\\/g, '/').toLowerCase().includes('powershell');
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

function resolveStdioLaunchSpec() {
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

// Kill any zombie npx/npm processes from previous child instances that survived
// a prior taskkill (e.g. grandchild processes reparented to Session Manager).
// Scans for node processes whose command line mentions "@upstash/context7-mcp",
// "@modelcontextprotocol/server-sequential-thinking", or "@playwright/mcp" and
// kills them directly with taskkill /F.
function killZombieNpxProcesses() {
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

function spawnChildProcess() {
  // Scavenge zombie npx processes from previous (failed) child instances
  // before starting a new one, to prevent zombie accumulation.
  killZombieNpxProcesses();
  clearRestartTimer();
  const launchSpec = resolveStdioLaunchSpec();
  log(`starting singleton child via: ${launchSpec.filePath} ${launchSpec.args.join(' ')}`.trim());

  // Track the temp batch path (from cmdFallbackViaBat) so we can clean it up.
  const batPath = launchSpec._batPath || null;

  child = spawn(launchSpec.filePath, launchSpec.args, {
    shell: false,
    windowsHide: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...childExtraEnv,
    },
  });

  // Clean up the temp batch file when the child exits.
  if (batPath) {
    child.on('exit', () => {
      try { require('node:fs').unlinkSync(batPath); } catch { /* best-effort */ }
    });
  }

  child.stdout.on('data', processChildStdout);
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) {
      logError(`child stderr: ${text}`);
    }
  });
  child.on('exit', handleChildExit);
  child.on('error', (error) => {
    logError(`child process error: ${error.message}`);
  });
}

async function bootstrapChild(protocolVersion = defaultProtocolVersion) {
  spawnChildProcess();

  const initId = `bootstrap-${Date.now()}-${nextRequestId += 1}`;
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

  initResponse = normalizeInitializeResult(response?.result, protocolVersion);
  initialized = true;
  sendNotification({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  log(
    `child initialized with protocol ${initResponse.protocolVersion} and server ${initResponse.serverInfo?.name || serverId}`,
  );
}

async function ensureInitialized(protocolVersion = defaultProtocolVersion) {
  if (initialized && child && !child.killed) {
    return initResponse;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await bootstrapChild(protocolVersion);
      return initResponse;
    } catch (error) {
      teardownChild(`bootstrap failed: ${error.message}`);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

async function forwardRequest(message) {
  await ensureInitialized();

  const originalId = message.id;
  const internalId = `req-${Date.now()}-${nextRequestId += 1}`;
  const forwarded = {
    ...message,
    id: internalId,
  };

  const response = await sendRawRequest(forwarded);
  return {
    ...(response || { jsonrpc: '2.0' }),
    id: originalId,
  };
}

async function forwardNotification(message) {
  await ensureInitialized();
  sendNotification(message);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 10 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        reject(new Error('empty request body'));
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendAccepted(res) {
  res.writeHead(202, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
  });
  res.end();
}

async function handleSingleRpc(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request',
      },
    };
  }

  if (message.method === 'initialize') {
    const protocolVersion =
      message.params?.protocolVersion || defaultProtocolVersion;
    const result = await ensureInitialized(protocolVersion);
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      result,
    };
  }

  if (message.method === 'notifications/initialized') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    return forwardRequest(message);
  }

  await forwardNotification(message);
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === healthPath) {
      const healthy =
        initialized && child && !child.killed && child.exitCode === null;
      if (healthy) {
        sendJson(res, 200, {
          ok: true,
          serverId,
          initialized: true,
        });
        return;
      }

      sendJson(res, 503, {
        ok: false,
        serverId,
        initialized: false,
      });
      return;
    }

    if (req.url !== mcpPath) {
      sendJson(res, 404, {
        error: 'Not found',
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    const payload = await readJsonBody(req);

    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((item) => handleSingleRpc(item))))
        .filter((item) => item !== null);

      if (responses.length === 0) {
        sendAccepted(res);
        return;
      }

      sendJson(res, 200, responses);
      return;
    }

    const response = await handleSingleRpc(payload);
    if (response === null) {
      sendAccepted(res);
      return;
    }

    sendJson(res, 200, await response);
  } catch (error) {
    sendJson(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32603,
        message: error.message || 'Internal server error',
      },
    });
  }
});

server.listen(port, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${port}${mcpPath}`);
  ensureInitialized().catch((error) => {
    logError(`initial bootstrap failed: ${error.message}`);
    scheduleRestart('initial-bootstrap-failed');
  });
});

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearRestartTimer();
  log(`received ${signal}, shutting down`);

  try {
    server.close();
  } catch {
  }

  if (child) {
    try {
      killTree(child.pid);
    } catch {
    }
  }

  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
