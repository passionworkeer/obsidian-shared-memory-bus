#!/usr/bin/env node

import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';

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

function spawnChildProcess() {
  clearRestartTimer();
  log(`starting singleton child via: ${stdioCommand}`);
  child = spawn(stdioCommand, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ...childExtraEnv,
    },
  });

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
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
        }
      }
      child = null;
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
      child.kill();
    } catch {
    }
  }

  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
