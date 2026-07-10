# Obsidian Shared Memory Bus - 完整数据流程文档

## 目录

1. [数据存储位置](#1-数据存储位置)
2. [数据写入流程](#2-数据写入流程)
3. [数据读取流程](#3-数据读取流程)
4. [数据整理流程](#4-数据整理流程)
5. [同步机制](#5-同步机制)

---

## 1. 数据存储位置

> **A1 变更（2026-06）：store/vault 统一。** Canonical 数据源现在是 Obsidian vault 的 `00-System/ai-memory`，不再是 `~/.ai-memory`。store 根的解析优先级（Python `retrieval/runtime_support.py:resolve_store_root:243-264` 与 Node `bus/store-root.js:resolveStoreRoot:62-82` 一致）：
>
> ```
> AI_MEMORY_STORE > vault/00-System/ai-memory > AI_MEMORY_ROOT > ~/.ai-memory
> ```
>
> vault 由 `resolveFromObsidianConfig` 自动发现（读 Obsidian 的 `obsidian.json`，选最近打开的 vault，可发现任意盘的 vault）。当 vault 不存在时（CI runner、无 Obsidian 机器），纯文件 `~/.ai-memory` 才作为回退。下方所有路径相对于解析出的 store 根（正常情况即 `vault/00-System/ai-memory`）。

### 1.1 目录结构

```
<resolved store root>/                  # 默认 = vault 的 00-System/ai-memory（canonical）
                                          # 回退顺序见上方优先级链
├── inbox/                              # 各工具的收件箱
├── structured/                          # 结构化记忆文件（JSONL格式）
│   ├── shared-inbox.jsonl              # 跨工具共享收件箱
│   ├── session-memory.jsonl            # 会话层记忆
│   ├── shared-events.jsonl             # 跨工具事件
│   ├── task-memory.jsonl                # 任务状态记忆
│   ├── claude-code.jsonl               # Claude Code跨会话记录
│   ├── openclaw.jsonl                  # OpenClaw会话记录
│   ├── openclaw-blackboard.jsonl       # OpenClaw任务看板
│   ├── openclaw-runs.jsonl             # OpenClaw运行记录
│   ├── dream-inbox.jsonl               # Dream整理写入的持久化记录
│   └── archive-manifest.jsonl          # 归档清单
├── generated/                          # 生成制品
│   ├── MEMORY-LAYERS.json/.md          # 分层记忆快照
│   ├── HANDOFF.json                    # 交接包
│   ├── AUTO-DREAM.json/.md            # 自动整理摘要
│   └── GLOBAL-CONTEXT.json/.md        # 全局上下文
├── embeddings/                         # 向量索引
│   └── index.jsonl                     # BM25 + Dense 混合索引
└── kg/                                 # 知识图谱
    └── knowledge-graph.sqlite3         # 三元组数据库
```

### 1.2 记录 Schema（Memory Record Schema v2）

```json
{
  "id": "record-id",
  "schemaVersion": 2,
  "t": "2026-04-21T00:00:00Z",
  "tool": "claude-code",
  "type": "preference|workflow-rule|project-context|reference",
  "scope": "user|feedback|project|reference|summary",
  "memory_level": "event|session|task|durable",
  "source_kind": "hook|event|writeback|session|blackboard|cron|run",
  "visibility": "shared",
  "confidence": 0.75,
  "content": "实际记忆内容...",
  "title": "简短标题",
  "project": "project-name",
  "workspace": "workspace-path",
  "task_state": "pending|active|completed|failed",
  "lifecycle": {
    "tier": 3,
    "expires_at": "2026-05-21T00:00:00Z",
    "access_count": 5,
    "promotion_count": 1,
    "archived": false
  },
  "metadata": {
    "promotion": {
      "durable_type": "user|feedback|project|reference",
      "source_layer": "event|session|task",
      "source_confidence": 0.8
    }
  }
}
```

---

## 2. 数据写入流程

### 2.1 写入触发时机

| 时机 | 说明 | 代码位置 |
|------|------|----------|
| Session End | Claude Code stop hook 触发，写入 session-memory.jsonl + shared-inbox.jsonl | stop hook |
| Watchdog 轮询 | 检测源文件变化 → 触发 SyncAll (默认60秒间隔) | memory-watchdog.ps1 |
| Dream 整理 | 读取 structured/*.jsonl，生成 typed promotion queue，写入 dream-inbox.jsonl | run-memory-dream.ps1 |
| Blackboard 监控 | 检测笔记变化，触发 watchdog 下一轮同步 | obsidian-blackboard-daemon.js |
| Embeddings 重建 | 生成 embeddings/index.jsonl (180秒冷却) | generate-embeddings.js |

### 2.2 写入路径

#### 路径 1: Agent 工具调用 → structured JSONL

```
Agent 完成工具调用
  → shared MCP HTTP 请求
    → omni-memory-server.js (Node.js)
      → memory-bus.ps1 (PowerShell, spawn)
        → 写入/更新 structured/*.jsonl
```

**代码**: `shared-mcp/omni-memory-server.js`

#### 路径 2: Watchdog Scan → Structured Refresh

```powershell
# Watchdog 主循环 (60秒间隔)
while ($true) {
  Start-Sleep -Seconds $PollSeconds

  # 1. 检测文件变化
  foreach ($spec in $WatchSpecs) {
    $currentStamp = Get-WatchStamp -Spec $spec
    if ($stamps[$spec.Name] -cne $currentStamp) {
      [void]$changed.Add($spec.Name)
    }
  }

  # 2. 触发 Bus Sync
  if ($changed.Count -gt 0) {
    Invoke-BusSync -Reason ("watchdog-change:" + $changed)
  }

  # 3. 刷新制品
  Invoke-StructuredRefreshPipeline -Reason $reason
}
```

**代码**: `bus/memory-watchdog.ps1:1572-1648`

#### 路径 3: Dream 整理 → 持久化写入

```powershell
# Dream 4阶段整理
# Phase 1: 读取所有源文件
$durableRecords = Get-JsonLines -Path "shared-inbox.jsonl"
$sessionRecords = Get-JsonLines -Path "session-memory.jsonl"

# Phase 2: 构建 promotion queue
$typedDurableQueue = New-TypedDurableQueueItems -MaxPromotions 8 -MaxRefresh 8

# Phase 3: 写入 dream-inbox.jsonl (仅 -Writeback 模式)
Write-TypedDurableJsonl -PromotionQueue $promotionCandidates -TargetPath $dreamInboxPath
```

**代码**: `ops/run-memory-dream.ps1`

---

## 3. 数据读取流程

### 3.1 MCP 工具读取

```
Agent 查询请求
  → search_shared_memory MCP 工具
    → omni-memory-server.js
      → embedding-worker-pool.cjs (warm worker pool)
        → 复用常驻 Python semantic_search.py 进程
          → 读 canonical store（默认 vault/00-System/ai-memory/structured）
            → 返回混合搜索结果
```

> 检索读 canonical store。store 根由 `resolveStoreRoot` 解析（`bus/store-root.js:62-82`），优先桥接 vault 的 `00-System/ai-memory`，不再默认 `~/.ai-memory`。worker pool 复用常驻 Python 进程，避免每次冷启动。

**代码**: `shared-mcp/memory-retrieval.js`, `shared-mcp/embedding-worker-pool.cjs`

### 3.2 Python 检索引擎 - 三阶段管道

```
┌───────────────────────────────────────────────────────────────┐
│                    三阶段检索管道                              │
├───────────────────────────────────────────────────────────────┤
│  Stage 1: 元数据过滤 (零开销)                                 │
│  ├─ memory_type 匹配                                          │
│  ├─ archived = false                                          │
│  └─ expires_at > now                                          │
│                          │                                    │
│              ┌───────────┴───────────┐                      │
│              ▼                       ▼                        │
│  ┌──────────────────┐    ┌────────────────────────┐         │
│  │  BM25 / FTS5     │    │  Dense Vector Search   │         │
│  │  (始终可用)       │    │  (需 embedding)        │         │
│  └────────┬─────────┘    └────────────┬───────────┘         │
│           └──────────────┬───────────┘                      │
│                          ▼                                    │
│  ┌───────────────────────────────────────────────┐          │
│  │  Stage 3: Hybrid Merge + Rerank               │          │
│  │  score = 0.7×vec + 0.3×bm25 (可配置)           │          │
│  │  MMR λ=0.7 (Maximal Marginal Relevance)         │          │
│  │  temporal decay: half-life 30d                   │          │
│  └───────────────────────────────────────────────┘          │
└───────────────────────────────────────────────────────────────┘
```

**代码**: `retrieval/semantic_search.py`

### 3.3 查询路由 (Query Routing)

| 路由 | 触发关键词 | 权重调整 |
|------|-----------|----------|
| durable | 偏好、规则、长期、workflow | layer:durable 1.5x |
| task | 任务、运行、工单、issue、pr | layer:task 1.5x |
| recent | 最新、最近、今天 | freshness:hot 1.4x |
| reference | 链接、URL、文档 | scope:reference 1.5x |

**代码**: `retrieval/search_ranking.py:65-90`

---

## 4. 数据整理流程

### 4.1 5层记忆架构 (L0-L4)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    5层记忆架构 (Memory Tiering)                       │
├─────────────────────────────────────────────────────────────────────┤
│  Tier 1: Event / Working (实时缓冲)                                 │
│  ├─ TTL: 1 天                                                       │
│  ├─ 触发: session-end + confidence ≥ 0.5                            │
│  └─ Embedding: No                                                  │
│                                                                     │
│  Tier 2: Session Durable (会话持久化)                               │
│  ├─ TTL: session end + 7 days                                      │
│  ├─ 触发: 3+ 独立会话引用 + confidence ≥ 0.7                         │
│  └─ Embedding: No                                                  │
│                                                                     │
│  Tier 3: Project Durable (项目持久化)                               │
│  ├─ TTL: project end + 30 days                                      │
│  ├─ Embedding: Yes                                                  │
│  └─ 推荐候选: Yes                                                   │
│                                                                     │
│  Tier 4: Shared Durable (共享持久化)                                 │
│  ├─ TTL: user=never / feedback=90d / reference=180d               │
│  ├─ Embedding: Yes                                                  │
│  └─ 推荐候选: Yes                                                   │
│                                                                     │
│  Tier 5: Archive (归档)                                             │
│  ├─ TTL: 手动（永不自动删除）                                        │
│  └─ Embedding: No (manifest only)                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**代码**: `docs/MEMORY-TIERING.md`

### 4.2 Dream 整理过程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Dream 整理流程 (4 阶段)                           │
├─────────────────────────────────────────────────────────────────────┤
│  Phase 1: 数据收集 + Promotion Queue 生成                            │
│  ├─ 读取: shared-inbox, session-memory, shared-events, task-memory │
│  ├─ 分类: event / session / task 层                                  │
│  ├─ 去重: 检查与现有 durable 的 content_hash 冲突                   │
│  └─ 输出: promotion candidates + refresh targets                      │
│                                                                     │
│  Phase 2: 持久化写入 (-Writeback 模式)                              │
│  ├─ 写入 dream-inbox.jsonl                                          │
│  └─ 追加 MEMORY.md 索引                                             │
│                                                                     │
│  Phase 3: 生成报告                                                  │
│  ├─ AUTO-DREAM.md (人类可读摘要)                                    │
│  └─ AUTO-DREAM.json (机器可读报告)                                  │
│                                                                     │
│  Phase 4: 触发归档检查                                              │
│  └─ 调用 memory-archival.js (可选)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**代码**: `ops/run-memory-dream.ps1`

### 4.3 归档规则

| Tier | 归档条件 |
|------|----------|
| T1 | age > 1天 且 无 session-end signal |
| T2 | age > 30天 且 promotion_count < 2 |
| T3 | expires_at 过期 |
| T4 | TTL 过期 或 60天 无访问 |

**代码**: `ops/memory-archival.js`

---

## 5. 同步机制

### 5.1 Watchdog 监控源

| 工具 | 监控路径 |
|------|----------|
| Claude Code | ~/.claude/memory/*.md, ~/.claude-mem/ |
| Skills | ~/.agents/skills/, ~/.claude/skills/ (每120秒) |
| Codex | ~/.codex/history.jsonl, ~/.codex/sessions/ |
| OpenClaw | ~/.openclaw/agents/main/sessions/, blackboard/tasks.db |
| Trae | ~/.trae/user_rules.md, ~/.trae/History/ |
| Copilot | globalStorage/, workspaceStorage/ |

### 5.2 Bus Sync 流程

```powershell
# SyncAll 操作
Sync-AllSources {
  # 1. 同步共享技能
  Sync-SharedSkills -WorkspaceRoot $projectDirectory

  # 2. 同步各工具快照
  Sync-ClaudeSnapshot
  Sync-CodexSnapshot
  Sync-OpenClawSnapshot
  Sync-OpenCodeSnapshot
  Sync-CopilotSnapshot
  Sync-TraeSnapshot

  # 3. 刷新生成制品
  Invoke-GeneratedArtifactRefresh
}
```

**代码**: `bus/memory-bus.ps1`

---

## 附录: 数据流总图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           AGENTS (多工具)                                     │
│   Claude Code · Codex · OpenCode · Copilot · Trae · OpenClaw                 │
└──────────────────────────────┬────────────────────────────────────────────────┘
                                │
               ┌────────────────┴────────────────┐
               ▼                                 ▼
┌─────────────────────────┐    ┌─────────────────────────────────────────┐
│   Shared MCP Layer      │    │     Native Memory Stores                  │
│   omni-memory-server    │    │                                         │
│   Port 9338            │    │  ~/.claude-mem/                          │
│                        │    │  ~/.openclaw/                            │
│   Tools:              │    │  ~/.codex/                               │
│   - search_shared_memory│    │  ~/.trae/                                │
│   - memory_boot        │    │                                         │
│   + more              │    └─────────────────────────────────────────┘
┌─────────────────────┬──────────────┘
             │
             │ warm worker pool (embedding-worker-pool.cjs)
             │   复用常驻 Python semantic_search.py 进程
             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PYTHON RETRIEVAL LAYER                                  │
│  semantic-search.py                                                         │
│    ├── BM25 + Dense 并行搜索                                               │
│    ├── 混合合并 + MMR + 时间衰减                                            │
│    └── 缓存: query-embedding + result                                       │
└────────────┬────────────────────────────────────────────────────────────────┘
             │
             │ resolve_store_root 桥接（store = vault/00-System/ai-memory）
             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              CANONICAL STORE (默认 = Obsidian vault/00-System/ai-memory)      │
│  回退链: AI_MEMORY_STORE > vault > AI_MEMORY_ROOT > ~/.ai-memory              │
│                                                                              │
│  structured/*.jsonl          ← 结构化记录                                   │
│  generated/*.json             ← 生成制品                                    │
│  embeddings/index.jsonl      ← 向量索引                                     │
│  kg/knowledge-graph.sqlite3   ← 知识图谱                                     │
└─────────────────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     POWERSHELL ORCHESTRATION                                 │
│  memory-watchdog.ps1          ← 后台守护 (事件驱动模式)                      │
│  memory-bus.ps1               ← 同步脚本                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 关键文件索引

| 功能 | 文件路径 |
|------|----------|
| Watchdog 主循环 | `bus/memory-watchdog.ps1` |
| Bus 同步 | `bus/memory-bus.ps1` |
| MCP 服务器 | `shared-mcp/omni-memory-server.js` |
| 检索工具 | `shared-mcp/memory-retrieval.js` |
| 记忆层构建 | `ops/build-memory-layers.js` |
| Dream 整理 | `ops/run-memory-dream.ps1` |
| 归档管理 | `ops/memory-archival.js` |
| Python 检索 | `retrieval/semantic_search.py` |
| BM25 + Dense 排名 | `retrieval/search_ranking.py` |
| Embeddings 生成 | `bus/generate-embeddings.js` |
| 5 层架构文档 | `docs/MEMORY-TIERING.md` |
| 架构文档 | `docs/ARCHITECTURE.md` |
