# Server Split 架构文档 · `omni-memory-server.js` 拆分

> English: Architecture record for splitting the 1447-line monolithic `omni-memory-server.js` into a thin entrypoint plus sibling modules.
> 中文：本文记录 `omni-memory-server.js` 从 1447 行单体拆分为 thin entrypoint + 多个 sibling 模块的设计与现状。
>
> 关联文档：`tech-debt-roadmap.md` 债项 #1 · `docs/architecture/OVERVIEW.md`

---

## 1. 概述

`shared-mcp/omni-memory-server.js` 是 obsidian-shared-memory-bus 的核心 MCP 入口，承担了 manifest 加载、IPC 协议、HTTP 代理、结构化日志、子进程 spawn、embedding worker、health check、trace manager、Python 检索、Prometheus metrics、config parser、MCP server 主循环等十余种职责。拆分前它是一个 **1447 行的 God Server**，所有 32 个 MCP 工具注册在同一个进程里，任何一处改动都要在一个巨型文件里定位上下文。

本次拆分（对应 `tech-debt-roadmap.md` 债项 #1）将其精简为 **约 278 行的 thin entrypoint**，仅负责：

- 装配 sibling 模块导出的 helper（`omni-store` / `omni-platform-helpers` / `omni-handlers` / `omni-metrics`）；
- 解析运行时脚本路径与路径常量；
- 组装 `sharedParams` bundle 并下发给各 `createMemory*` 工厂；
- 创建 MCP `Server` 实例、注册 `ListTools` / `CallTool` handler；
- 启动 stdio transport + HTTP metrics endpoint；
- 通过底部 re-exports 保留原始模块表面，确保旧 importer 不受影响。

原本耦合在单体里的工具实现被拆分到 5 个 `memory-*.js` 工厂模块（retrieval / generation / bridge / status / embeddings），工具定义集中到 `memory-tools.js` 的 `TOOLS` 常量，平台探测、metrics 管线、进程管理则各自独立成 sibling 模块。

**拆分收益**：

| 维度 | 拆分前 | 拆分后 |
|---|---|---|
| 入口文件行数 | 1447 | ~278（thin entrypoint） |
| 单文件最大职责数 | 10+ | 1（装配 + 启动） |
| 可独立单测的模块 | 1 | 13+ |
| 工具实现定位成本 | 全文搜索巨型文件 | 按工厂模块直查 |

---

## 2. 拆分前 vs 拆分后

### 2.1 拆分前（1447 行单体）

```
┌──────────────────────────────────────────────────────┐
│           omni-memory-server.js (1447 行)            │
│  ┌──────────┬──────────┬──────────┬─────────────┐     │
│  │Manifest  │IPC      │HTTP     │Structured  │     │
│  │加载      │Protocol │Proxy    │Logger      │     │
│  ├──────────┼──────────┼──────────┼─────────────┤     │
│  │子进程    │Embedding│Health   │Trace       │     │
│  │Spawn     │Worker   │Check    │Manager     │     │
│  ├──────────┼──────────┼──────────┼─────────────┤     │
│  │Python    │Prometheus│Config  │MCP Server  │     │
│  │检索      │Metrics  │Parser   │主循环      │     │
│  └──────────┴──────────┴──────────┴─────────────┘     │
│  32 个 MCP 工具注册在同一个进程里                       │
└──────────────────────────────────────────────────────┘
```

### 2.2 拆分后（thin entrypoint + sibling 模块）

```
                          npm start
                             │
                             ▼
                        start.js ──reads──► shared-mcp/port-registry.js
                             │
                  spawn singleton-stdio-mcp-proxy.mjs
                             │  (stdio: node --experimental-default-type=module
                             │          omni-memory-server.js)
                             ▼
┌──────────────────────────────────────────────────────┐
│        omni-memory-server.js  (~278 行 thin entry)   │
│                                                      │
│  装配 sharedParams · 创建 Server · 注册 handler       │
│  启动 stdio transport + HTTP /metrics                │
│  re-exports 保留原始模块表面                          │
└───┬───────┬──────────┬──────────┬───────────┬────────┘
    │       │          │          │           │
    ▼       ▼          ▼          ▼           ▼
┌───────┐┌────────┐┌─────────┐┌─────────┐┌──────────┐
│omni-  ││omni-   ││omni-    ││omni-    ││memory-   │
│store  ││platform││handlers ││metrics  ││tools     │
│       ││helpers ││         ││(shim)   ││(TOOLS)   │
└───────┘└────────┘└────┬────┘└────┬────┘└──────────┘
                        │          │
        ┌───────────────┼────┐     │ re-export
        ▼   ▼   ▼   ▼   ▼    ▼     ▼
   ┌──────┐┌──────┐┌──────┐┌──────┐┌──────────┐┌──────────────┐
   │memory││memory││memory││memory││memory-   ││metrics/      │
   |-ret- ││-gen- ││-br-  ││-stat ││embeddings││ source.js    │
   │rieval││eration││idge ││us    ││          ││ compute.js   │
   └──────┘└──────┘└──────┘└──────┘└──────────┘│ server.js    │
                                                └──────────────┘
   每个工厂返回 { handlers } → 由 omni-handlers.buildHandlerRegistry
   合并成 ALL_HANDLERS，注册到 MCP Server 的 CallTool handler
```

---

## 3. 当前模块职责表

下表列出拆分后 `shared-mcp/` 下的全部 sibling 模块及其职责与行数（行数为当前磁盘实测值）。

| 模块 | 行数 | 职责 |
|---|---|---|
| `omni-memory-server.js` | ~278 | **Thin entrypoint**。装配 sibling helper、解析运行时脚本与路径常量、组装 `sharedParams`、创建 MCP `Server`、注册 `ListTools`/`CallTool` handler、启动 stdio transport + HTTP metrics endpoint、注册进程退出清理、底部 re-exports 保留原始模块表面。 |
| `omni-store.js` | 48 | 项目路径解析。导出 `PROJECT_ROOT` / `AI_MEMORY_ROOT` / `IS_WINDOWS` / `USER_HOME` 常量、`resolveProjectPath()` 辅助函数，并 re-export `bus/store-root.js` 的 `resolveStoreRoot`。import 时无副作用。 |
| `omni-platform-helpers.js` | 293 | Windows 环境 / 注册表探测。拥有 `WINDOWS_ENV_CACHE`、`firstNonEmptyEnv` / `buildMergedEnv`（批量 PowerShell 读取注册表变量）、`resolvePowerShellCommand`、`resolveRuntimePath`、watchdog supervisor 存活探测。非 Windows 平台安全降级返回空值。 |
| `omni-handlers.js` | 146 | 动态 `import()` 加载 `bus/*` 与 `ops/memory/*` helper 模块（store-root / python-runtime / runtime-config / embedding-provider-registry / memory-contract / mcp-memory-tools-handler）；`buildHandlerRegistry()` 合并 5 个 `createMemory*` 工厂 + mcpMemoryHandlers 为 `ALL_HANDLERS`；`createMcpServer()` + `registerMcpRequestHandlers()` 装配 MCP Server 与 trace 上下文。 |
| `omni-metrics.js` | 45 | **Re-export shim**。实现已拆分到 `metrics/index.js` → `source.js`（磁盘/状态读取 + METRICS 计数器）、`compute.js`（snapshot 渲染 + search-worker 生命周期）、`server.js`（HTTP `/metrics` transport + 刷新间隔）。shim 保留拆分前的公共导出表面。 |
| `memory-tools.js` | 569 | MCP 工具定义单一真值源。导出 `TOOLS` 常量数组，包含全部 32 个工具的 `name` / `description` / `inputSchema`。功能与拆分前内联在 server 里的定义保持一致。 |
| `memory-retrieval.js` | 705 | 检索类工具工厂 `createMemoryRetrieval(params)`。覆盖 `search_shared_memory` / `get_memory_records` / `refine_memory_selection` / `get_memory_timeline` / `clear_shared_memory_search_cache` / `get_entity_info` / `search_by_entity` / `get_kg_stats` / `query_kg` / `get_entities` / `get_relationships`。通过 search worker IPC 调用，失败回退一次性 spawn。 |
| `memory-bridge.js` | 418 | 外部桥接工具工厂 `createMemoryBridge(params)`。覆盖 `query_claude_mem` / `insert_claude_mem`（claude-mem HTTP API，含持久化验证回退）/ `get_blackboard_tasks` / `write_blackboard_task`（OpenClaw blackboard SQLite，内联 Python `-c` 脚本）。 |
| `memory-status.js` | 448 | 状态/概览工具工厂 `createMemoryStatus(params)`。覆盖 `memory_status`（watchdog / integrity / embeddings / claude-mem health 综合快照）、`get_memory_overview`、`memory_wake_up`（构建分层 bootstrap pack：identity / essential / recent / retrieve）。 |
| `memory-embeddings.js` | 217 | Embedding 管理工具工厂 `createMemoryEmbeddings(params)`。覆盖 `rebuild_memory_embeddings` / `rebuild_shared_embeddings`（spawn `generate-embeddings.js`）、`list_embedding_runtimes`、`set_embedding_runtime`（运行时切换 + search worker 联动重启）。 |
| `memory-generation.js` | 144 | 派生产物生成工具工厂 `createMemoryGeneration(params)`。覆盖 `rebuild_memory_layers` / `build_handoff_pack` / `run_memory_dream`，均通过 spawn `memory-bus.ps1 -Action RefreshDerivedArtifacts` 刷新 derived artifacts。 |
| `health-check.js` | 162 | 隔离子进程健康检查工具。提供 `PROBE_TYPES`、`isProcessAlive`、`probeHttp`、`probeStdioMcp`、`waitForHealthy`、`buildServiceSnapshot`，支持 MCP initialize / HTTP health / HTTP metrics / stdio echo 四种探针。 |
| `ipc-protocol.js` | 82 | Search worker 隔离 IPC 协议。定义 `IPC_ACTIONS`（search / health / clear_cache / get_records / timeline）、`IPC_ERROR_CODES`（WORKER_UNAVAILABLE / CIRCUIT_OPEN / BACKPRESSURE / TIMEOUT 等）、`buildRequest` / `parseResponse` / `buildError` / `validateRequest`。JSON over stdin/stdout，换行分隔，`id` 字段做请求/响应关联。 |
| `manifest.json` | 117 | MCP server 清单。声明 9 个 server 的 id / displayName / mode / port / stdio 或 launch 命令 / probe 类型 / notes。memory server 条目含 `isolatedSubprocess` 描述 search-worker 的隔离与重启策略。 |
| `port-registry.js` | 37 | 端口分配单一真值源。导出 `DEFAULT_BASE_PORT` (9330)、`MCP_SERVERS`（fetch / time / memory 三者）、`CRITICAL_PORTS`、`resolveBasePort()`、`getServerPort()`。被 `start.js` 与 `cli/ai-memory.js` 共同消费，消除两处端口列表漂移。 |

> 说明：`omni-metrics.js` 本身是 re-export shim，真正实现位于 `shared-mcp/metrics/` 下的 `source.js` / `compute.js` / `server.js`（由 `metrics/index.js` 汇总导出）。这是拆分过程中保留向后兼容的典型手法。

---

## 4. 入口流程

从用户启动到 MCP 工具可调用的完整调用链：

```
npm start
  │  (package.json: "start": "node start.js")
  ▼
start.js  (项目根)
  │  import { MCP_SERVERS, getServerPort, resolveBasePort } from "./shared-mcp/port-registry.js"
  │  遍历 MCP_SERVERS：
  │    - 检查端口占用 (isPortInUse)
  │    - 若 server.script 存在 → startPowerShellScript()
  │    - 否则 → startSingletonProxy() 启动 singleton-stdio-mcp-proxy.mjs
  ▼
对 memory server (port 9338)：
  spawn singleton-stdio-mcp-proxy.mjs
    --server-id memory --port 9338
    --stdio-command-b64 "node --experimental-default-type=module omni-memory-server.js"
  │  proxy 把 stdio MCP 桥接为 HTTP /mcp 端点
  ▼
omni-memory-server.js  (thin entrypoint, ESM top-level await)
  │
  ├─ 1. import 静态依赖
  │     omni-store        → PROJECT_ROOT / AI_MEMORY_ROOT / IS_WINDOWS / resolveProjectPath / resolveStoreRoot
  │     omni-platform-helpers → firstNonEmptyEnv / buildMergedEnv / resolvePowerShellCommand / resolveRuntimePath
  │     omni-handlers     → load*Helper / buildHandlerRegistry / createMcpServer / registerMcpRequestHandlers
  │     omni-metrics      → METRICS / read* / search-worker 生命周期 / startMetricsServer / log
  │
  ├─ 2. 解析运行时脚本路径
  │     SEARCH_SCRIPT      = resolveRuntimePath("semantic_search.py", "retrieval/semantic_search.py", ...)
  │     EMBEDDINGS_SCRIPT  = resolveRuntimePath("generate-embeddings.js", "bus/generate-embeddings.js")
  │     MEMORY_BUS_SCRIPT  = resolveRuntimePath("memory-bus.ps1", "bus/memory-bus.ps1")
  │
  ├─ 3. top-level await 加载 helper 命名空间
  │     loadStoreRootHelper()           → resolveStoreRoot
  │     loadPythonRuntimeHelper()       → resolvePythonRuntime / withPythonArgs
  │     loadEmbeddingProviderHelper()   → buildEmbeddingConfigHash
  │     loadMemoryContractHelper()      → buildMemoryIntegrityReport
  │     loadRuntimeConfigHelper()       → buildEmbeddingRuntimeCatalog / resolveEmbeddingRuntime / updateEmbeddingRuntimeSelection
  │     loadMcpMemoryHandler(resolveProjectPath) → mcpMemoryHandlers
  │
  ├─ 4. 计算路径常量
  │     STORE_ROOT = resolveStoreRoot()
  │     STRUCTURED_ROOT / GENERATED_ROOT / EMBEDDINGS_INDEX_PATH / VAULT_ROOT / HANDOFF_PACK_JSON_PATH ...
  │
  ├─ 5. 组装 sharedParams bundle
  │     汇聚 METRICS / 路径常量 / 运行时脚本 / Python runtime / search-worker 依赖
  │     绑定 read*Summary / getSearchWorkerHealth / requestSearchWorker 等 bound 函数
  │
  ├─ 6. 构建 handler registry + 装配 MCP Server
  │     ALL_HANDLERS = buildHandlerRegistry(sharedParams, mcpMemoryHandlers)
  │       └─ createMemoryRetrieval / Generation / Bridge / Status / Embeddings
  │            各自返回 { handlers } → 合并为 ALL_HANDLERS
  │     server = createMcpServer()  // { name: "omni-memory-mesh", version: "3.1.0" }
  │     registerMcpRequestHandlers(server, { ALL_HANDLERS, METRICS, log })
  │       └─ ListTools → { tools: TOOLS }
  │       └─ CallTool  → withTrace(traceId, () => handler(args))，含 mcp_requests_total 计数
  │
  ├─ 7. 注册进程事件
  │     uncaughtException → log.error + exit(1)
  │     unhandledRejection → log.error
  │     exit → killSearchWorkerOnExit()（best-effort）
  │
  ├─ 8. Bootstrap
  │     log.info("omni-memory-server-starting", { pid, version, storeRoot, vaultRoot, nodeVersion })
  │     transport = new StdioServerTransport()
  │     await server.connect(transport)
  │
  └─ 9. 启动 metrics 刷新 + HTTP server
        startMetricsRefreshInterval({ GENERATED_ROOT, STORE_ROOT, readEmbeddingsSummary })
        startMetricsServer({ EMBEDDINGS_INDEX_PATH, readEmbeddingRuntimeSummary })
        // HTTP /metrics 端点对外暴露 Prometheus 格式指标
```

调用一个 MCP 工具（例如 `search_shared_memory`）时的运行时路径：

```
Client (Claude/Codex/...) ──HTTP /mcp──► singleton-stdio-mcp-proxy.mjs
                                              │  stdio JSON-RPC
                                              ▼
                                    omni-memory-server.js
                                              │  CallTool handler
                                              ▼
                                    registerMcpRequestHandlers
                                              │  withTrace(traceId)
                                              ▼
                                    ALL_HANDLERS["search_shared_memory"]
                                              │  = createMemoryRetrieval(params).handlers.search_shared_memory
                                              ▼
                                    params.requestSearchWorker(payload, 120000)
                                              │  IPC over stdin/stdout (ipc-protocol.js)
                                              ▼
                                    isolated search-worker (Python semantic_search.py)
                                              │  失败回退
                                              ▼
                                    runSemanticSearchOnce() 一次性 spawn
```

---

## 5. 端口分配表

端口分配的单一真值源是 `shared-mcp/manifest.json`（声明全部 9 个 server）与 `shared-mcp/port-registry.js`（被 `start.js` 实际启动的子集 + doctor 探针列表）。两者通过 `DEFAULT_BASE_PORT = 9330` 对齐。

### 5.1 manifest.json 声明的全部 server

| id | displayName | mode | port | probeType | 启动方式 | 备注 |
|---|---|---|---|---|---|---|
| context7 | Context7 | shared | 9331 | mcp-initialize | stdio (npx @upstash/context7-mcp) | 无状态文档/代码搜索，适合共享 |
| fetch | Fetch | shared | 9332 | mcp-initialize | stdio (python -m mcp_server_fetch) | 无状态 fetch |
| time | Time | shared | 9333 | mcp-initialize | stdio (python -m mcp_server_time) | 无状态工具 |
| sequential-thinking | Sequential Thinking | shared | 9334 | mcp-initialize | stdio (npx @modelcontextprotocol/server-sequential-thinking) | 多为无状态推理辅助 |
| obsidian | Obsidian | shared | 9335 | — | stdio (PowerShell runner) | 指向单一 canonical vault |
| MiniMax | MiniMax Coding Plan | optional | 9336 | — | stdio (PowerShell runner) | 需 MINIMAX_API_KEY |
| playwright | Playwright | optional | 9337 | mcp-initialize | HTTP launch (npx @playwright/mcp --host --port) | 独立 HTTP server，隔离 MCP session |
| memory | Memory | shared | 9338 | mcp-initialize | stdio (node --experimental-default-type=module omni-memory-server.js) | **本文主角**。含 isolated subprocess search-worker（restartPolicy: always, maxRestarts: 5, circuitWindowMs: 300000） |
| pencil | Pencil | isolated | — | — | — | UI 绑定状态，保持每客户端隔离 |

### 5.2 port-registry.js 实际启动子集

`start.js` 仅启动 `MCP_SERVERS` 中列出的 3 个 server；其余由各自 runner 或按需拉起。

| id | port | command | args |
|---|---|---|---|
| fetch | 9332 | python | `['-m', 'mcp_server_fetch']` |
| time | 9333 | python | `['-m', 'mcp_server_time']` |
| memory | 9338 | node | `['--experimental-default-type=module', 'omni-memory-server.js']` |

- `DEFAULT_BASE_PORT = 9330`（可通过 `AI_MEMORY_BASE_PORT` 环境变量覆盖）
- `CRITICAL_PORTS = [9331, 9332, 9333, 9334, 9335, 9338]`（`ai-memory doctor` 探测共享 MCP 可用性的端口列表）
- `getServerPort(server, basePort)` 支持整体端口平移：`basePort + (server.port - DEFAULT_BASE_PORT)`
- 默认 host `127.0.0.1`，默认 path `/mcp`，默认 healthPath `/healthz`

---

## 6. 兼容性说明

拆分遵循「先拆分、再兼容」原则，通过 re-export 保留原始模块表面，确保任何现有 importer 无需改动。

### 6.1 `omni-memory-server.js` 底部 re-exports

entrypoint 末尾显式 re-export 拆分前由本文件直接提供的全部符号，外部 `import { STORE_ROOT, METRICS, readEmbeddingsSummary, ... } from "./omni-memory-server.js"` 调用保持工作：

```javascript
export {
  resolveProjectPath, resolveStoreRoot,
  STORE_ROOT, MEMORY_STORE_ROOT, STRUCTURED_ROOT, GENERATED_ROOT,
  EMBEDDINGS_INDEX_PATH, VAULT_ROOT,
  METRICS, readWatchdogState, readEmbeddingsSummary, readEmbeddingRuntimeSummary,
  readMemoryIntegritySummary, readMemoryHygieneReport,
  buildEmbeddingIndexState, annotateEmbeddingRuntimeCatalog,
  readEmbeddingRuntimeCatalog, buildEmbeddingRuntimeRestartSignature,
  isSearchWorkerRunning, getSearchWorkerSnapshot, restartSearchWorker, ensureSearchWorker,
};
```

### 6.2 `omni-metrics.js` re-export shim

`omni-metrics.js` 不再包含实现，改为从 `./metrics/index.js` re-export 全部公共符号（`log` / `METRICS` / `read*` / search-worker 生命周期 / `startMetricsServer` / `startMetricsRefreshInterval` 等）。现有 `import { ... } from "./omni-metrics.js"` 调用方（如 entrypoint）无需修改。

### 6.3 工具定义不变

`memory-tools.js` 的 `TOOLS` 常量与拆分前内联在 server 里的工具定义功能等价；`ListTools` handler 仍返回 `{ tools: TOOLS }`，客户端可见的工具列表与 schema 不变。

### 6.4 行为不变承诺

- 端口 9338、stdio 启动命令、`/mcp` 与 `/metrics` 端点路径均不变；
- `sharedParams` bundle 字段集合覆盖各工厂原有依赖，工厂内部逻辑未改动；
- search-worker 隔离与重启策略（`isolatedSubprocess` in manifest.json）不变。

---

## 7. 未来演进

本次拆分完成的是 `tech-debt-roadmap.md` 债项 #1 的 **PR-1.1 ~ PR-1.2 + PR-1.4（兼容层 + 文档）**：把单体拆成 thin entrypoint + sibling 模块，但仍是**单进程**。roadmap §1.2 的 **PR-1.3** 提出下一步——把 server 主体进一步拆为 **4 个独立进程**，实现真正的进程隔离。

### 7.1 目标：4-server 独立拆分

```
┌────────────────────┐  ┌────────────────────┐
│omni-memory-         │  │omni-memory-         │
│retrieval-server     │  │bridge-server        │
│(端口 9338)          │  │(端口 9339)          │
│                     │  │                     │
│  memory_status      │  │  claude-mem 桥接    │
│  search_shared      │  │  blackboard 桥接    │
│  get_records        │  │  import_from_claude │
│                     │  │  export_to_obsidian │
└────────────────────┘  └────────────────────┘
        ↑                        ↑
        │ 共享 ~/.ai-memory/      │
        │ SQLite + JSONL          │
        │                        │
┌────────────────────┐  ┌────────────────────┐
│omni-memory-         │  │omni-memory-         │
│dream-server         │  │mgmt-server          │
│(端口 9340)          │  │(端口 9341)          │
│                     │  │                     │
│  async_promote      │  │  list_embedding_    │
│  async_archive      │  │  runtimes           │
│  nightly_dream      │  │  set_embedding_     │
│  integrity_check    │  │  runtime            │
│                     │  │  rebuild_index      │
└────────────────────┘  └────────────────────┘
```

### 7.2 拆分映射（当前模块 → 目标 server）

| 目标 server | 端口 | 承接的当前模块 | 目标行数 |
|---|---|---|---|
| `omni-memory-retrieval-server.js` | 9338 | `memory-status.js` + `memory-retrieval.js` | ≤ 350 |
| `omni-memory-bridge-server.js` | 9339 | `memory-bridge.js` | ≤ 250 |
| `omni-memory-dream-server.js` | 9340 | `memory-generation.js` | ≤ 300 |
| `omni-memory-mgmt-server.js` | 9341 | `memory-embeddings.js` | ≤ 280 |

### 7.3 配套工作

- 同步更新 `shared-mcp/manifest.json` 端口分配（新增 9339 / 9340 / 9341）与 `port-registry.js` 的 `MCP_SERVERS` / `CRITICAL_PORTS`；
- 新增 `mcp-process-manager.js`（≤ 250 行）负责 spawn 4 个子 server、监控健康、按需重启；
- `omni-memory-server.js` 退化为「all-in-one 兼容入口」（≤ 100 行），新用户走 4 个独立 server，旧用户继续用兼容层；
- 每个 server 独立 `npm test:unit` 通过，CI 跑两套测试（拆分版 + monolithic）。

> 详见 `tech-debt-roadmap.md` §1.2（PR 拆分清单）、§1.3（目标代码骨架）、§3 Phase 1 W2-W4 周次计划。

---

## 8. 回滚 Checklist

参考 `tech-debt-roadmap.md` §1.4 与 §5（回滚策略）。拆分已落地，以下 checklist 用于在后续演进（4-server 拆分）出现问题时回退到当前 thin-entrypoint 状态或更早的 monolith 状态。

### 8.1 Tag 与版本

- [ ] 保留 git tag `v3.1.0-monolith`（拆分前的最后一个 commit，monolith 状态）
- [ ] 当前 thin-entrypoint 状态打 tag（如 `v3.1.x-thin-entry`）作为 4-server 拆分的回退点
- [ ] 4-server 拆分阶段每个 PR 前打 RC tag（`v3.2.0-rc1` 等）

### 8.2 兼容层

- [ ] `omni-memory-server.js` 作为兼容入口**永不删除**——即使 4-server 拆分完成，旧调用方式仍须工作
- [ ] `manifest.json` 保留 `"compatibility_mode": true` 字段（4-server 阶段引入）
- [ ] `omni-metrics.js` re-export shim 保留，直到所有调用方迁移到 `metrics/index.js` 直连

### 8.3 文档与 CI

- [ ] README 标注「独立 server 是默认，monolithic 是兼容模式」（4-server 阶段）
- [ ] CI 跑两套测试：拆分版（4 server）+ monolithic（兼容层），两者均须全绿
- [ ] 本文档（`docs/architecture/SERVER-SPLIT.md`）随每次拆分阶段更新模块表与端口表

### 8.4 数据与端口

- [ ] `~/.ai-memory/` 下数据格式不变（schema 兼容），索引可重建
- [ ] 端口 9338 永久保留给 memory server（兼容层或 retrieval-server），避免客户端配置失效
- [ ] 新增端口 9339 / 9340 / 9341 不与现有 `CRITICAL_PORTS` 冲突

### 8.5 用户回退路径

- [ ] 提供 `npm install obsidian-shared-memory-bus@3.1.0` 即可退回 monolith
- [ ] `docs/RELEASING.md` 写明回退步骤
- [ ] README 顶部加 "Stability Tiers" 说明

---

## 附录 · 模块依赖关系速查

```
omni-memory-server.js (entrypoint)
  ├── omni-store.js ──► bus/store-root.js
  ├── omni-platform-helpers.js ──► omni-store.js
  ├── omni-handlers.js
  │     ├── memory-tools.js (TOOLS)
  │     ├── memory-retrieval.js ──► memory-tools.js
  │     ├── memory-generation.js
  │     ├── memory-bridge.js
  │     ├── memory-status.js
  │     ├── memory-embeddings.js
  │     ├── metrics/structured-logger.js
  │     ├── omni-platform-helpers.js (resolveRuntimePath)
  │     └── (dynamic import) bus/* + ops/memory/* + ops/mcp/mcp-memory-tools-handler.js
  ├── omni-metrics.js (shim) ──► metrics/index.js
  │     ├── metrics/source.js
  │     ├── metrics/compute.js
  │     └── metrics/server.js
  ├── (sibling, 未被 entry 直接 import)
  │     ├── health-check.js
  │     ├── ipc-protocol.js
  │     ├── port-registry.js ◄── start.js
  │     └── manifest.json ◄── launcher / doctor
  └── @modelcontextprotocol/sdk (StdioServerTransport)
```
