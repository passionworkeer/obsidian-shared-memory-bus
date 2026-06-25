// Module helper loaders + MCP tool dispatch for the omni-memory-server.
//
// This module owns:
//   - Dynamic `import()` of the bus/* + ops/memory/* helper modules.
//   - The MCP tool handler registry assembled from createMemory* outputs.
//   - The Server instance + request handlers for ListTools / CallTool.
//
// ESM note: dynamic imports use pathToFileURL because Windows paths contain
// ':' which the bare-path import specifier rejects under ESM resolution rules.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOLS } from "./memory-tools.js";
import { pickTools, pickHandlers } from "./tool-registry.js";
import { createMemoryRetrieval } from "./memory-retrieval.js";
import { createMemoryGeneration } from "./memory-generation.js";
import { createMemoryBridge } from "./memory-bridge.js";
import { createMemoryStatus } from "./memory-status.js";
import { createMemoryEmbeddings } from "./memory-embeddings.js";
import { generateTraceId, withTrace } from "./metrics/structured-logger.js";

import { resolveRuntimePath } from "./omni-platform-helpers.js";

// ---------------------------------------------------------------------------
// Dynamic helper loaders
// ---------------------------------------------------------------------------
async function loadStoreRootHelper() {
  const helperPath = resolveRuntimePath("store-root.js", path.join("bus", "store-root.js"));
  return import(pathToFileURL(helperPath).href);
}

async function loadPythonRuntimeHelper() {
  const helperPath = resolveRuntimePath("python-runtime.js", path.join("bus", "python-runtime.js"));
  return import(pathToFileURL(helperPath).href);
}

async function loadRuntimeConfigHelper() {
  const helperPath = resolveRuntimePath("runtime-config.js", path.join("bus", "runtime-config.js"));
  return import(pathToFileURL(helperPath).href);
}

async function loadEmbeddingProviderHelper() {
  const helperPath = resolveRuntimePath("embedding-provider-registry.js", path.join("bus", "embedding-provider-registry.js"));
  return import(pathToFileURL(helperPath).href);
}

async function loadMemoryContractHelper() {
  const helperPath = resolveRuntimePath("memory/memory-contract.js", path.join("ops", "memory", "memory-contract.js"));
  return import(pathToFileURL(helperPath).href);
}

// Use dynamic import() instead of require() to support ESM modules with top-level await.
// Must be async and called from top-level (file is ESM via --experimental-default-type or .mjs).
async function loadMcpMemoryHandler(resolveProjectPath) {
  const { handlers: mcpMemoryHandlers } = await import(
    pathToFileURL(resolveProjectPath(path.join("ops", "mcp", "mcp-memory-tools-handler.js"))).href
  );
  return mcpMemoryHandlers;
}

// ---------------------------------------------------------------------------
// MCP tool handler registry + dispatch
// ---------------------------------------------------------------------------
function buildHandlerRegistry(sharedParams, mcpMemoryHandlers) {
  const retrieval = createMemoryRetrieval(sharedParams);
  const generation = createMemoryGeneration(sharedParams);
  const bridge = createMemoryBridge(sharedParams);
  const status = createMemoryStatus(sharedParams);
  const embeddings = createMemoryEmbeddings(sharedParams);

  const ALL_HANDLERS = {};
  for (const source of [
    status.handlers,
    retrieval.handlers,
    generation.handlers,
    bridge.handlers,
    embeddings.handlers,
    mcpMemoryHandlers,
  ]) {
    for (const [name, handler] of Object.entries(source)) {
      ALL_HANDLERS[name] = handler;
    }
  }
  return ALL_HANDLERS;
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
  };
}

function createMcpServer() {
  return new Server(
    { name: "omni-memory-mesh", version: "3.1.0" },
    { capabilities: { tools: {} } },
  );
}

/**
 * 注册 MCP 请求 handler。
 *
 * 新增 toolFilter 参数 (债项 #1 server-split):
 *   - undefined / null / [] → 全部 29 个工具 (向后兼容,monolithic 模式)
 *   - readonly string[]     → 只暴露该子集 (4 个独立 server 各自的子集)
 *
 * 同时过滤 ListTools 的返回和 CallTool 的可调用范围 ——
 * 子集之外的工具调用直接返回 tool-not-found,避免误路由。
 */
function registerMcpRequestHandlers(server, { ALL_HANDLERS, METRICS, log, toolFilter }) {
  const exposedTools = pickTools(toolFilter);
  const exposedHandlers = pickHandlers(ALL_HANDLERS, toolFilter);
  const allowedNames = new Set(exposedTools.map((t) => t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments || {};
    const traceId = generateTraceId();

    // Wrap handler execution inside a trace context so all nested async calls
    // have the same traceId visible to structured logging and metrics.
    return await withTrace(traceId, async () => {
      METRICS.mcp_requests_total[name] = (METRICS.mcp_requests_total[name] || 0) + 1;

      // 子集外的工具直接拒绝 —— 避免 monolithic handler 表泄漏。
      if (!allowedNames.has(name)) {
        log.warn("mcp-tool-not-exposed", { tool: name, traceId });
        return errorResult(`tool-not-found: ${name}`);
      }

      const handler = exposedHandlers[name];
      if (!handler) {
        log.warn("mcp-tool-not-found", { tool: name, traceId });
        return errorResult(`tool-not-found: ${name}`);
      }

      try {
        const result = await handler(args);
        log.debug("mcp-request-completed", { tool: name, traceId });
        return result;
      } catch (error) {
        log.error("mcp-request-error", { tool: name, traceId, error: error instanceof Error ? error.message : String(error) });
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    });
  });
}

export {
  loadStoreRootHelper,
  loadPythonRuntimeHelper,
  loadRuntimeConfigHelper,
  loadEmbeddingProviderHelper,
  loadMemoryContractHelper,
  loadMcpMemoryHandler,
  buildHandlerRegistry,
  createMcpServer,
  registerMcpRequestHandlers,
  errorResult,
};