# Obsidian Shared Memory Bus — 面试复习报告

> 本报告用于深度理解项目设计思想、技术选型原理和底层架构，适合面试前系统性复习。
> 涵盖：问题域、核心挑战、架构演进、技术栈选择、检索原理、多层记忆设计、MCP协议、混合搜索、并发安全、跨平台抽象。

---

## 一、项目是什么？

**一句话定义**：一个**本地优先的多智能体共享记忆总线**，让多个 AI 编程工具（Claude Code、Codex、OpenCode、Cursor、Copilot、Trae）共享同一份长期记忆，而不是各自遗忘。

**核心价值**：
- 多个 AI 工具间共享用户偏好、项目上下文、工作流程规则
- 不依赖云服务，数据完全本地存储在 `E:\.ai-memory\` 目录
- 一个共享的 MCP 服务进程，替代原来每个工具各起一个 MCP 进程的资源浪费

---

## 二、要解决的核心问题是什么？

### 2.1 多智能体记忆孤岛问题

每个 AI 工具（Claude Code、Codex 等）都有自己独立的记忆存储：
- Claude Code → `.claude/` 下的内存文件
- Codex → `~/.codex/memories/`
- OpenClaw → SQLite 黑板数据库
- OpenCode → `~/.local/share/opencode/opencode.db`

**问题**：用户在一个工具里告诉 AI 的偏好，切换到另一个工具后需要重新解释。上下文不共享，每次都是"冷启动"。

### 2.2 MCP 进程爆炸问题

每个 AI 工具各自启动自己的 MCP 服务器进程。运行 6 个工具 + 4 个 MCP 服务 = 24 个进程，其中大量是重复的。

### 2.3 记忆质量与检索问题

- 记忆不是越多越好，需要分层分级（事件缓冲 → 会话持久 → 项目 → 共享）
- 检索需要兼顾关键词匹配（BM25）和语义相似度（向量搜索）
- 记忆的晋升、归档、去重需要有幂等保证，不能因为重复运行而破坏数据

---

## 三、技术栈选择及背后的"为什么"

### 3.1 三语言混合运行时

| 语言 | 职责 | 为什么用它 |
|------|------|-----------|
| **PowerShell** | 进程生命周期、守护进程、开机启动注册 | Windows 原生，进程管理能力最强，适合守护循环 |
| **Node.js (ESM)** | MCP 服务器、业务逻辑、JSONL 处理 | MCP 协议官方 SDK 是 Node.js，JSON 处理高效 |
| **Python** | 检索核心（BM25 + 向量搜索） | 数学计算生态最强，`rank-bm25`、`jieba`、`numpy` 等库成熟 |

**取舍**：三语言确实带来复杂度（需要 Python 运行时检测、进程间通信），但避免了：
- 在 Node.js 里写 BM25 算法（性能差）
- 在 Python 里管理 Windows 进程（原生模块地狱）
- 引入 `better-sqlite3` 等需要编译的原生绑定

### 3.2 本地向量搜索：`hashing-v1`（离线方案）

**默认 embedding 后端**：`hashing-v1`（Locality Sensitive Hashing，LSH）

- **完全离线**：不需要 API key，不依赖任何远程服务
- **适合中国网络环境**：Ollama 等国外服务访问受限
- **LSH 原理**：将高维向量映射到桶，相似向量大概率落在同一桶中。精度不如 cosine similarity，但在内存充足时效果可用

**可选远程后端**：OpenAI-compatible API（通过 `set_embedding_runtime` 动态切换）

```
配置层级：
  AI_MEMORY_EMBED_PROFILE   →  选择预配置方案（auto/ollama/openai）
  AI_MEMORY_EMBED_PROVIDER  →  覆盖 provider
  AI_MEMORY_EMBED_ADAPTER   →  覆盖适配器
```

### 3.3 数据存储：JSONL + SQLite（无厂商锁定）

**为什么不直接用 SQLite 存所有数据？**

ADR-002 明确说明：
> ADR-001 是纯 Markdown 文件系统 → ADR-002 引入 SQLite 用于索引，但 Markdown 文件仍保留用于：
> - 人类可读（可直接打开 `.ai-memory/user/xxx.md` 查看）
> - git 版本化（直接 `git diff` 看记忆变更历史）
> - 可迁移（不需要专门的数据库工具）

**SQLite 只用作索引层**：
- `chunks` 表：文本块 + 行号范围 + hash
- `chunks_fts` 表：FTS5 全文索引（BM25 评分）
- `chunks_vec` 表：`sqlite-vec` 向量索引
- `embedding_cache` 表：embedding 缓存（避免重复 API 调用）

**JSONL 用作事件流**：追加写入，无需锁（append-only 天然线程安全）

### 3.4 MCP 协议（Model Context Protocol）

MCP 是 Anthropic 提出的标准化协议，定义 AI 客户端 ↔ 工具服务器之间的通信规范。

```
客户端                          MCP 服务器
  │                                │
  ├─ initialize() ────────────────→│  握手协商协议版本
  │←── server_info ────────────────┤
  │                                │
  ├─ tools/list() ────────────────→│  列出可用工具
  │←── tools: [...] ───────────────┤
  │                                │
  ├─ tools/call(search_memory) ────→│  调用工具
  │←── results: [...] ──────────────┤
```

本项目将 MCP 服务器以 **HTTP+JSON** 模式暴露在本地端口（9338 等），而非传统 stdio 模式。

**为什么用 HTTP 而不是 stdio？**
- 多个 AI 工具可以共享同一个 HTTP 端点
- stdio 是一对一管道，无法共享
- HTTP 模式下，一个 Playwright 服务器可以服务多个隔离的浏览器会话

### 3.5 进程去重（Singleton Proxy）

`singleton-stdio-mcp-proxy.mjs` 解决：同一 MCP 服务器被多次启动的问题。

```javascript
// 核心思路：
// 1. 启动时检查互斥锁（Windows: named mutex, Unix: flock）
// 2. 若已有实例在跑 → 通过 stdio 代理转发给现有进程
// 3. 若无实例 → 启动真实服务器
```

Windows 上的特殊处理：Node.js 进程默认会弹出控制台窗口。使用 `--hidden` 或 PowerShell `Start-Process -WindowStyle Hidden` 消除。

---

## 四、核心架构设计

### 4.1 整体分层架构

```
┌──────────────────────────────────────────────────────────┐
│  AI Clients (Claude Code / Codex / OpenCode / ...)       │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP/MCP (端口 9338)
                         ▼
┌──────────────────────────────────────────────────────────┐
│  shared-mcp / omni-memory-server.js  (Node.js MCP 服务) │
│  - HTTP transport layer                                  │
│  - Tool dispatch: search_memory / write_memory / ...     │
│  - Process deduplication (singleton proxy)               │
└──────────┬─────────────────────────────┬────────────────┘
           │                             │
           ▼                             ▼
┌─────────────────────┐    ┌────────────────────────────────┐
│  bus/memory-bus.ps1 │    │  retrieval/semantic-search.py  │
│  (PowerShell 编排)   │    │  (Python 混合检索)              │
│  - 同步内存          │    │  - BM25 (rank-bm25)            │
│  - 守护进程          │    │  - Dense (hashing-v1 / Ollama)│
│  - 事件记录          │    │  - Hybrid merge                │
└──────────┬──────────┘    │  - MMR reranking               │
           │               │  - Temporal decay               │
           ▼               └──────────────┬─────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Canonical Store: E:\.ai-memory\                        │
│  - structured/*.jsonl  (事件流 / 会话 / 任务记录)          │
│  - user/feedback/project/reference/  (持久化记忆)          │
│  - sessions/  (分 agent 的会话日志，chunk manifest 格式)   │
│  - .index/memory.db  (SQLite: FTS5 + sqlite-vec)         │
│  - generated/  (AUTO-DREAM / HANDOFF 等派生摘要)          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 为什么这样分层？

1. **MCP 服务器（Node.js）** 负责协议解析和工具调度，与 AI 客户端直接通信
2. **检索引擎（Python）** 独立进程，通过 subprocess 或 HTTP 调用，保持冷启动能力
3. **编排脚本（PowerShell）** 负责非功能性需求：进程生命周期、开机启动、文件监控（chokidar）
4. **数据存储（文件系统）** 是唯一的事实来源，所有进程都可以读写，但通过锁协调

**关键原则**：MCP 是传输层，不是存储层。记忆的最终来源永远是 `.ai-memory` 文件系统。

---

## 五、5层记忆架构（MEMORY-TIERING）

这是 ADR-002 的核心创新之一。记忆按生命周期分为5层，每层有不同的 TTL、索引策略和晋升规则。

### 5.1 各层职责

| 层 | 名称 | TTL | Embedding | 定位 |
|----|------|-----|-----------|------|
| L1 | **Event / Working** | 1天 | 否 | 实时工作缓冲区，当前会话的事件记录 |
| L2 | **Session Durable** | 会话结束+7天 | 否 | 确认后的会话学习，等待项目级验证 |
| L3 | **Project Durable** | 项目结束+30天 | **是** | 跨会话验证的事实，绑定到具体项目 |
| L4 | **Shared Durable** | user=永不 / feedback=90d / reference=180d | **是** | 跨项目通用知识（用户偏好、反馈规则） |
| L5 | **Archive** | 手动 | 否（仅 manifest） | 冷存储，不污染向量空间 |

### 5.2 为什么要分层？

**记忆不是越多越好**：
- L1 只保留1天，避免无用事件占用空间
- L3 要求"3个独立会话都提到同一事实"才晋升，防止噪音进入长期记忆
- L4 的 user 类型永不过期（除非手动撤销）

**Embedding 的成本意识**：
- L1/L2 不做 embedding（太临时，不值得花 API 费用）
- L3/L4 是推荐候选，需要高质量检索
- L5 不做 embedding（归档数据不需要被召回），用 `archive-manifest.jsonl` 代替 tombstone（ADR-002 Q3 fix）

### 5.3 幂等晋升保证

```javascript
// 所有层级转换都是幂等的：
if (record.tier >= TARGET_TIER) return  // 已晋升过，直接跳过

// 例：L1 → L2
if (session_end_signal && confidence >= 0.5) {
  record.tier = 2
  record.lifecycle.promoted_from = 'event'
  record.lifecycle.promotion_count++
}
```

这确保：守护进程（Watchdog）和梦者（Dreamer）可以同时评估同一记录，不会重复晋升。

### 5.4 Typed Promotion Contract（类型化晋升契约）

记忆晋升到 L4 时必须携带类型标签：

```yaml
promotion:
  version: 1
  durable_type: feedback    # user | feedback | project | reference
  key: no_mock_db_integration_tests  # 稳定 key，用于去重
  reason: initial | updated | conflict_resolved
  source_type: session | event | blackboard | manual
  source_confidence: 0.6
  promoted_at: 2026-04-03T10:00:00Z
```

**为什么需要 typed promotion？**
- 防止"同一件事实在不同时间被重复写入"
- `key` 字段（slug 化的 memory name）是去重键
- `content_hash`（SHA-256 of 正文）是内容去重键
- 冲突时，新记录 `conflict_with: [旧ID]`，旧记录进 Archive

---

## 六、混合检索原理（Hybrid Retrieval）

### 6.1 为什么需要混合检索？

单一检索方式都有缺陷：

| 方法 | 优点 | 缺点 |
|------|------|------|
| BM25 | 关键词精确、不需要模型 | 无法理解语义（"戒毒" vs "戒毒所"） |
| Dense向量 | 语义理解强 | 需要 embedding 模型，可能过度泛化 |
| 纯关键词 | 无需额外资源 | 召回率低 |

**解决方案**：混合评分 + 重排（reranking）

### 6.2 三阶段检索流程

```
用户查询
    │
    ▼
Stage 1: SQLite 元数据过滤
  → 快速排除 archived=true、TTL 过期的记录
  → 零 API 调用的候选集生成

    ▼
Stage 2: 并行搜索
  ┌─────────────────┐   ┌──────────────────────┐
  │ BM25 / FTS5     │   │ 向量相似度 (cosine)    │
  │ 关键词评分       │   │ 语义评分              │
  │ score_bm25      │   │ score_vec             │
  └─────────────────┘   └──────────────────────┘

    │
    ▼
Stage 3: 混合合并 + MMR 重排
  score = 0.7 × score_vec + 0.3 × score_bm25
  ├── MMR（最大边际相关性）→ 增加结果多样性
  ├── 时间衰减（Temporal Decay）→ 近期的记忆权重更高
  └── access_count boost → 被频繁访问的记忆轻微加分

    ▼
Stage 4: 水合（Hydrate）
  根据 chunk_id 加载完整文本，返回结果
```

### 6.3 MMR（最大边际相关性）

MMR 解决"检索结果重复"的问题：

```python
# 标准余弦相似度的问题：
# query="Python 异步" → top3 可能都是 asyncio 相关，缺失了 asyncpg

# MMR 公式：
# MMR = argmax_{d∈R\C} [λ·sim(d,Q) - (1-λ)·max_{c∈C} sim(d,c)]
# λ=0.7: 70% 看重相关性，30% 看重与已有结果的多样性

# Jaccard 相似度用于去重：
# jaccard(chunks[i], chunks[j]) = |intersection| / |union|
# 如果 jaccard > 0.5，视为重复
```

### 6.4 时间衰减（Temporal Decay）

```python
# 指数衰减：
weight *= exp(-λ × days_since_access)

# 默认 half-life = 30天
# 30天前的记忆权重降为 exp(-0.693) ≈ 0.5
# 90天前的记忆权重降为 exp(-2.079) ≈ 0.125
```

防止陈旧记忆始终占据前排，让新的项目上下文有机会被召回。

### 6.5 Embedding 缓存机制

```
首次 embedding 请求：
  text → SHA256(text) → 检查 embedding_cache 表
  → 缓存未命中 → 调用 API → 存入缓存 → 返回

后续相同文本：
  text → SHA256(text) → 检查 embedding_cache 表
  → 缓存命中 → 直接返回（零 API 费用）
```

缓存 key = `(provider, model, api_key, hash)`，确保不同模型的向量不会混用。

---

## 七、守护进程与梦者模型

### 7.1 Watchdog（守护进程）

`bus/memory-watchdog.ps1` 是后台常驻进程：

- **职责**：监控源文件变化（Claude Code 的 `.claude/`、OpenClaw 的 SQLite 等）
- **触发条件**：检测到变化 → 增量同步到结构化 JSONL
- **防抖**：chokidar 1500ms 防抖，避免频繁写入
- **刷新策略**：基于**真实结构性记忆签名变化**，而非所有文件变化（ADR-002 优化）

### 7.2 Dreamer（梦者模型）

**核心洞察**：由"用户最常用的 AI 工具"来执行记忆整合（而不是独立的守护进程）。因为最常用的工具最了解用户当前的工作模式。

**整合流程（四阶段）**：

```
Phase 1: Orient（定向）
  → 读取 MEMORY.md 了解当前长期记忆
  → 扫描 sessions/ 找未处理的 chunk manifests

Phase 2: Gather（收集）
  → 收集值得晋升到长期记忆的信号
  → 检测冲突：同 key 不同内容 → 标记冲突解决
  → 检测过期：代码/CLAUDE.md 否定旧记忆 → 标记归档

Phase 3: Consolidate（合并）★ 有锁保护
  → 获取 consolidation.lock（PID + mtime，60分钟过期）
  → 写入 user/feedback/project/reference/ 层
  → 更新 MEMORY.md 索引
  → 释放锁

Phase 4: Prune（修剪）
  → 标记过期记忆：archived: true，移入 archived/
  → 更新 lifecycle.expires_at
  → 超过180天 → 提示用户永久删除
```

**Phase 3 加锁的原因（ADR-002 P1 fix）**：
> ADR-001 没有这个锁 → 多个 AI 工具同时执行整合 → 写入竞争 → 数据损坏

---

## 八、MCP 协议实现细节

### 8.1 HTTP Transport vs stdio Transport

| 模式 | 传输 | 共享能力 | 复杂度 |
|------|------|---------|--------|
| stdio | 进程管道 | 否（一对一） | 低 |
| HTTP | 本地端口 | **是**（多客户端） | 中 |

### 8.2 核心 MCP 工具列表

```typescript
// 搜索
search_memory({
  query: string,
  route?: 'auto'|'bm25'|'dense'|'mixed'|'durable'|'task'|'recent',
  memory_type?: 'user'|'feedback'|'project'|'reference',
  maxResults?: number,    // default: 6
  minScore?: number,      // default: 0.35
})

// 写入
write_memory({
  name: string,
  description: string,
  type: 'user'|'feedback'|'project'|'reference',
  content: string,
  source_confidence?: number
})

// 状态
get_memory_status() → {
  sessionCount, memoryCount, chunkCount,
  lastConsolidated, dreamer,
  embeddingProvider, embeddingCacheHitRate,
  avgQueryLatencyMs
}

// 启动（冷启动用）
memory_boot(project: string) → {
  identity, essential, recent, retrieve
}
```

### 8.3 进程去重（Singleton Proxy）的工作原理

```
首次启动 Server A（端口 9338）：
  → 检查 named mutex "ai-memory-memory-mcp" 是否存在
  → 不存在 → 创建 mutex → 启动真实 MCP 进程

第二次启动 Server B（同一端口）：
  → 检查 mutex → 已存在
  → Server B 不启动新进程
  → 通过 stdio 代理转发给 Server A 处理
  → Server A 处理后结果通过 Server B 的 stdio 返回

Windows 特殊处理：
  → Node.js 在 Windows 上默认弹出控制台窗口
  → 使用 PowerShell Start-Process -WindowStyle Hidden
  → 或使用 --hidden 参数
  → 或通过 temp-batch cmd.exe 包装
```

---

## 九、跨平台抽象

### 9.1 三平台策略

| 平台 | 进程管理 | 开机启动 | 脚本 |
|------|---------|---------|------|
| **Windows** | PowerShell 7+ / 5.1 | Startup 文件夹 | .ps1 |
| **macOS** | pwsh (PowerShell Core) | LaunchAgents | .sh / .ps1 |
| **Linux** | pwsh | systemd --user / XDG autostart | .sh / .ps1 |

### 9.2 为什么坚持用 PowerShell 作为跨平台脚本语言？

- **pwsh（PowerShell Core）** 是真正的跨平台（Windows/macOS/Linux）
- Windows 11 自带 PowerShell 5.1，无需安装
- 进程操作能力（`Start-Process`、`Test-Path`、守护循环）比 bash 更一致
- macOS/Linux 需要额外安装 `pwsh`，但这是合理的依赖

---

## 十、架构决策记录（ADR）及其演进

### ADR-001 → ADR-002 的关键演进

ADR-001 被废弃的原因（benchmark 发现 P0/P1 gap）：

| 问题 | 严重性 | 解决方案 |
|------|--------|---------|
| Phase 1 无内容级索引 | P0 | FTS5 + BM25 |
| typed promotion 只在文档中，无 schema | P0 | frontmatter 中加 `promotion` 字段 |
| 无 chunk 机制，session 文件全量读写 | P1 | chunk manifest（SHA256 + start/end_line）|
| BM25 未加权到混合评分 | P1 | 0.7×向量 + 0.3×BM25 |
| 无 MMR 重排 | P1 | Maximal Marginal Relevance |
| 无时间衰减 | P1 | 指数衰减（half-life 30d）|
| 无 embedding 缓存 | P1 | embedding_cache 表 |
| Phase 3 整合无锁 | P1 | consolidation.lock（PID+mtime）|

---

## 十一、设计中的权衡（Trade-offs）

### 11.1 本地优先 vs 云服务能力

**选择本地优先**的理由：
- 中国大陆网络访问国外 API 不稳定
- 数据主权（用户偏好、工作内容不经过第三方）
- 零成本（不需要 OpenAI/Anthropic API 费用）

**代价**：向量搜索精度不如商业 embedding 服务；本地 LSH `hashing-v1` 是精度/速度/离线三者的折中。

### 11.2 可移植性 vs 功能深度

ADR-002 Q2 Trade-off：
> ADR-001 纯文件系统可移植性更好，但 ADR-002 引入 SQLite（需要原生绑定）
> → 折中方案：SQLite 只做索引，Markdown 文件仍然保留

### 11.3 三语言运行时 vs 单语言简洁性

**选择三语言的理由**：
- Node.js：MCP 官方 SDK 生态
- Python：检索算法成熟库（rank-bm25、jieba、numpy）
- PowerShell：Windows 原生进程管理无可替代

**承认的代价**：
- 需要 Python 运行时检测（支持 uv、D:\python\python.exe 等多种路径）
- 跨语言进程间通信增加了复杂度
- 学习曲线更陡

---

## 十二、面试高频问题 & 标准答案

### Q1：这个项目解决了什么问题？

**答**：解决了多 AI 工具间记忆不共享的问题。每个 AI 工具（Claude Code、Codex 等）都有独立的本地记忆，互相不知道对方记住了什么。这个项目提供了一个共享的记忆总线，让多个工具读写同一个本地存储，实现上下文共享。

### Q2：为什么要分层记忆？L1 和 L3 的本质区别是什么？

**答**：记忆不是越多越好，需要按生命周期分级。L1 是实时事件缓冲（TTL=1天），L3 是跨会话验证的事实（TTL=项目+30天）。本质区别：
1. **时间尺度**：L1 是分钟~小时级，L3 是周~月级
2. **验证要求**：L3 需要3个独立会话都确认同一事实，防止噪音
3. **索引策略**：L1/L2 不做 embedding（太临时不值得），L3 做（需要高质量检索）
4. **晋升触发**：L1→L2 靠会话结束信号，L2→L3 靠跨会话验证

### Q3：BM25 和向量检索各自的优缺点？为什么混合使用？

**答**：
- BM25：基于词频和文档频率的统计排序，**关键词查询精确**（查 "Python 异步" 就找含这两个词的结果），不需要模型，完全离线
- 向量检索：通过 embedding 模型将文本映射到高维向量，**语义理解强**（"如何戒毒"和"戒毒所推荐"语义相近），但需要 API 或本地模型

**混合原因**：单一方法都有盲区。关键词查询"异步编程"搜不到讲 `asyncio` 的结果（因为没直接含这个词），纯向量搜索可能过度泛化。混合评分 `0.7×向量 + 0.3×BM25` 兼顾两者优点。

### Q4：MMR 是什么？为什么需要它？

**答**：MMR（Maximal Marginal Relevance，最大边际相关性）是一种重排策略。问题背景：按相似度排序返回前3个结果，可能都是高度重复的（如都讲 asyncio）。MMR 在每步选择下一个结果时，同时考虑：
1. 与查询的相关性
2. 与已选结果的多样性（Jaccard 相似度）

公式：`MMR = argmax [λ·sim(d,Q) - (1-λ)·max sim(d,已选结果)]`

λ=0.7 表示70%看重相关性，30%看重多样性。

### Q5：为什么 Phase 3 要加锁？不用锁会怎样？

**答**：Phase 3 是多文件写入阶段（user/、feedback/、project/、reference/ 同时写入）。如果不用锁，两个 AI 工具同时执行整合，可能发生：
1. **写入冲突**：同时写入 `user/preferences.md`，一个工具写入 A 内容，另一个写入 B 内容，后写的覆盖先写的，A 内容丢失
2. **索引不一致**：MEMORY.md 索引更新和文件写入不是原子的，中间状态被另一个进程读到

**解决方案**：用 `.lock/consolidation.lock` 文件（PID + mtime，60分钟过期）。获取锁 → 执行写入 → 释放锁。ADR-001 没这个锁，所以是 P1 问题。

### Q6：为什么用 JSONL 而不是 SQLite 直接存所有数据？

**答**：两个原因：
1. **可移植性**：Markdown/JSONL 文件可以直接 `git diff`，查看记忆变更历史，不需要专门的数据库工具
2. **分层设计**：SQLite 只做索引（chunks、fts、vec），业务数据仍然是文件系统。避免"数据库损坏 = 记忆全部丢失"的风险

另外，JSONL 是追加写入，天然并发安全（多进程同时 append 不会覆盖）。

### Q7：什么叫幂等晋升？为什么重要？

**答**：幂等晋升 = 同一晋升逻辑运行多次，结果和运行一次相同。实现方式：晋升前检查 `if (record.tier >= TARGET_TIER) return`。**重要性**：
1. Watchdog 和 Dreamer 可能同时评估同一记录，不会双重晋升
2. 整合脚本可以安全地重新运行（断点恢复）
3. 多 Agent 并发整合不会破坏数据一致性

### Q8：什么是 typed promotion？key 和 content_hash 的区别？

**答**：
- `promotion.key`：记忆的 slug 化名称（如 "no_mock_db_integration_tests"），用于跨会话去重（"这个事实之前晋升过吗？"）
- `content_hash`：正文的 SHA-256，用于内容级去重（"这个具体内容已经存在吗？"）

**区别**：key 相同时 → 可能是同一主题的更新（reason=updated）；content_hash 相同时 → 完全重复（直接跳过）。

### Q9：Watchdog 和 Dreamer 的区别？

**答**：
- **Watchdog**（`memory-watchdog.ps1`）：**被动同步**。监控源文件变化，增量同步到结构化 JSONL。守护进程，常驻。
- **Dreamer**：**主动整合**。用户最常用的 AI 工具在空闲时执行四阶段整合（Orient→Gather→Consolidate→Prune）。周期性触发（默认空闲15分钟+积累阈值）。

### Q10：embedding 缓存的工作原理？为什么需要它？

**答**：embedding 缓存以 `(provider, model, api_key, text_hash)` 为 key 缓存向量。**需要它的原因**：
1. **成本**：相同文本（如代码注释）在多个 session 中重复出现，每次都调 API 浪费费用
2. **性能**：缓存命中时检索速度接近内存查找
3. **API 限制**：避免高频调用触发速率限制

---

## 十三、项目亮点（面试加分项）

1. **三系统 Benchmark 驱动架构演进**：ADR-002 不是拍脑袋设计的，是通过对标 OpenClaw、Claude Code native、claude-mem 三个系统，发现了 P0/P1 gap 后迭代出来的
2. **幂等性设计**：整个记忆生命周期（晋升、归档、整合）都是幂等的，可安全重试
3. **离线优先**：默认 `hashing-v1` LSH 向量，不依赖任何外部 API
4. **Content-Hash 签名**：生成的派生文件（HANDOFF、AUTO-DREAM）携带内容签名，用于检测过期/过时
5. **进程去重**：通过 named mutex 实现 MCP 服务单例，节省系统资源
6. **Windows 深度打磨**：大量 PowerShell 脚本处理 Windows 特有的控制台窗口、UAC、路径等问题

---

## 附录：关键文件速查

| 文件 | 作用 |
|------|------|
| `docs/adr/ADR-002-unified-memory-architecture-v2.md` | 架构决策记录（必读）|
| `docs/MEMORY-TIERING.md` | 五层记忆详细规范 |
| `bus/memory-watchdog.ps1` | 守护进程（增量同步）|
| `bus/memory-bus.ps1` | 记忆同步引擎 |
| `shared-mcp/omni-memory-server.js` | MCP 服务器入口 |
| `shared-mcp/singleton-stdio-mcp-proxy.mjs` | 进程去重代理 |
| `retrieval/semantic-search.py` | 混合检索核心（BM25+向量+MMR）|
| `ops/build-memory-layers.js` | 构建分层记忆快照 |
| `ops/check-memory-integrity.js` | 记忆完整性检查 |
