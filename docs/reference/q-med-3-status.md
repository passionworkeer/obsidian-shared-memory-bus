# Q-MED-3 错误风格化 — 范围描述与现状

> 状态: **不立独立 PR**,仅做 1 处微升级 (`errorResult` 接受 code) + 范围描述文档化。
> 决策来源: `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md` §8 PR8 (Round 2 收尾)
> 适用: 任何后续 wave 想全局统一错误风格时,先读本文档再立项。

---

## 1. 审计原文

> `bus/` 多处 → 4 套不同错误返回风格: `process.exit(N)` / async handler / `throw` / MCP `isError`
> ⏸️ 留作长期 cleanup (审计本身已说"按需修",立独立 PR 收益低)

来源: `docs/PROJECT_AUDIT_2026-07-09.md:298` Q-MED-3。

---

## 2. 实测现状 (2026-07-10)

### 2.1 4 套错误返回风格的散落点位

| 风格 | 命中位置 (grep `throw new Error` / `process.exit` / `isError: true`) | 处数 |
|---|---|---:|
| 1. `throw new Error(string-prefix)` | `bus/generate-embeddings.js` `bus/runtime-config.js` `shared-mcp/memory-bridge.js` `shared-mcp/memory-embeddings.js` `shared-mcp/memory-generation.js` `shared-mcp/memory-retrieval.js` `shared-mcp/omni-platform-helpers.js` `shared-mcp/metrics/compute.js` `shared-mcp/proto/child-process.mjs` `shared-mcp/proto/windows-shim.mjs` `shared-mcp/proto/rpc.mjs` `shared-mcp/embedding-worker-pool.cjs` `cli/cli/lib/resolve-vault-root.js` | ~30 |
| 2. `process.exit(N)` 顶层主入口失败 | `bus/generate-embeddings.js:803` | 1 |
| 3. MCP `isError: true` 工具结果 | `shared-mcp/memory-bridge.js` `shared-mcp/memory-retrieval.js` `shared-mcp/omni-handlers.js:errorResult()` (5+ 工具工厂各自的 `errorResult()`) | ~10 |
| 4. async handler 隐式吞错 | 无显式 catch 块的回调 | 不计 |

合计 ~40 处散落。

### 2.2 `DomainError` 局部落地情况

`bus/domain-error.js` 已在 **embedding-provider 子系统** 局部使用:

| 文件 | `throw new DomainError` 处数 |
|---|---:|
| `bus/embedding-provider-registry.js` | 8 |
| `bus/embedding-providers/openai-compatible-provider.js` | 5 |
| `bus/embedding-providers/gemini-provider.js` | 2 |
| `bus/embedding-providers/transformer-provider.js` | 1 |
| `shared-mcp/metrics/server.js` | 1 |
| 合计 | **17** |

`domain-error.js` 顶部注释明说:

> Adoption: this module is currently scoped to the embedding-provider subsystem.
> As of 2026-06-29 there are 5 production call sites (...)
> Broader migration of `throw new Error(...)` sites to DomainError is out of
> scope for the current wave and is tracked separately.

---

## 3. 为什么本次不立独立 PR

1. **审计原文已说"按需修"** — Q-MED-3 严重性低,4 套风格并存不构成 bug。
2. **RECONCILE §8 PR8 已标"审计失准/无需改,文档化"** — 在 Round 2 收尾时统一决定。
3. **改动面太大** — 全局统一需新增 `shared-mcp/mcp-domain-error.js` + 替换 ~30 处 `throw` + 改 6 个 `errorResult()` 函数 + 改 4 个工具工厂,合计 ~285 行。
4. **风险与收益不对等** — 现有 client 解析 `{ ok: false, error: string }` 已稳定;新加 `code` 字段是叠加,不破坏。但要全局替换 `throw`,需逐个核对每个工具的错误传播路径,任何一处漏改都会导致 client 拿不到 code 但行为变(从 throw 路径转到 isError 路径),回归测试覆盖成本高。

---

## 4. 本次微升级 (PR18 commit 9)

只改了 1 处,合计 ~30 行:

| 改动 | 文件 | 行数 |
|---|---|---:|
| `errorResult(message, code)` 接受可选 `code` 参数,透传到 MCP response JSON | `shared-mcp/omni-handlers.js` | +25 |
| 文档化范围描述 (本文档) | `docs/internal/q-med-3-status.md` | +90 |
| 单测守护契约 | `tests/unit/js/error-result-code.test.js` | +80 |

### 4.1 新 wire shape

```js
// 旧(PR18 之前) — 维持不变
errorResult("bridge unreachable")
// → { ok: false, error: "bridge unreachable" }

// 新(PR18 之后) — 显式传 code
errorResult("bridge unreachable", "BRIDGE_UNREACHABLE")
// → { ok: false, error: "bridge unreachable", code: "BRIDGE_UNREACHABLE" }
```

### 4.2 已知 code 类别 (文档化白名单)

后续 wave 全局统一时,先用这套 code,防止随意发明:

| code | 含义 | 典型来源 |
|---|---|---|
| `INVALID_INPUT` | 参数校验失败 | `validateMcpInput` 抛 |
| `TOOL_NOT_FOUND` | 子集外的工具调用 | `omni-handlers.js:registerMcpRequestHandlers` |
| `SUBSET_NOT_EXPOSED` | split 模式下被 filter 掉 | `toolFilter` 决策 |
| `SCRIPT_MISSING` | PowerShell 脚本找不到 | `memory-embeddings.js` / `memory-generation.js` |
| `SUBPROCESS_FAILED` | spawn 失败 | `proto/child-process.mjs` |
| `BRIDGE_UNREACHABLE` | claude-mem / blackboard 不可达 | `memory-bridge.js` |
| `INTERNAL` | 未归类 | 兜底 |

`COMMON_CODES` 字典与 `bus/domain-error.js` 现有的 8 个 code 保持同形,新文件可共享同一份白名单。

---

## 5. 后续 wave 立项指南 (留给未来)

如要立项 Q-MED-3 全局统一,推荐 3 个独立 commit,每个可独立回滚:

### Commit A — 引入 `shared-mcp/mcp-domain-error.js` (≤ 80 行)

不动 `bus/domain-error.js` (它稳定,属于 embedding 子系统)。
新增 `shared-mcp/mcp-domain-error.js`,导出 `McpDomainError` + `COMMON_MCP_CODES` + `toMcpErrorPayload`。
`omni-handlers.js:errorResult()` 接受 `McpDomainError` 实例,走 `toMcpErrorPayload(err)`。

### Commit B — 替换 5-6 处 user-facing `throw` (~60 行)

最小可观测集:

| 位置 | 建议 code |
|---|---|
| `shared-mcp/memory-bridge.js:126,129,133` | `BRIDGE_UNREACHABLE` / `INVALID_INPUT` |
| `shared-mcp/memory-embeddings.js:85` | `SCRIPT_MISSING` |
| `shared-mcp/memory-generation.js:78` | `SCRIPT_MISSING` |
| `shared-mcp/memory-retrieval.js:128` | `SUBPROCESS_FAILED` |
| `shared-mcp/memory-retrieval.js:374` (LLM API error) | `EXTERNAL_SERVICE` |

不动:
- `memory-retrieval.js:225` 等 `throw err` 重新抛出(语义是"保留 stack")
- `omni-handlers.js:88` 启动期 throw(非 user-facing)
- `metrics/compute.js:409,412`(IPC 协议层,不暴露给 client)

### Commit C — `CallTool` catch 块统一走 `toMcpErrorPayload` (~25 行)

`omni-handlers.js:registerMcpRequestHandlers` 的 catch 块从 `errorResult(error.message)` 改 `errorResult(error.message, error.code)` (若 error 是 `McpDomainError` 实例)。

### 5.1 总改动量

~285 行新增/修改,~100 行新单测。

### 5.2 立项前必读

- 本文档 (§1-§4) 确认范围未漂移
- 跑 `grep "throw new Error" shared-mcp bus cli --include="*.js" --include="*.mjs" --include="*.cjs" -r` 重新统计
- 用 `gitnexus_impact` 跑 `omni-handlers.js:errorResult` 的 blast radius (所有 5 个工具工厂 + 6 个用户工具都依赖)
- 写跨 `McpDomainError` 实例化 → 错误传播 → client 解析 code 的端到端测试

---

## 6. 相关

- `docs/PROJECT_AUDIT_2026-07-09.md:298` — 审计原条目
- `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md` §8 PR8 — "审计失准/无需改" 决策
- `bus/domain-error.js` — 已存在的局部统一机制 (可作参考)
- `shared-mcp/omni-handlers.js:errorResult` — 本次微升级唯一改动点
