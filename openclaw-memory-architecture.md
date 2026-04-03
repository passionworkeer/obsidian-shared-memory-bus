# OpenClaw 记忆架构详解

> 基于源码分析，OpenClaw 版本对应 `.openclaw/workspace/openclaw/`
> 分析日期：2026-04-03

---

## 1. 架构概览

OpenClaw 的记忆系统是一个**多层混合搜索基础设施**，核心索引 Markdown 文件（以及可选的会话记录），支持语义搜索和关键词搜索两套检索能力。

### 1.1 双后端设计

| 后端 | 路径 | 技术栈 | 特点 |
|------|------|--------|------|
| **Builtin（默认）** | `src/memory/` | SQLite + sqlite-vec + FTS5 | 自包含，无需额外依赖 |
| **QMD（可选）** | `src/memory/qmd-manager.ts` | 外部 CLI + 本地 ML 模型 | 支持 MCP bridge，ML 增强 |

### 1.2 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      AGENT / CLI / 插件                     │
│   memory_search tool   memory_get tool   openclaw memory CLI  │
└────────────────────────────┬────────────────────────────────┘
                             │
                    MemorySearchManager 接口
                    (src/memory/types.ts:61-81)
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌──────────────┐   ┌─────────────────┐   ┌──────────────────┐
│ BuiltinBackend│   │   QMD Backend   │   │  FallbackManager  │
│ MemoryIndex  │   │  QmdMemoryMgr   │   │  (QMD 失败时兜底) │
│              │   │                 │   └──────────────────┘
│ - SQLite     │   │ - qmd CLI 进程  │
│ - sqlite-vec  │   │ - mcporter MCP  │
│ - FTS5       │   │ - Collections   │
│ - Embed Cache│   │ - 会话导出管线   │
└──────┬───────┘   └─────────────────┘
       │
       ▼
   Embedding Providers
   (OpenAI / Gemini / Voyage / Mistral / Ollama / Local)
```

---

## 2. 核心数据结构

### 2.1 数据库 Schema

**文件：** `src/memory/memory-schema.ts:3-96`

```sql
-- 元数据表
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 文件清单（追踪已索引文件）
CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  source      TEXT NOT NULL DEFAULT 'memory',  -- 'memory' 或 'sessions'
  hash        TEXT NOT NULL,                    -- 内容 SHA-256
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL
);

-- 分块存储（核心表）
CREATE TABLE chunks (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'memory',
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  model       TEXT NOT NULL,                    -- 使用的 Embedding 模型
  text        TEXT NOT NULL,                   -- 原始文本
  embedding   TEXT NOT NULL,                   -- JSON 序列化的向量
  updated_at  INTEGER NOT NULL
);

-- Embedding 缓存
CREATE TABLE embedding_cache (
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash         TEXT NOT NULL,
  embedding    TEXT NOT NULL,
  dims         INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- FTS 虚拟表（全文搜索）
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, id, path, source, model, start_line, end_line
);

-- 向量虚拟表（sqlite-vec）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[dims]
);
```

### 2.2 核心类型定义

**文件：** `src/memory/types.ts:1-81`

```typescript
type MemorySource = "memory" | "sessions";

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

interface MemorySearchManager {
  search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }): Promise<MemorySearchResult[]>;

  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{ text: string; path: string }>;

  status(): MemoryProviderStatus;

  sync?(params?: unknown): Promise<void>;

  probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }>;

  probeVectorAvailability(): Promise<boolean>;

  close?(): Promise<void>;
}
```

### 2.3 会话文件模型

**文件：** `src/memory/session-files.ts:10-19`

```typescript
type SessionFileEntry = {
  path: string;        // e.g., "sessions/session-id.jsonl"
  absPath: string;     // 绝对路径
  mtimeMs: number;
  size: number;
  hash: string;       // 内容 + lineMap 的 SHA-256
  content: string;     // 扁平化的消息文本
  lineMap: number[];   // 内容行号 → JSONL 源行号 的映射
};
```

---

## 3. 记忆存储流程（Indexing）

### 3.1 主流程

**文件：** `src/memory/manager.ts:803-924`

```
文件发现 (Walk workspace)
  ├── 查找 MEMORY.md / memory.md / memory/*.md
  ├── SHA-256 hash 比对（仅重新索引变更文件）
  ├── Markdown 分块（默认 400 tokens，80 重叠）
  └── Embedding 生成 + 双存储（FTS + 向量表）
```

### 3.2 Markdown 分块

**文件：** `src/memory/internal.ts:334-416`

核心函数 `chunkMarkdown()`：
- 按 Markdown 标题结构（H1-H6）切分文档
- 支持重叠区域保持上下文连贯性
- 返回每个 chunk 的起止行号

### 3.3 Embedding 生成

**文件：** `src/memory/manager-embedding-ops.ts`（批量操作）

支持的 Embedding 提供商：

| 提供商 | 文件 | 默认模型 |
|--------|------|----------|
| OpenAI | `src/memory/embeddings-openai.ts` | `text-embedding-3-small` |
| Gemini | `src/memory/embeddings-gemini.ts` | `gemini-embedding-001` |
| Voyage AI | `src/memory/embeddings-voyage.ts` | `voyage-4-large` |
| Mistral | `src/memory/embeddings-mistral.ts` | `mistral-embed` |
| Ollama | `src/memory/embeddings-ollama.ts` | `nomic-embed-text` |
| Local（本地 LLM） | `src/memory/node-llama.ts` | `embeddinggemma-300m-qat-q8_0` |

Provider 自动选择逻辑（`src/memory/embeddings.ts:168-288`）：
1. `provider: "auto"` — 优先本地，依次尝试远程
2. API key 缺失时 — 自动降级为 FTS-only 模式（无 Embedding）
3. OpenAI / Gemini / Voyage 支持批量模式

---

## 4. 搜索流程（Query）

### 4.1 混合搜索算法

**文件：** `src/memory/hybrid.ts:57-155`

```
search()
  ├── embedQueryWithTimeout()      [manager-embedding-ops.ts:615-626]
  │     ↓ 生成查询向量
  ├── searchVector()               [manager-search.ts:20-94]
  │     ↓ 余弦相似度
  ├── searchKeyword()              [manager-search.ts:136-191]
  │     ↓ BM25 排名
  └── mergeHybridResults()        [hybrid.ts:57-155]
        ↓ 加权合并 + MMR 重排 + 时间衰减
```

**混合权重公式：**
```
score = vectorWeight × vectorScore + textWeight × textScore
```

### 4.2 MMR 重排序（可选）

**文件：** `src/memory/mmr.ts`

Maximal Marginal Relevance — 在相关性和多样性之间取得平衡，避免返回高度相似的结果。

### 4.3 时间衰减（可选）

**文件：** `src/memory/temporal-decay.ts`

为较新的记忆赋予更高权重，半衰期可配置（默认 30 天）。

### 4.4 关键词扩展（仅 FTS 模式）

**文件：** `src/memory/query-expansion.ts`

从对话式查询中提取关键词，用于无 Embedding 时的降级搜索。

---

## 5. 同步机制

**文件：** `src/memory/manager-sync-ops.ts:645-671`

| 触发方式 | 实现 |
|----------|------|
| **文件监视** | `chokidar` 监听文件变化（防抖） |
| **定时同步** | 可配置的时间间隔（默认关闭） |
| **会话启动** | 新会话初始化时触发 |
| **搜索时触发** | 懒同步，搜索时检测并同步脏数据 |
| **会话增量** | 追踪会话记录增长，超阈值触发重索引 |

---

## 6. Agent 集成

### 6.1 Agent Memory Tools

**文件：** `src/agents/tools/memory-tool.ts:1-271`

向 Agent 暴露两个工具：

```typescript
// memory_search — 语义搜索
{
  query: string,
  maxResults?: number,  // 默认 6
  minScore?: number     // 默认 0.35
}

// memory_get — 读取指定文件片段
{
  path: string,
  from?: number,       // 起始行号
  lines?: number        // 行数
}
```

### 6.2 引用系统（Citations）

**文件：** `src/agents/tools/memory-tool.ts:171-196, 243-271`

| 模式 | 行为 |
|------|------|
| `auto` | 直连对话显示，群聊/频道隐藏 |
| `on` | 始终显示 |
| `off` | 始终隐藏 |

引用格式：`memory/notes.md#L10-L25`

---

## 7. QMD 后端（可选）

**文件：** `src/memory/qmd-manager.ts:1-2070`

### 架构

- 外部 CLI 进程（`qmd`），内置 ML 模型管理
- 每个 Agent 独立 SQLite 索引：`~/.openclaw/agents/<agentId>/qmd/`
- XDG 规范路径（配置/缓存目录）
- 会话导出管线：JSONL transcripts → Markdown → QMD collection

### 核心功能

| 功能 | 说明 |
|------|------|
| Collections | glob 模式匹配的虚拟目录 |
| MCP Bridge | `mcporter` 守护进程查询 |
| 多集合搜索 | 跨 memory + sessions + 自定义路径 |
| 修复逻辑 | 处理空字节元数据、重复约束冲突 |
| Scope 策略 | 可配置会话允许/拒绝规则 |

### 配置结构

**文件：** `src/config/types.memory.ts:1-67`

```typescript
type MemoryQmdConfig = {
  command?: string;           // qmd CLI 路径
  mcporter?: McporterConfig;  // MCP bridge 设置
  searchMode?: "query" | "search" | "vsearch";
  includeDefaultMemory?: boolean;
  paths?: QmdIndexPath[];
  sessions?: QmdSessionConfig;
  update?: QmdUpdateConfig;
  limits?: QmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};
```

---

## 8. 多模态支持

**文件：** `src/memory/multimodal.ts`

| 类型 | 格式 | Embedding 方式 |
|------|------|---------------|
| 图片 | jpg, jpeg, png, webp, gif, heic, heif | Gemini `gemini-embedding-2-preview` |
| 音频 | mp3, wav, ogg, opus, m4a, aac, flac | 同上 |

标签格式：`"Image file: path/to/image.png"`

---

## 9. 完整配置参考

**文件：** `src/config/zod-schema.ts:44-121`

```yaml
memory:
  backend: "builtin" | "qmd"    # 默认: "builtin"
  citations: "auto" | "on" | "off"

agents:
  defaults:
    memorySearch:
      enabled: true
      provider: "auto" | "openai" | "gemini" | "voyage" | "mistral" | "ollama" | "local"
      model: string
      sources: ["memory"] | ["memory", "sessions"]
      extraPaths: string[]
      store:
        path: string              # SQLite DB 路径
        vector:
          enabled: true
          extensionPath: string   # sqlite-vec 扩展路径
      chunking:
        tokens: 400               # 分块 token 数
        overlap: 80               # 重叠 token 数
      sync:
        onSessionStart: true
        onSearch: true
        watch: true
        intervalMinutes: 0
      query:
        maxResults: 6
        minScore: 0.35
        hybrid:
          enabled: true
          vectorWeight: 0.7
          textWeight: 0.3
          candidateMultiplier: 4
          mmr:
            enabled: false
            lambda: 0.7
          temporalDecay:
            enabled: false
            halfLifeDays: 30
      cache:
        enabled: true
        maxEntries: number
      remote:
        baseUrl: string
        apiKey: string
        batch:
          enabled: false
          concurrency: 2
          pollIntervalMs: 2000
      fallback: "none" | "openai" | "gemini" | ...
```

---

## 10. 关键文件索引

| 功能模块 | 文件路径 |
|----------|----------|
| **主索引管理器** | `src/memory/manager.ts` |
| **搜索管理器工厂** | `src/memory/search-manager.ts` |
| **运行时管理器** | `src/memory/manager-runtime.ts` |
| **Embedding 批量操作** | `src/memory/manager-embedding-ops.ts` |
| **同步操作** | `src/memory/manager-sync-ops.ts` |
| **搜索实现** | `src/memory/manager-search.ts` |
| **SQLite 工具** | `src/memory/sqlite.ts` |
| **SQLite-Vec 加载器** | `src/memory/sqlite-vec.ts` |
| **数据库 Schema** | `src/memory/memory-schema.ts` |
| **混合搜索算法** | `src/memory/hybrid.ts` |
| **MMR 重排序** | `src/memory/mmr.ts` |
| **时间衰减** | `src/memory/temporal-decay.ts` |
| **查询扩展** | `src/memory/query-expansion.ts` |
| **Markdown 分块** | `src/memory/internal.ts` |
| **Embedding 统一入口** | `src/memory/embeddings.ts` |
| **各 Provider 实现** | `src/memory/embeddings-{openai,gemini,voyage,mistral,ollama}.ts` |
| **QMD 后端** | `src/memory/qmd-manager.ts` |
| **QMD 进程管理** | `src/memory/qmd-process.ts` |
| **QMD Scope 策略** | `src/memory/qmd-scope.ts` |
| **会话文件管理** | `src/memory/session-files.ts` |
| **多模态支持** | `src/memory/multimodal.ts` |
| **Agent Memory Tools** | `src/agents/tools/memory-tool.ts` |
| **Agent 搜索配置** | `src/agents/memory-search.ts` |
| **CLI 命令** | `src/cli/memory-cli.ts` |
| **配置类型定义** | `src/config/types.memory.ts` |
| **后端配置解析** | `src/memory/backend-config.ts` |
| **插件 API 暴露** | `src/plugins/runtime/types-core.ts:36-40` |
| **Gateway 启动初始化** | `src/gateway/server-startup-memory.ts` |
| **搜索管理器测试** | `src/memory/search-manager.test.ts` |
| **混合搜索测试** | `src/memory/hybrid.test.ts` |
| **QMD 管理器测试** | `src/memory/qmd-manager.test.ts` |
| **会话文件测试** | `src/memory/session-files.test.ts` |

---

## 11. 数据流总览

```
用户/Agent 调用 memory_search
    │
    ▼
memory-tool.ts:79-133
  解析 Agent 上下文（配置 + agentId）
    │
    ▼
SearchManagerFactory
  根据配置选择后端（builtin / qmd）
    │
    ├─── Builtin ──► MemoryIndexManager.search() [manager.ts:259-367]
    │                    ├── embedQueryWithTimeout()
    │                    ├── searchVector() [manager-search.ts:20-94]
    │                    ├── searchKeyword() [manager-search.ts:136-191]
    │                    └── mergeHybridResults() [hybrid.ts:57-155]
    │                          ├── MMR 重排（可选）[mmr.ts]
    │                          └── 时间衰减（可选）[temporal-decay.ts]
    │
    └─── QMD ──► QmdMemoryManager.search() [qmd-manager.ts:723-861]
                      ├── qmd CLI 进程通信
                      └── mcporter MCP bridge
    │
    ▼
Citation 添加（auto/on/off 模式）
    │
    ▼
结果返回（包含 provider、model、citation 信息）
```

---

## 12. 测试覆盖

| 测试文件 | 覆盖内容 |
|----------|----------|
| `src/memory/manager.batch.test.ts` | 批量索引 |
| `src/memory/manager.embedding-batches.test.ts` | Embedding 批量操作 |
| `src/memory/manager.atomic-reindex.test.ts` | 原子性重索引 |
| `src/memory/manager.read-file.test.ts` | 文件读取 |
| `src/memory/manager.readonly-recovery.test.ts` | 只读恢复 |
| `src/memory/manager.sync-errors-do-not-crash.test.ts` | 同步错误处理 |
| `src/memory/manager.vector-dedupe.test.ts` | 向量去重 |
| `src/memory/manager.watcher-config.test.ts` | 文件监视器配置 |
| `src/memory/manager.async-search.test.ts` | 异步搜索 |
| `src/memory/hybrid.test.ts` | 混合搜索 |
| `src/memory/mmr.test.ts` | MMR 重排序 |
| `src/memory/qmd-manager.test.ts` | QMD 后端 |
| `src/memory/qmd-scope.test.ts` | QMD Scope 策略 |
| `src/memory/qmd-query-parser.test.ts` | QMD 查询解析 |
| `src/memory/session-files.test.ts` | 会话文件管理 |
| `src/memory/search-manager.test.ts` | 搜索管理器 |

---

## 13. 与外部系统集成

### 13.1 插件系统

**文件：** `src/plugins/runtime/types-core.ts:36-40`

插件可通过以下方式使用记忆：

```typescript
tools: {
  createMemoryGetTool,
  createMemorySearchTool,
  registerMemoryCli,
}
```

### 13.2 MCP 协议

- QMD 后端通过 `mcporter` 提供 MCP bridge（`src/memory/qmd-manager.ts`）
- 支持守护进程模式（warm daemon queries）

### 13.3 Gateway 启动

**文件：** `src/gateway/server-startup-memory.ts:1-30`

Gateway 启动时初始化 QMD 记忆后端，供 Agent 会话使用。

---

## 14. 设计亮点与权衡

### 亮点
- **双引擎互补**：向量搜索捕获语义相似性，FTS5 捕获关键词精确匹配
- **零依赖默认**：builtin 后端仅依赖 Node.js SQLite，无需安装额外服务
- **可插拔架构**：builtin / QMD 后端通过统一接口切换
- **增量索引**：hash 比对确保仅重新索引变更文件
- **降级策略**：Embedding provider 不可用时自动降级为 FTS-only

### 权衡
- sqlite-vec 扩展需要单独加载，非 Node.js 内置
- QMD 后端依赖外部 CLI 工具，增加了部署复杂度
- 当前分块策略基于 token 估算，非精确 tokenize
- 会话索引默认关闭，需显式配置 `sources: ["memory", "sessions"]`

---

*文档由 Claude Code 自动分析源码生成，如有出入请以源码为准。*
