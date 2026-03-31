#!/usr/bin/env node
/**
 * Playwright MCP stdio wrapper
 * Bridges stdio-based MCP calls to the HTTP/SSE-based Playwright MCP server
 * Uses mcp-session-id header for session affinity (StreamableHTTP transport)
 */
const http = require('http');
const readline = require('readline');

const PLAYWRIGHT_HOST = 'localhost';
const PLAYWRIGHT_PORT = 9337;

let requestId = 1;
let mcpSessionId = null;

// Persistent agent for keep-alive
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

// Parse SSE-streamed response body and find response for a given id
function parseSSE(data, targetId) {
  const lines = data.split(/\n/);
  let result = null;
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const json = JSON.parse(line.slice(6));
        if (json.id !== undefined && String(json.id) === String(targetId)) {
          result = json;
        } else if (json.method) {
          // Forward server-initiated notifications to stdout
          process.stdout.write(JSON.stringify(json) + '\n');
        }
      } catch (e) {
        // skip malformed lines
      }
    }
  }
  return result;
}

// Send HTTP POST and collect SSE response
function httpPost(method, params, id) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: String(id), method, params });
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };
    if (mcpSessionId) {
      headers['mcp-session-id'] = mcpSessionId;
    }

    const req = http.request({ hostname: PLAYWRIGHT_HOST, port: PLAYWRIGHT_PORT, path: '/mcp', method: 'POST', headers, agent }, (res) => {
      // Capture mcp-session-id from first response
      if (!mcpSessionId && res.headers['mcp-session-id']) {
        mcpSessionId = res.headers['mcp-session-id'];
        process.stderr.write('[playwright-stdio-proxy] Session: ' + mcpSessionId + '\n');
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const result = parseSSE(data, id);
        if (result) {
          resolve(result);
        } else {
          resolve({ id: String(id), error: { code: -32603, message: 'No response for id ' + id + ' | data: ' + data.slice(0, 200) } });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Send HTTP POST with NO id (notification) — no response body expected
function httpPostNotification(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };
    if (mcpSessionId) {
      headers['mcp-session-id'] = mcpSessionId;
    }

    const req = http.request({ hostname: PLAYWRIGHT_HOST, port: PLAYWRIGHT_PORT, path: '/mcp', method: 'POST', headers, agent }, (res) => {
      // Capture mcp-session-id from response headers
      if (!mcpSessionId && res.headers['mcp-session-id']) {
        mcpSessionId = res.headers['mcp-session-id'];
        process.stderr.write('[playwright-stdio-proxy] Session: ' + mcpSessionId + '\n');
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ ok: true, data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function initialize() {
  const res = await httpPost('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'playwright-stdio', version: '1.0.0' }
  }, 0);

  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: '0', result: res.result || {} }) + '\n');
  process.stderr.write('[playwright-stdio-proxy] Server: ' + (res.result?.serverInfo?.name || 'unknown') + ' v' + (res.result?.serverInfo?.version || '') + '\n');

  // Send initialized notification
  await httpPostNotification('notifications/initialized', {});
}

// Check if Playwright MCP HTTP server is reachable
function checkServer() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: PLAYWRIGHT_HOST, port: PLAYWRIGHT_PORT, path: '/mcp', agent }, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// Main stdio loop
async function main() {
  // Verify server is reachable
  const ok = await checkServer();
  if (!ok) {
    process.stderr.write('[playwright-stdio-proxy] ERROR: Playwright MCP HTTP server not running on port ' + PLAYWRIGHT_PORT + '\n');
    process.stderr.write('[playwright-stdio-proxy] Start it with: npx @playwright/mcp --port ' + PLAYWRIGHT_PORT + ' --headless --allowed-origins *\n');
    process.exit(1);
  }

  try {
    await initialize();
  } catch (e) {
    process.stderr.write('[playwright-stdio-proxy] Failed to connect to Playwright MCP: ' + e.message + '\n');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (!msg.method) return; // skip responses
      if (msg.method === 'initialize') return; // already done

      const id = msg.id;
      if (!id) {
        // Notification — no response expected
        httpPostNotification(msg.method, msg.params);
        return;
      }

      // Translate stdio tool methods to HTTP tools/call format
      // Claude Code sends tool names as methods; Playwright MCP uses tools/call
      const stdioMethods = ['initialize', 'tools/list', 'tools/call', 'ping', 'notifications/initialized', 'notifications/cancelled'];
      let httpMethod = msg.method;
      let httpParams = msg.params;
      if (!stdioMethods.includes(msg.method)) {
        // This is a tool invocation — translate to tools/call
        httpMethod = 'tools/call';
        httpParams = { name: msg.method, arguments: msg.params || {} };
      }

      const response = await httpPost(httpMethod, httpParams, id);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e) {
      process.stderr.write('[playwright-stdio-proxy] Error: ' + e.message + '\n');
    }
  });
}

main();
