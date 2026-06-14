# 项目深度分析报告（差分审计）

**分析日期**: 2026-06-14
**对比基线**: 2026-06-13 首版报告（已附末"基线"章节）
**项目版本**: local-ai-memory-bus v3.1.0
**项目类型**: Node.js ESM (>=18) — 7936 symbols, 12938 relationships
**审计方法**: 5 个 expert agents 差异审计（不复做基线） + 2 派辩论

---

## 📊 综合评分

| 维度 | 旧 | 新 | 变化 | 主导因素 |
|------|-----|-----|------|---------|
| 架构 | 6.5 | 7.5 | **+1.0** | god module 拆分 + 路径统一 + 根级 lint |
| 安全 | 7.5 | 8.5 | **+1.0** | CRITICAL #1 修了 + HIGH #3 落地 + #2 写侧硬化 |
| 性能 | 6.5 | 7.0 | +0.5 | detectConflicts O(n²) 修了 (10k 37x) |
| 代码质量 | 7.0 | 7.2 | +0.2 | lint 覆盖 + 2 个 god 拆；但 no-console 降级 + 8 个 barrel dead exports |
| 测试 | 6.0 | 6.8 | +0.8 | 4 份死 CJS 转 ESM + 990 行 0 测试模块补齐；CI 仍 2 红 |
| **加权综合** | **6.6** | **7.6** | **+1.0** | 从"债务可见"进入"主债务收敛到端口/常量/日志三个低危可批处理" |

> 批判派争议：加权分掩盖维度不均，安全 8.5 含 #3 漏 4 处的虚高，测试 6.8 含 2 红测试未治本。**建议真实加权 ~7.2**。

---

## ✅ 真修了（17 项中 11 项）

| # | 项 | 证据（file:line） | 提交/原因 |
|---|----|------------------|----------|
| 1 | **CRITICAL** Gemini heredoc 注入 | `bus/embedding-provider-registry.js:217-258` 改 stdin JSON；`shared-mcp/memory-bridge.js:195-251` 无密钥字面量 | 多 commit |
| 2a | HIGH mcp_write 写侧硬化 | `ops/mcp/mcp-memory-tools.js:310-364` 限长 1000 + 元素 2000 + UUID + `appendLineAtomic({safeRoot})` | — |
| 3 | HIGH JSONL realpath + @include 防护 | `ops/memory/paths-and-io.js:96-133` `safeRealpathWithin`；`entry-parsers.js:46-51, 382-410` 容器检查 + 绝对路径拒绝 | — |
| 4 | LOCK_TTL undefined | `ops/memory/memory-archival.js:53,135` 统一为 `LOCK_TTL_MS` | — |
| 5a | stress test 未定义函数 | `ops/stress/stress-test-concurrent.js` 6 处 `resolveStoreRoot` | — |
| 5b | 4 份 CJS 死测试 | `tests/integration/js/{inbox-atomic-flow,kg-integration,memory-flow,memory-layers-flow}.test.js` 转 ESM；glob `*.{test.js,test.mjs}` | — |
| 6 | resolveVaultRoot CLI/adapter 分歧 | `bus/vault-root.js:55-101` 新 chain；platform/* delegate | — |
| 7 | ops/bus/store-root.js 副本 | 目录已删 | `53767f3` |
| 9 | node: 前缀 + 根级 lint | `eslint.config.js` flat config；`lint:root` 0 errors | `d85db88` |
| 11 | 4 个 0 测试模块 | `tests/unit/js/{knowledge-graph(210),memory-archival(242),promotion-resolver(282),promotion-scorer(256)}.test.js` 总 990 行 | — |
| 13a | detectConflicts O(n²) | `ops/memory/memory-contract.js:823-878` 反向索引 | `5a525b4` |
| A1 | memory-layers-parse.js god module | 1185→48 行 barrel + 4 拆 | `fd6e276` |
| A2 | omni-memory-server.js god module | 1444→277 行 + 7 sibling | `fd6e276` |

---

## ❌ 未修（17 项中 5 项）

| # | 项 | 状态 |
|---|----|------|
| 5c | mcp-e2e 死代码 | `tests/e2e/mcp-e2e.test.mjs:194,213` 重复 `testStoreRoot`；`:381,386` `process.exit()`；`package.json` 无 `test:e2e` |
| 5d | jsonl.test.mjs:296 伪 concurrent | 仍顺序 `for` 循环，名字叫"concurrent" |
| 8 | logger 3 种风格 | `no-console` 降级到 warn；`DomainError` 未引入；结构化 logger 仅 2 个消费者 |
| 10 | CI `\|\| true` 短路 | `.github/workflows/lint.yml` 仍 `\|\| true`；4 步 `if: false` 永久禁用 |
| 12 | Windows atomic write skip | `tests/integration/js/inbox-atomic-flow.test.js:89,183` `if (process.platform === "win32") skip`；项目自定位 Windows 优先但跳过 |
| 13b | patchJsonlRecord 全文件重写 | `ops/memory/memory-layers-dedup.js:51-92` 仍 readFileSync + writeFileSync |
| 13c | writeIndexSnapshot per-batch | `bus/generate-embeddings.js:548-552, 725` 仍非 tmp+rename，每 batch 全量序列化 |
| 15 | entity-extractor STOPWORDS | `ops/entity/entity-extractor.js:34-72` 仍数据/算法混合；`"type","type","type"` 重复 |
| F | 孤儿注释 | `bus/generate-embeddings.js:308` `buildDocument() return null`（故意写坏） |

---

## 🆕 新发现问题（5 agents 共 13 项）

### HIGH（必须修）

1. **parseEventEntries / parseSessionMemoryEntries 漏 realpath**（安全 agent）
   - 位置：`ops/memory/entry-parsers.js:92-150, 184-220`
   - 与 #3 同样攻击面（vault symlink → agent prompt 注入），但修复时只覆盖了 `parseLayerEntries` 一个分支
   - **PR 描述应改为"部分修"**

2. **memory-layers-dedup.js:224-244 patch log 同样 O(whole file)**（性能 agent）
   - 与 13b 同根因，dedup 流程每次 patch 都全文件 read+write
   - 高频调用路径

### MEDIUM（建议修）

3. **memory-archival.js:284 STRUCT_DIR readdir 无 realpath**（安全 agent）
4. **mcp_write 缺 caller 身份**（安全 agent）— #2 留作下个 feature 的尾巴
5. **cli/ai-memory.js:801 端口硬编码 vs start.js BASE_PORT 偏移不一致**（架构 agent）
6. **cli/ai-memory.js 反从 889→919 变长**（架构 agent）— god module 拆到一半停
7. **barrel re-export 引入 8 个 dead exports**（代码质量 agent）— `record-coercion.js` + `paths-and-io.js` 拆分时全量透传
8. **3 个文件仍 >800 行**（代码质量 agent）— cli/ai-memory.js 919 / memory-contract.js 907 / entity-extractor.js 815 / knowledge-graph.js 889
9. **no-console 降级到 warn 让 #8 失去约束力**（代码质量 agent）
10. **withFileLock 串行阻塞**（性能 agent）— `memory-layers-dedup.js:53,88`
11. **generate-embeddings.js:725 批次内全量序列化**（性能 agent）

### LOW（可选）

12. **writeLock TOCTOU**（安全 agent）— `memory-archival.js:151-165`，非原子 `existsSync + writeFileSync`
13. **generate-embeddings.js:667 空文件写非原子**（性能 agent）
14. **stress test CJS/ESM 混用**（测试 agent）
15. **embedding-worker-pool.cjs:311 apiKey/geminiModel 死变量**（代码质量 agent）
16. **structured logger 仅 2 个消费者**（架构 agent）
17. **record-coercion.js 拆分后新增 24h/7d 时长常量重复**（架构 agent）
18. **86 个真 unused vars**（代码质量 agent）— 含 8 个 barrel dead + GEMINI_BASE_URL/HASH_DIM 真死代码

---

## 🔴 当前 CI 状态

```
npm test → 675 测试，673 通过 / 2 失败
```

### 失败 1: `verify-atomic-write.js runs as an ESM CLI` (esm-entrypoints.test.js:476)

**根因**：`ops/verify/verify-atomic-write.js:31` 把生成的 child 脚本写到 `os.tmpdir()` 下的 `atomic-write-child-${pid}.js`。该路径无父 `package.json`、扩展名是 `.js`，Node v22 触发 `[MODULE_TYPELESS_PACKAGE_JSON] Warning: ... Reparsing as ES module ...` 写入 stderr。

**触发**：`verify-atomic-write.js:79` `results.every(r => r.code === 0 && r.stderr === "")` — 10 行全部写入成功（10/10），但 stderr 含 Node warning → allOk=false → exit 1。

**修法**：child 脚本改 `.mjs` 扩展名（1 行）。

### 失败 2: `ai-memory CLI --workspace dry-run forwards AI_MEMORY_STORE` (esm-entrypoints.test.js:492)

**根因**：用户 shell 中 `AI_MEMORY_ROOT=C:\Users\wang\.ai-memory`（来自本地 `.env`）泄漏到测试子进程。`cli/ai-memory.js:519-536` 的 `resolveScriptPath` 用 `AI_MEMORY_ROOT` 拼路径，得到 `C:\Users\wang\.ai-memory\ops/check/check-memory-integrity.js`（在用户机器上不存在）。

**触发**：`runNode` (`tests/unit/js/esm-entrypoints.test.js:43-53`) 默认 `env: { ...process.env, ...(options.env || {}) }` 透传环境变量，未隔离 `AI_MEMORY_*`。

**修法（2 种）**：
- 治标：测试调用点加 `options.env: { AI_MEMORY_ROOT: REPO_ROOT }`
- **治本（批判派主张）**：改 `runNode` 默认 `env: scrub(process.env, AI_MEMORY_*)` 隔离业务 env

---

## ⚔️ 辩论结论

### 共识（双方同意）

- CRITICAL + 2 HIGH 真修了，价值真实
- 2 个 CI 失败本周必修
- `parseEventEntries` / `parseSessionMemoryEntries` / `memory-archival.js:284` 3 处 realpath 漏修是 follow-up 必做
- `mcp-e2e` 死代码、`logger` 风格统一、`Windows atomic write` 重新评估是下个迭代不可拖
- `cli/ai-memory.js` 919 行下个迭代拆

### 分歧

| 议题 | 乐观派 | 批判派 | **本报告采信** |
|------|--------|--------|---------------|
| 2 测试红 | "5 行小修" | "runNode 设计缺陷，治本改默认 env scrub" | **批判派** — runNode 默认透传 `process.env` 是反模式，未来 5+ 处会重蹈覆辙 |
| realpath 漏修 | "follow-up 即可" | "#3 修复不彻底，PR 描述应改为部分修" | **批判派** — 文档已宣称"已防护"，是诚信问题 |
| barrel dead exports | "拆 1185→48 是大胜，dead exports 是兼容代价" | "拆分方法错误，consumer 视角是净负值" | **折中** — barrel 兼容有价值，但 8 个 dead exports 30 分钟内应清掉 |
| 拆分 cli/ai-memory.js | "先观察再拆" | "919 行还超 800，下个迭代必拆" | **批判派** — `omni-memory-server.js` 1444→277 行的拆分能力已验证 |
| patchJsonlRecord | "未触发用户可见问题，premature optimization" | "断电时是数据丢失风险" | **折中** — 季度性优化，但需加 bench 监控 |
| 加权分 7.6 | 真实进展 | 含维度虚高（安全 8.5 / 测试 6.8），真实 ~7.2 | **批判派** — 在 PR 描述里写"安全 8.5"会被审计挑战 |

### 最终建议（按优先级）

#### 本周必做（≤1-2 天，治本不是修 bug）

1. **改 `runNode` 默认 env scrub** — `tests/unit/js/esm-entrypoints.test.js:43-53` 默认 `env: { ...scrub(process.env, ['AI_MEMORY_*','OBSIDIAN_*','VAULT_*']), PATH, HOME, LANG, NODE_*, TMPDIR, TEMP, SYSTEMROOT }`。**修法 1 处，2 红测试在所有调用点自动恢复绿。**
2. **修 `verify-atomic-write.js:31` child script 路径** — 改 `path.join(os.tmpdir(), 'atomic-write-child-${pid}.mjs')`（1 行）。或保险起见：写到 `inboxDir` 内部而非 tmpdir，避免子目录权限问题。
3. **补 3 处 realpath 校验** — `entry-parsers.js:92-150, 184-220`（`parseEventEntries` + `parseSessionMemoryEntries`）和 `memory-archival.js:284`（STRUCT_DIR readdir）。**这是 #3 修复的不彻底，文档须同步改为"部分修"**。
4. **修 writeLock TOCTOU** — `ops/memory/memory-archival.js:151-165` 改 `writeFileSync(path, pid, { flag: 'wx' })`（Node 18+ 原子创建）。
5. **清 8 个 barrel dead exports** — `record-coercion.js` + `paths-and-io.js` 中 8 个无 consumer 的 symbol：`grep -rn "symbolName" .` 确认无引用后删。

**合计：~6-8 小时，覆盖 1 CI 红、3 个新 HIGH/MEDIUM、1 个诚信问题。**

#### 下个迭代（30 天）

1. `tests/e2e/mcp-e2e.test.mjs` 改写为 `node:test`，接入 `npm run test:e2e` 和 `test:all`（解决 e2e = 0% 覆盖的诚信问题）
2. `cli/ai-memory.js` 919 → 拆 `<400` 行（按子命令 `cli/commands/*.js`）
3. 引入 `DomainError(code, message, cause)` 统一错误信封 + `no-console` 升回 `error`
4. CI Windows runner 加 `inbox-atomic-write.test.js` 并发分支（解决 Windows-first 定位的诚信问题）
5. `omni-metrics.js` 937 行评估是否拆 `metrics-source` vs `metrics-compute`
6. 端口列表对齐 `cli/ai-memory.js:801` vs `start.js` BASE_PORT 偏移

#### 季度性（60+ 天）

1. `patchJsonlRecord` + patch log 改 append-only + 周期 compact（`#13b` + `新增#1`）
2. `writeIndexSnapshot` 改 tmp+rename + 批次内增量
3. STOPWORDS 拆 `ops/entity/stopwords/*.js` 按域分组
4. `withFileLock` 引入 try-lock + 队列化
5. 性能 profiling（clinic.js / 0x 跑真实工作流）后再决定

#### 不做（明确拒绝）

- 8 个 barrel dead exports 之外的"全部 86 个 unused vars 一并清理" — 性价比低，季度性任务
- `mcp_write` callerId 协议 — 留作下个 feature 一起设计
- `#15` STOPWORDS 之外的 entity-extractor 815 行大拆 — 工作量大收益小

---

## 📈 历史对比

### 2026-06-13 基线（首版）

- 加权分 6.6
- 1 CRITICAL + 3 HIGH 未修
- 8 个 god/超长文件
- 3 处 store-root 重复
- 2 个 O(n²) 热路径
- 0 TODO/FIXME
- 最近 5 commit 全是路径语义/去重

### 2026-06-14 差分（本次）

- 加权分 7.6（批判派采信 ~7.2）
- 1 CRITICAL + 2 HIGH 已修；**1 个 HIGH 是 #3 漏修需 follow-up**（新发现）
- 8 god 文件 → 6 god 文件（拆了 2 个；cli/ai-memory.js 反而变长）
- 0 store-root 重复
- 1 个 O(n²) 已修（detectConflicts），**1 个仍 O(n²) + 1 个新增 O(whole file)**
- 4 个 0 测试模块补齐 990 行测试
- 86 个真 unused vars（含 8 个拆分副作用）
- **CI 仍 2 红**（基线报告未提及，但已存在）
- 最近 5 commit: detectConflicts 37x 加速 + 真实 lint 修复 + 2 god 拆分 + node: builtin 统一 + vault/store path 语义

### 趋势

**结构性推进**: 5 个基线"路径语义/去重"commit → 本次"性能 37x + 关键安全修复 + 2 个 god 拆分 + 测试盲区补齐"。**活跃维护 + 真有结构性推进**。

**核心债务**: 从"路径/常量/日志三件大事"收敛到"端口/常量/日志/拆分"四件可批处理项。但**新增 2 类**:
- 拆分副作用（barrel dead exports + 反向引入时长常量重复）
- 测试环境隔离设计缺陷（runNode 默认透传 env）

---

## 🔍 审计方法学

| 阶段 | 工具/方法 | 耗时 |
|------|---------|------|
| 1. 5 agents 差异审计 | 5 个 general-purpose agent 并行，基线 = PROJECT_ANALYSIS.md (2026-06-13) | ~3-4 min 各 |
| 2. 2 派辩论 | 乐观派 + 批判派 平行 | ~1-2 min 各 |
| 3. 报告整合 | 主 agent 手动综合 7 个 agent 输出 | — |

每个 agent 都被指示：
- 不读 `node_modules / .git / dist / build / cache / .gitnexus / .pytest_cache / .claude / .github / .deepeval / generated`
- 用 Read/Grep/Glob/Bash
- 引用具体 file:line
- 不输出"通用最佳实践"建议
- 输出 Markdown 结构化报告
- **以 2026-06-13 基线为锚点，做差异审计而非重做基线**

---

*报告由 DeepAnalysis 生成 | 5 agents 差异审计 + 2 派辩论*
*下次建议间隔：30 天（覆盖本次"下个迭代"清单后再做基线对比）*
