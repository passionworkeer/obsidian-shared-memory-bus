import process from 'node:process';
import { setStdioCommand } from './windows-shim.mjs';

// ----- Argument parsing -----

export function parseArgs(argv) {
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

export const args = parseArgs(process.argv);
export const serverId = args.get('server-id') || 'shared-mcp';
export const port = Number(args.get('port') || 9330);
export const mcpPath = (() => {
  const raw = args.get('path') || '/mcp';
  // Guard against Git Bash on Windows expanding /mcp to an absolute drive path
  // such as D:/Git/mcp. In that case, reset to the canonical /mcp.
  if (/^[A-Za-z]:[/\\]/.test(raw)) return '/mcp';
  return raw;
})();
export const healthPath = args.get('health-path') || '/healthz';
export const encodedStdioCommand = args.get('stdio-command-b64');
export const stdioCommand = encodedStdioCommand
  ? Buffer.from(encodedStdioCommand, 'base64').toString('utf8')
  : args.get('stdio-command');
export const encodedEnvJson = args.get('env-json-b64');
export const childExtraEnv = encodedEnvJson
  ? JSON.parse(Buffer.from(encodedEnvJson, 'base64').toString('utf8'))
  : {};
// MCP protocol version: "2024-11-05"
// Hardcoded in 4 places: manifest.json, start-shared-mcp.ps1 (2x), singleton-stdio-mcp-proxy.mjs (here).
// Must update all 4 files together when the MCP protocol version changes.
export const defaultProtocolVersion = args.get('protocol-version') || '2024-11-05';
export const startupTimeoutMs = Number(args.get('startup-timeout-ms') || 30000);
export const requestTimeoutMs = Number(args.get('request-timeout-ms') || 120000);

setStdioCommand(stdioCommand);

// ----- Shared module-level state (live bindings; readers in other modules) -----

export let child = null;
export let childBuffer = '';
export let initialized = false;
export let initResponse = null;
export let initPromise = null;
export let shuttingDown = false;
export let restartTimer = null;
export let nextRequestId = 1;
export const pendingRequests = new Map();

export function setChild(v) { child = v; }
export function setChildBuffer(v) { childBuffer = v; }
export function appendChildBuffer(chunk) { childBuffer += chunk; }
export function setInitialized(v) { initialized = v; }
export function setInitResponse(v) { initResponse = v; }
export function setInitPromise(v) { initPromise = v; }
export function setShuttingDown(v) { shuttingDown = v; }
export function setRestartTimer(v) { restartTimer = v; }
export function bumpNextRequestId() { nextRequestId += 1; return nextRequestId; }

// ----- Logging -----

process.on('uncaughtException', (err) => {
  logError(`uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logError(`unhandledRejection: ${message}`);
});

export function log(message) {
  console.log(`[shared-mcp:${serverId}] ${message}`);
}

export function logError(message) {
  console.error(`[shared-mcp:${serverId}] ${message}`);
}

export function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

export function normalizeInitializeResult(result, protocolVersion) {
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

export function rejectAllPending(errorMessage) {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(errorMessage));
  }
  pendingRequests.clear();
}

// ----- RPC primitives -----

export function sendRawRequest(message, timeoutMs = requestTimeoutMs) {
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

export function sendNotification(message) {
  if (!child || !child.stdin) {
    throw new Error('child process is not available');
  }

  child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
}

export function handleChildMessage(message) {
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

export function processChildStdout(chunk) {
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
    } catch {
      logError(`non-JSON stdout from child: ${trimmed}`);
    }
  }
}

export async function forwardRequest(message) {
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

export async function forwardNotification(message) {
  await ensureInitialized();
  sendNotification(message);
}

export function readJsonBody(req) {
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

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendAccepted(res) {
  res.writeHead(202, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
  });
  res.end();
}

export async function handleSingleRpc(message) {
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

export async function ensureInitialized(protocolVersion = defaultProtocolVersion) {
  if (initialized && child && !child.killed) {
    return initResponse;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await _bootstrapChild(protocolVersion);
      return initResponse;
    } catch (error) {
      _teardownChild(`bootstrap failed: ${error.message}`);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

// Late-bound hooks filled in by child-process.mjs at import time.
let _bootstrapChild = async () => { throw new Error('bootstrapChild not wired'); };
let _teardownChild = (_reason) => {};
export function setBootstrapChild(fn) { _bootstrapChild = fn; }
export function setTeardownChild(fn) { _teardownChild = fn; }