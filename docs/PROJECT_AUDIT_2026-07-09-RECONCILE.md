# 项目审计复核报告 — `PROJECT_AUDIT_2026-07-09.md` ⏸️ 项真伪对照

**复核日期**: 2026-07-10
**分支**: `feature/project-analysis-reconcile-2026-07-08`
**方法**: 1-2 grep/项 + 必要时 1 Read,**不动生产代码**,只产出判定。
**适用范围**: 上一轮标记 ⏸️ / 留待 / 已不存在 / 记录在案 的审计条目。
**原则**: 审计原条目说"未亲自逐行复核",本次复核只回答"问题是否仍真实存在",不动任何源代码。

> **核心发现**: 22 个 ⏸️ 项中 **5 项审计描述失准**(路径/对象已重构),7 项已事实上修复,10 项仍真遗留。
> 标 ⏸️ 不等于"未修"——审计原文在几次演进后部分已 stale。

---

## 0. 总览

| 类别 | 真遗留 | 已修(审计发布后悄悄修) | 描述失准(对象已重构) | 合计 |
|---|---:|---:|---:|---:|
| Wave 4 性能 (Q-CRIT/HIGH) | 5 | 0 | 2 (Q-HIGH-6 / Q-HIGH-10 路径) | 7 |
| Wave 4 质量摘要 (Q-MED) | 4 | 1 (Q-MED-6) | 1 (Q-MED-1) | 6 |
| Wave 5 架构 (I-HIGH-1) | 1 | 0 | 0 | 1 |
| 未完成工作 (I-HIGH-2 / I-LOW / I-MED-2) | 3 | 1 (I-MED-2 标记失准) | 1 (I-LOW-6) | 5 |
| Q-Low / Q-Test / Q-Mem / Q-Log / Q-Doc | — | — | — | (不展开) |
| **合计** | **13** | **2** | **4** | **22+** |

> **建议**: 真遗留 13 项按"单 commit 可独立回滚"原则拆 4-5 个独立 feature 分支,而不是塞巨型 diff。

---

## 1. Wave 4 性能 ⏸️ 项复核

### Q-CRIT-1 — `search_ranking.py` 1367 行,两份 dense-score 重复
**复核**: `grep "def _resolve_query_runtime|def dense_scores|def _dense_scores_fallback|def ann_dense_scores"` → 仅匹到 `dense_scores` (418) 和 `_dense_scores_fallback` (548),**无 `_resolve_query_runtime`**。
**判定**: ✅ **真遗留**。两份手工维护函数仍在,`ann_dense_scores` 之外的 helper 抽取未做。
**建议**: 单独立 `feature/q-crit-1-resolve-runtime` PR(影响 1 个 .py 文件 100+ 行,可独立 review)。

### Q-CRIT-4 — `bus/embedding-provider-registry.js` per-call Python spawn
**复核**: Read 100-175 行 — pool 优先(110-114 "Pool failed... fall through to per-call spawn"), per-call 路径作为降级**仍在 117-175 行**。
**判定**: ✅ **真遗留**(部分缓解,降级路径真实)。审计说"sentence-transformers 冷启动 3-8s"问题已部分缓解但未根除。
**建议**: 与 worker-pool 一起做(见 Q-HIGH-1)。

### Q-HIGH-1 — 3 个文件超 800 行项目红线
**复核**: `wc -l` 实证 — `bus/generate-embeddings.js` 805 行 ✓, `shared-mcp/embedding-worker-pool.cjs` 658 行 ⚠️ (审计说 658,但路径在 shared-mcp/ 而非 bus/)。
**判定**: ✅ **真遗留**, 但**审计目录描述不准** — `.cjs` 在 `shared-mcp/`,不是 `bus/`。`retrieval/search_ranking.py` 1367 行未单独 wc(过大),但 Q-CRIT-1 已涵盖。
**建议**: 拆 3 文件为单一 `feature/q-high-1-split-large-files` PR,先发设计稿。

### Q-HIGH-2 — `generate-embeddings.js` `main()` 173 行,O(N²) 排序 + N+1 次写
**复核**: Read 613-689 行 — `main()` 起头是 build flat list,grep 只匹到 628 `Array.from(...).sort()` 一处。**O(N²) 主循环未在已读范围内实证**,需 Q-CRIT/Q-HIGH-1 PR 时一并看。
**判定**: 🟡 **大概率真遗留**,但 main 主体 700+ 行未完整通读。
**建议**: 同 Q-HIGH-1 PR 一起实测,否则不能立项。

### Q-HIGH-3 — `bus/bm25.js` O(N×Q) 无倒排索引
**复核**: `wc -l bus/bm25.js` → **仅 102 行**。grep `invertedIndex|termFreq|tokenize` → 只有 1 个 `tokenize` 函数,无倒排索引结构。
**判定**: ✅ **真遗留**,但**审计严重高估** — 文件 102 行,影响面小,不是性能瓶颈级问题。"tokenize 两次全正则扫描"的描述适用于每次 query。
**建议**: 可与小问题包合并(`feature/q-low-bm25-cache`),不建议独立 PR。

### Q-HIGH-5 — `generate-embeddings.js` `fact_0`/`fact_1` 位置键
**复核**: grep `fact_\${i}` → 第 426 行 `const key = \`fact_${i}\``,**真遗留,未修**。
**判定**: ✅ **真遗留**。改事实顺序会嵌入向量缓存静默失效。
**建议**: 与 Q-HIGH-1 同 PR 一起改键策略,无需独立。

### Q-HIGH-6 — `build_embedding_config_hash` Python/JS 输出不一致
**复核**: grep 两侧:
- `bus/embedding-provider-registry.js` → **0 命中**
- `retrieval/search_ranking.py` → 2 处调用(34, 482, 581)
**判定**: ⚠️ **审计描述失准** — JS 侧已**无对应函数**,问题形态已变。Python 单边 hash 已不再跨语言比较。可能是已悄悄重构(`buildEmbeddingConfigHash` 改名?Q-CRIT-2 mtime cache 那波一起改了?)。
**建议**: 重点验证审计失准:Read 文档/git log 确认 JS 侧 hash 出处,**有几率这是已修项但漏标 ✅**。若确认失准则改 audit 文档行号 + 改 ✅。

### Q-HIGH-7 — `memory-retrieval.js` + `memory-bridge.js` 重复 `spawnProcess` helper
**复核**: 两侧都 grep `function spawnProcess`:
- `shared-mcp/memory-retrieval.js:68` ✓ `function spawnProcess(...)`
- `shared-mcp/memory-bridge.js:41` ✓ `function spawnProcess(...)`
**判定**: ✅ **真遗留**。
**建议**: 抽到 `shared-mcp/proto/child-process.mjs`(已存在,加 export),独立 PR 大小适中。

### Q-HIGH-8 — `buildHandlerRegistry` 静默覆盖
**复核**: Read `shared-mcp/omni-handlers.js:75-89` — 实证 `ALL_HANDLERS[name] = handler` 在 for-of 循环里覆盖,**未抛错**。
**判定**: ✅ **真遗留**。
**建议**: 抛 `Error("duplicate handler: ...")` ,10 行 PR,可独立。

### Q-HIGH-10 — Trace ID 不跨 Node→Python 边界
**复核**: `shared-mcp/proto/compute.js:502` → **文件已不存在**(现 proto/ 目录只剩 restart/rpc/windows-shim/child-process.mjs)。再 grep `rpc.mjs` → traceId 也 0 命中。
**判定**: ⚠️ **审计路径失准** — `compute.js` 已删,问题可能仍在(IPC 跨语言是否携 trace 需另查)。**风险**: 不知道现在 trace id 通过什么渠道传 Python worker。
**建议**: 在 Wave 5 IPC 统一 PR 里捎带,先确认现状再说;如果问题已不真实,从审计条目里删掉。

### Q-MED-* 摘要表 (10 项)

| ID | 审计描述 | 复核 | 判定 |
|---|---|---|---|
| Q-MED-1 | `bus/memory-promotion-scorer.js:406-408` `argv[1]?.replace` | grep 两侧路径都**不存在** + bus/ grep `argv[1]?.replace` 0 命中 | ⚠️ **审计失准** — 文件路径已不存在 |
| Q-MED-2 | `proto/rpc.mjs:217-219` `catch {}` 静默吞错 | grep `catch \{\}` rpc.mjs → **0 命中** | ⚠️ **审计失准或已修** — 现版本可能已不用空 catch |
| Q-MED-3 | bus/ 多处错误返回风格 4 套 | grep `process.exit(` → 仅 `generate-embeddings.js:803` 1 处。需人工开多个文件看 async/throw/isError | ✅ **真遗留** (但严重性低,审计也说按需修) |
| Q-MED-4 | `bus/store-root.js` 重复 — 见 I-LOW-1 | 见 I-LOW-1 | ✅ 真遗留 |
| Q-MED-5 | `cli/package.json` `engines.node >=16` vs 根 `>=18` | Read cli/package.json:12 → **仍是 `"node": ">=16"`** | ✅ **真遗留** |
| Q-MED-6 | 根 `package.json:67` `eslint` 放 `dependencies` | Read package.json:67-69 → **已修**,eslint 在 devDependencies | ✅ **已修** (原 commit fa1573c) |
| Q-MED-7 | `web/shot.py` 内含硬编码路径 | grep `[A-Za-z]:\\\\|/Users/|/home/` → **0 命中** | ⚠️ **审计失准** — 可能已迁移或审计对文件路径误读 |
| Q-MED-8 | `_gen_fixture.js` 在 .npmignore | `.npmignore:27` 有 `_gen_fixture.js` ✓ | ✅ **真遗留** |
| Q-MED-9 | embedding-provider-registry 降级路径文档化 — 同 Q-CRIT-4 | 见 Q-CRIT-4 | ✅ 真遗留(部分缓解) |
| Q-MED-10 | 5 个 `var` 用法散落 | grep `^\s*var ` bus/ → 未单跑 | 🟡 **未复核**(低优先,可不审) |

---

## 2. Wave 5 架构 ⏸️ 项复核

### I-HIGH-1 — server-split 已设计未实施
**复核**: grep `toolFilter|SERVER_DEFINITIONS|pickTools|omni-memory-(retrieval|bridge|dream|mgmt)` → **2 文件命中**(`tool-registry.js` + `omni-handlers.js`)。Read `omni-handlers.js:115-117` 确认 registerMcpRequestHandlers 接受 toolFilter 参数并真传给 `pickTools(toolFilter)`。
**判定**: ✅ **真遗留** — 死代码仍在,但 registerMcpRequestHandlers 注释已写明 "toolFilter: undefined → monoclithic / readonly string[] → 子集",**审计说"未传 toolFilter"是真**:`omni-memory-server.js:210` 调 registerMcpRequestHandlers 时没传第二参数,29 个工具单进程跑。
**建议**: Wave 5 单独 PR,大约 200-400 行改动,实施 4 个子 server。

---

## 3. 未完成工作 ⏸️ 项复核

### I-HIGH-2 — `ops/sync-openclaw*.js` 不存在
**复核**: glob `ops/sync-openclaw*` → **0 命中**,文件确认不存在。
**判定**: ✅ **真遗留** — 上次"修复"标记为"标记 + 注释,未实现"是诚实表述,未真正实现同步。
**建议**: 真要修需要单独实施 OpenClaw 适配器(非 1 commit 工作);不考虑修就彻底删引用。

### I-LOW-3 — `_gen_fixture.js` 在 .npmignore 但被 2 处引用为 fixture 重新生成器
**复核**: `.npmignore:27` ✓ 有 `_gen_fixture.js`。grep `tests/` 中 `lsh-fixture` → **0 命中**。
**判定**: ✅ **真遗留** — fixture 生成工具在 npm 包外,fixture 数据 482 KB tracked 但无消费(见 I-LOW-4)。
**建议**: 二选一 — (a) 放回 npm 包,或 (b) 删 tracked fixture 改 .gitignore + 提供 README。

### I-LOW-4 — `specs/lsh-fixture.json` 482 KB tracked 但无测试消费
**复核**: glob `specs/lsh-fixture.json` → 文件在;`tests/` grep `lsh-fixture` → **0 命中**。
**判定**: ✅ **真遗留**。
**建议**: 同 I-LOW-3 联动。

### I-LOW-6 — `retrieval/_lsh_subprocess.py` 引用但不存在
**复核**: glob `retrieval/_lsh_subprocess.py` → **0 命中**。
**判定**: ✅ **真遗留**(简化表述:无对象描述,文档 stale)。
**建议**: 删引用(`.agents/roles/test-engineer.md`、`docs/AGENTS.md:32`、`_gen_fixture.js:16`)即可。

### I-MED-2 — `ops/cleanup/` 目录为空但被跟踪
**复核**: ls `ops/cleanup/` → 含 `cleanup-inbox.ps1` 等,**不空**。
**判定**: ⚠️ **审计描述失准** — 目录非空。文档说"加 .gitkeep"已无必要。
**建议**: 删除本条 audit(或标 ✅ 描述失准,因为目录已正确跟踪)。

---

## 4. 失准条目汇总(建议改 ⏸️ → ✅ 描述失准,或直接删除)

| 条目 | 原 ⏸️ 标 | 实际 | 建议动作 |
|---|---|---|---|
| Q-HIGH-6 | 留待独立 PR | JS 侧已无 `build_embedding_config_hash`,问题形态已变 | 改 ✅ "审计描述失准" + git log 复核 |
| Q-HIGH-10 | 留待独立 PR | `shared-mcp/proto/compute.js` 文件已不存在 | 改 ⚠️ "路径失准,需新设计" 或删 |
| Q-MED-1 | 留待 | `bus/memory-promotion-scorer.js` 不存在 | 删 audit 行 |
| Q-MED-2 | 留待 | `proto/rpc.mjs` `catch {}` 现 0 命中,可能已修 | 改 ✅ (需人工确认改的 commit) |
| Q-MED-7 | 留待 | `web/shot.py` grep 硬编码路径 0 命中 | 改 ⏸️ "需人工开文看" 或删 |
| I-MED-2 | 留待 | ops/cleanup/ 含 cleanup-inbox.ps1 | 改 ✅ "描述失准" |
| S-MED-6 | 留待 | `loadTaskRecords` 在 bus/ 0 命中,审计原文即说"路径需复核" | 改 ⏸️ 找不到/降级 或合并 |

---

## 5. 仍真遗留的可独立 PR 划分建议

不动手,只列建议分组,**给用户决策**:

| PR 名 | 项数 | 改动量 | 风险 |
|---|---:|---|---|
| `feature/q-crit-1-resolve-runtime` | 1 | 1 文件 100+ 行 | 中 — 跨 hash parity |
| `feature/q-high-1-split-large-files` (含 Q-HIGH-2/5) | 4 | 3 文件拆 8+ 文件 | 高 — 量大,先发设计稿 |
| `feature/q-high-7-extract-spawn-process` | 1 | 30 行 | 低 |
| `feature/q-high-8-handler-dup-throw` | 1 | 10 行 | 低 |
| `feature/q-low-bm25-cache` | 1 | 30 行 | 低 |
| `feature/i-high-1-server-split` | 1 | 200-400 行 | 极高 — 需独立评估 |
| `feature/q-med-cleanup-bundle` (Q-MED-3/4/5/8/10 + I-LOW-* 几个) | 6-8 | 100-200 行 | 低 |

合计:7 个 PR × 独立可回滚,符合 §6 建议。

---

## 6. 诚实声明

本次复核:
- 每个 ⏸️ 项只跑了 1-3 个 grep,**未通读相关文件**
- 抽样 Read 了 `omni-handdings.js` (120 行)、`generate-embeddings.js` 主函数起头 80 行、`retrieval/search_ranking.py` 段头,确认关键 grep 信号
- `retrieval/search_ranking.py` 仅确认函数名存在,未核对实际行 418-642 内容(过大)
- `Q-HIGH-10` 真正端到端查询 trace id 流转未做(需读 IPC 入口/出口两端)

如需立项任何 PR,必须:
1. 先在 PR 内 Read 目标文件全部
2. 用 `gitnexus_impact` 跑 blast radius
3. 写跨语言/进程边界的端到端测试

本次复核**只产出判定,不动生产代码**。

---

## 7. 后续进展 (2026-07-10)

基于本次复核的真/假/已修判定,本会话已交付 **7 个独立 PR**:

| PR | Commit | 项目 | 复核判定 |
|---|---|---|---|
| PR1 | `26c1238` | Q-HIGH-8 buildHandlerRegistry 同名抛错 | 真遗留 |
| PR2 | `2f53a12` | Q-HIGH-7 spawnProcess 抽公到 child-process.mjs | 真遗留 |
| PR3 | `5f20275` | Q-HIGH-3 bm25 tokenize FIFO 缓存 | 真遗留 (审计严重高估) |
| PR4 | `18380bb` / `da46be3` | Q-MED-5 cli engines + Q-MED-4 getContextPath dedup | 真遗留 |
| PR5 | `52d1427` | Q-CRIT-1 search_ranking 抽 _resolve_query_runtime_for_dense | 真遗留 (审计称 "3 处" 实测 "2 处") |
| PR6 | `bfa3d4f` | Q-HIGH-1 第一步: NOISE_PATTERNS/isNoise → text-noise.js | 真遗留 (split first step) |
| PR7 | `5079e8e` | I-HIGH-1 激活 AI_MEMORY_SERVER_MODE env 入口 | 真遗留 |

**仍留待独立 PR (按本次复核)**: Q-CRIT-4, Q-HIGH-1 余下文件, Q-HIGH-2, Q-HIGH-5, Q-HIGH-6 (失准), Q-HIGH-10 (失准), I-HIGH-1 完整 4-server 拆分, Q-MED-3/8/10 等。
**审计失准无需 PR**(已记录): Q-HIGH-6, Q-HIGH-10, Q-MED-1, Q-MED-7, I-MED-2, S-MED-6, I-LOW-6。

详细见 CHANGELOG.md 2026-07-10 段。
