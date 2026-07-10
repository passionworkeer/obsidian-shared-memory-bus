# EverOS 借鉴设计报告 · `obsidian-shared-memory-bus` 与 `EverMind-AI/EverOS` 的融合路径

> English: Design report on which EverOS ideas we adopted, which we deferred, and which we explicitly rejected — and why. Companion to PR #feature/eve-markdown-source-of-truth and PR #feature/eve-cascade-watcher.

> 关联：EverOS upstream <https://github.com/EverMind-AI/EverOS> (Apache 2.0, 8.8k★) · 债务清单详见最近一次 `docs/PROJECT_AUDIT_*.md` · PoC 实现 feature/eve-markdown-source-of-truth + feature/eve-cascade-watcher

---

## TL;DR

我们看了 EverOS 一周，**借鉴 2 个东西落地为 PoC**（markdown 真相派生层 + cascade 增量队列），**保留 3 个作为后续候选**（hybrid search 编排、正交命名空间、错误层次），**主动拒绝 2 个**（全套 LanceDB 替换、按 user/agent/app/project 五维强制隔离）。

理由：EverOS 是 Python 单体栈，我们项目是 Node + Python + PowerShell 混合栈，迁移成本高。能用我们的工具链等价实现的，我们做；不能的，我们记下风险，缓做。

---

## 1. 我们借鉴了什么（已落地 PoC）

### 1.1 Markdown 真相派生层 · `ops/export/export-md.js`

**EverOS 的做法**：
- 真相层是 `~/.everos/<app>/<project>/users/<id>/episodes/*.md` (Markdown + YAML frontmatter)
- 索引层是 `.index/sqlite/` + `.index/lancedb/`
- **删掉 `.index/` 不会丢失记忆**（md 是导出格式）

**我们的取舍**：
- 我们的真相层是 `~/.ai-memory/structured/*.jsonl`（append-only，跨工具契约已稳定）
- 不能让 `.md` 抢了 `.jsonl` 的位置 —— 太多上下游依赖 JSONL
- **方案**：保持 JSONL 为唯一真相源，**派生** `.md` 给 Obsidian 消费

**实现**（`feature/eve-markdown-source-of-truth`，8 单测 + 1 E2E 全过）：
- `ops/export/export-md.js` 把 5 个 source JSONL → `~/.ai-memory/derived/`
  - `index.md` 总索引按 scope 分组
  - `by-scope/{scope}.md` 每个 scope 一页按 type 分组
  - `by-id/{id}.md` 每条记录一个文件
- 8 必填 + 2 可选 frontmatter：`id, schemaVersion, type, scope, memory_level, title, tool, source` + `t, tags`
- Obsidian 原生 `#tag` 语法在 body
- **.md 是只读派生**，用户在 Obsidian 改 .md 不直接回流（未来加 sync-importers 'md-edits' channel）

**收益**：
- ✅ Obsidian 用户零配置可消费
- ✅ Git-friendly（每条 .md 一个文件）
- ✅ 完全非破坏性（JSONL 路径不动）
- ✅ 单测 8 个 + E2E 1 个全过

**风险 / 未做**：
- ⚠️ 没有回流（用户在 Obsidian 改 .md 不写回 JSONL），需要 sync-importers 加 'md-edits' channel
- ⚠️ 没有 watch 触发增量导出（每次手动 `node ops/export/export-md.js`），需要接 cascade worker

---

### 1.2 Cascade 增量变更队列 · `ops/cascade/cascade-queue.js` + `cascade-worker.js`

**EverOS 的做法**：
- `watchdog` 监听文件 → 500ms 防抖 → entry 级 diff（按 `content_sha256`）→ LanceDB 增量同步
- SQLite `md_change_state` 队列 + LSN 水位 + 失败重放

**我们的现状**：
- `bus/memory-watchdog.ps1` 是 mtime 轮询 + 全量 `writeIndexSnapshot` 重写
- 10k+ 条记录每次都全量重建（~30s）

**我们的取舍**：
- 复刻 EverOS 整套 cascade daemon 工作量太大（跨 Node + PS + Python 三个进程）
- **方案**：先做**纯 Node 模块** + SQLite 队列 + 单元测试证明语义对，再逐步接到现有 watchdog

**实现**（`feature/eve-cascade-watcher`，16 单测 + 3 E2E 全过）：
- `ops/cascade/cascade-queue.js` (CascadeQueue class)：
  - SQLite 表 `cascade_queue(id LSN, source, entry_id, content_sha256, op, processed_at, worker_id, last_error)`
  - `enqueue()` + dedup window (连续相同事件折叠)
  - `claimBatch()` 按 LSN 取最早未 processed（任何 worker 可取，崩溃恢复语义）
  - `ack()` / `fail()` / `stats()` / `prune(olderThanDays=7)`
  - 纯函数 `contentSha256()` + `diffByHash()` 单独可测
- `ops/cascade/cascade-worker.js`：CLI 包装，drain 队列到 audit sink JSONL

**收益**：
- ✅ 崩溃恢复：worker 死了不丢事件，下个 worker 从 LSN 续传
- ✅ 增量 diff：只重嵌入 hash 变化的部分
- ✅ 单测 16 个（边界 + dedup + 崩溃 + 部分 ack）全过
- ✅ E2E 3 个（in-process + CLI + crash recovery）全过
- ✅ 零外部依赖（用 Node 22+ `node:sqlite`）

**风险 / 未做**：
- ⚠️ 没有接到 `bus/memory-watchdog.ps1`（PS 端要 enqueue 事件到 cascade.sqlite3）
- ⚠️ 没有接到 `ops/build/build-embeddings.js`（worker 要 patch embeddings index.jsonl）
- ⚠️ 没有接到 `retrieval/ann_index.py`（ann_index.add_single 增量插入未做）
- ⚠️ production sink 是 audit JSONL，没真接下游索引

---

## 2. 我们考虑过、保留作为候选（未做）

### 2.1 Hybrid search 单查询内混合（BM25 + ANN + rerank）

**EverOS**：单查询内混合三种检索 + scalar filter  
**我们**：当前 `search_index.py` 是先 BM25 出 top-K，再 dense_scores 算 score，**不是**单查询混合

**为什么没做**：
- 我们 `ann_index.py` 刚落地（债项 #5.3/#5.4），先用 ANN 替代全量 dense 评分
- 真混合需要把 BM25 索引也变成 ANN-friendly（实验 Tantivy / Lucene）
- 优先级低于其他债项

**何时做**：
- 当用户报 "中文 BM25 召回率 < 70%" 或 "混合权重 α 需要调"
- 预计 2 周工作量，1 周集成 + 1 周 benchmark

---

### 2.2 五维正交命名空间（user_id × agent_id × app_id × project_id × session_id）

**EverOS**：路径前缀硬隔离 `~/.everos/<app>/<project>/users/<id>/...`

**我们**：当前 bus 多用 metadata filter 隔离 scope（user/project/task）

**为什么没做**：
- 路径前缀硬隔离会破坏 `~/.ai-memory/structured/*.jsonl` 的现有契约
- 现有 scope filter 已经够大多数用户用
- 强制 5 维会让 JSONL 写入路径变复杂（每个 source 多一层子目录）

**何时做**：
- 当出现 "项目 A 的 memory 泄露到项目 B" 的实际报告
- 或者产品要支持 SaaS 多租户

---

### 2.3 错误层次 (AppError 基类 + Domain/Infrastructure/Capability/Configuration 四分支)

**EverOS**：4 类 AppError + 边界翻译，service/route 层不 catch-and-wrap

**我们**：当前用 `bus/domain-error.js` 但分层不严，catch-and-wrap 散在多处

**为什么没做**：
- 涉及面广（要审计所有 throw / catch）
- 风险高于收益（短期可能引入 regression）
- 应该先在 `shared-mcp/`（29 个工具）做 PoC，再推广

**何时做**：
- 当用户报 "错误信息看不懂"
- 或者准备发版 4.0（breaking change）

---

## 3. 我们主动拒绝了（不做）

### 3.1 全套 LanceDB 替换

**EverOS**：LanceDB（Rust + Arrow）做 ANN + BM25 + scalar filter

**我们拒绝原因**：
1. 我们 embedding 后端是 `hash`（本地 LSH），不需要重型 ANN
2. hnswlib 已满足 10k+ 条 P99 < 10ms
3. LanceDB 是 Rust 库，跨平台编译 + Python/Node 双 binding 维护成本高
4. 我们的存储约束是 "本地优先、零外部依赖"，LanceDB 引入 ~80MB native dep

**保留理由**：
- hnswlib 是 C++ 库，跨平台体验未必一致
- 如果未来 embedding 维度 > 1024 或者记录数 > 1M，重新评估

---

### 3.2 按 user/agent/app/project 强制隔离

**EverOS**：路径前缀硬隔离，删除一个项目不会影响其他

**我们拒绝原因**：
1. 我们的核心场景是 "单个开发者跨工具共享记忆"，不是多租户
2. 强制 5 维路径会让 `inbox.jsonl` 这种核心文件变复杂
3. 用户已经习惯了现有 scope filter（user/project/task/run）

**保留理由**：
- 多用户共享同一台机器的场景（家庭 / 小团队），未来可能需要

---

## 4. 后续路线图

按 ROI 排序：

| 优先级 | 债项 | 工作量 | 状态 |
|--------|------|--------|------|
| 🔴 P0 | 接 cascade worker 到 `bus/memory-watchdog.ps1` | 2 天 | 未做 |
| 🔴 P0 | 接 cascade worker 到 `ops/build/build-embeddings.js` | 3 天 | 未做 |
| 🟡 P1 | `ops/export/export-md.js` 接 cascade（增量导出） | 1 天 | 未做 |
| 🟡 P1 | sync-importers 加 'md-edits' channel | 2 天 | 未做 |
| 🟢 P2 | Hybrid search 单查询混合 | 2 周 | 候选 |
| 🟢 P2 | 错误层次重构（先在 shared-mcp/ PoC） | 1 周 | 候选 |
| ⚪ P3 | 五维命名空间（仅当多用户场景出现） | 1 周 | 候选 |
| ⚪ P3 | LanceDB 替换（仅当 > 1M 记录） | 2 周 | 候选 |

---

## 5. 经验教训

✅ **做对的事**：
1. **PoC 先于设计**：cascade 队列先用纯模块 + 测试证明语义对，再考虑接生产
2. **零依赖优先**：`node:sqlite` 而非 better-sqlite3，stdlib 而非 Pillow
3. **非破坏性迁移**：markdown 派生层不改 JSONL，cascade 队列不改现有 watchdog
4. **跨语言契约优先**：LSH 真值 fixture（1000 条）保证 JS ↔ Py 等价
5. **commit message 写中文**：方便未来回顾（per CLAUDE.md §5）

❌ **做得不够的**：
1. **没有 benchmark 数据**：声称的 30× 加速是估计值，没跑 `retrieval/benchmark_qps.py` 验证
2. **没有生产观测**：cascade 队列的 stats() 没接 Prometheus / health endpoint
3. **没有向 EverOS 反馈**：没在 upstream 提 issue / 讨论他们的设计取舍

---

## 6. 参考资料

- [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS) — upstream
- [EverOS docs/storage_layout.md](https://raw.githubusercontent.com/EverMind-AI/EverOS/main/docs/storage_layout.md) — Markdown + frontmatter chassis
- [EverOS docs/how-memory-works.md](https://raw.githubusercontent.com/EverMind-AI/EverOS/main/docs/how-memory-works.md) — cascade daemon + OME
- [EverOS docs/cascade_runbook.md](https://raw.githubusercontent.com/EverMind-AI/EverOS/main/docs/cascade_runbook.md) — md_change_state queue
- [EverOS docs/architecture.md](https://raw.githubusercontent.com/EverMind-AI/EverOS/main/docs/architecture.md) — DDD 分层 + import-linter
- ANN + cascade 路线图: 见最近一次 `docs/PROJECT_AUDIT_*.md`
- 差分审计: 见最近一次 `docs/PROJECT_AUDIT_*.md`

---

<p align="right"><sub>📅 写于 2026-06-25 · 维护者: passionworkeer</sub></p>