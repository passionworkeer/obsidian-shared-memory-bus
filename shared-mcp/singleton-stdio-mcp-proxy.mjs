#!/usr/bin/env node

// Singleton stdio MCP HTTP proxy. Split into focused modules:
//   - ./proto/rpc.mjs           (JSON-RPC + HTTP transport primitives, shared state)
//   - ./proto/windows-shim.mjs  (Windows command / shim / PowerShell resolution)
//   - ./proto/child-process.mjs (one stdio child process: spawn / teardown / bootstrap)
//   - ./proto/restart.mjs       (automatic child restart on crash)
//
// This file is the entrypoint: it parses CLI args, validates required input,
// boots the HTTP server, and wires the shutdown signal handlers.

import http from 'node:http';
import process from 'node:process';

import './proto/child-process.mjs'; // side-effect: registers bootstrap/teardown hooks

import {
  stdioCommand,
  serverId,
  port,
  mcpPath,
  healthPath,
  child,
  initialized,
  shuttingDown,
  setShuttingDown,
  log,
  logError,
  clearRestartTimer,
  ensureInitialized,
  handleSingleRpc,
  readJsonBody,
  sendJson,
  sendAccepted,
  ResourceLimitError,
} from './proto/rpc.mjs';
import { resolveProxyBindHost } from './proto/bind-host.mjs';
import { isAllowedLocalHttpRequest } from './proto/http-guard.mjs';
import { scheduleRestart } from './proto/restart.mjs';
import { killTree } from './proto/child-process.mjs';

if (!stdioCommand) {
  console.error(`[shared-mcp:${serverId}] missing --stdio-command`);
  process.exit(1);
}

const bindHost = resolveProxyBindHost();

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedLocalHttpRequest(req.headers)) {
      sendJson(res, 403, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Forbidden: request is not same-origin loopback',
        },
      });
      return;
    }

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
    const isResourceLimit = error instanceof ResourceLimitError;
    sendJson(res, isResourceLimit ? error.statusCode : 500, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: isResourceLimit ? error.code : -32603,
        message: error.message || 'Internal server error',
      },
    });
  }
});

server.listen(port, bindHost, () => {
  log(`listening on http://${bindHost}:${port}${mcpPath}`);
  ensureInitialized().catch((error) => {
    logError(`initial bootstrap failed: ${error.message}`);
    scheduleRestart('initial-bootstrap-failed');
  });
});

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  setShuttingDown(true);
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
