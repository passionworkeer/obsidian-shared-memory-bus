# claude-mem 架构解析

> 来源：https://github.com/thedotmack/claude-mem
> 分析日期：2026-04-11

---

## 一、核心定位

claude-mem 是一个**持久化记忆压缩系统**，服务于 Claude Code（CLI 工具）。它的核心价值在于：

- 自动捕获每次会话的 tool-use 行为
- 用 AI 将观察结果压缩为结构化记忆
- 新会话启动时自动注入相关历史上下文
- 47.6k GitHub stars，TypeScript 实现

---

## 二、整体架构：两进程分离

```
┌─────────────────────────────────────────┐          ┌─────────────────────────────────────────┐
│         Claude Code (IDE 扩展进程)       │          │        Worker Service (Bun 进程)         │
│                                         │  HTTP    │                                         │
│  SessionStart ──────────────────────────┼────────► │  Express.js HTTP Server (port 37777)      │
│  UserPromptSubmit ──────────────────────┼──POST──► │    ├─ SQLite + FTS5 (持久存储)             │
│  PostToolUse (100+ 次/会话) ────────────┼─fire&forget► │    ├─ ChromaDB (向量语义检索, 可选)      │
│  Stop ────────────────────────────────┼────────► │    └─ Claude Agent SDK (AI 压缩)            │
│  SessionEnd ──────────────────────────┼────────► │                                         │
│                                         │          │  MCP Server (协议转换层, 4 个工具)        │
└─────────────────────────────────────────┘          └─────────────────────────────────────────┘
```

**关键约束**：所有 Hook → Worker 的 HTTP 调用都是**异步 fire-and-forget**，2 秒超时。Claude Code 主进程永远不被阻塞。

---

## 三、5 个 Hook 生命周期

| Hook | 触发时机 | 职责 | 阻塞？ |
|------|----------|------|--------|
| `SessionStart` | Claude Code 启动 | 查 DB 历史，打印到额外上下文 | 否 |
| `UserPromptSubmit` | 用户提交 prompt | 创建/获取 session，存用户原始 prompt | 否 |
| `PostToolUse` | 每次工具调用后 | 捕获观察结果，推入异步队列 | 否 |
| `Stop` | 用户按 Ctrl+C 或 `stop` | 调 SDK Agent 生成会话总结 | **是** |
| `SessionEnd` | 会话关闭 | 标记 session 为 completed | 否 |

### Hook 配置文件（`plugin/hooks/hooks.json`）

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [
        { "type": "command", "command": "bun worker-service.cjs start", "timeout": 60 },
        { "type": "command", "command": "bun context-hook.js", "timeout": 60 }
      ]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node new-hook.js", "timeout": 120 }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node save-hook.js", "timeout": 120 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "node summary-hook.js", "timeout": 120 }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "node cleanup-hook.js", "timeout": 120 }]
    }]
  }
}
```

---

## 四、数据存储层

### SQLite 数据库（`~/.claude-mem/claude-mem.db`）

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `sdk_sessions` | 会话跟踪 | contentSessionId, memorySessionId, prompt_counter, status |
| `observations` | 单次工具调用记录 | title, subtitle, narrative, facts, concepts, files_read, files_modified, type |
| `session_summaries` | AI 生成的会话总结 | request, investigated, learned, completed, next_steps, notes |
| `user_prompts` | 用户原始 prompt | text (FTS5 索引) |

**observations 的 type 枚举**：`decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

### FTS5 全文检索

三个 FTS5 虚拟表（FTS4 兼容语法）：

- `observations_fts`
- `session_summaries_fts`
- `user_prompts_fts`

通过 SQL `AFTER INSERT/UPDATE/DELETE` 触发器保持同步。

### ChromaDB（可选）

用于语义向量检索。当启用时，观察结果会同步生成 embedding 存入 ChromaDB。

---

## 五、MCP 协议：渐进式 Disclosure

claude-mem 提供 4 个 MCP 工具，采用**三层递进**模式，核心目标是**省 Token**：

```
传统 RAG:  一次性取 20 条 → 10,000-20,000 tokens，~10% 相关
三层模式:  search → timeline → get_observations → 2,500-5,000 tokens，100% 相关
```

### 工具 1：`search` — 索引层

```
GET /api/search?query=<query>&limit=20

返回：compact table（id, title, date, type），每条约 50-100 tokens
```

### 工具 2：`timeline` — 上下文层

```
GET /api/timeline?anchor=<id>&depth_before=3&depth_after=3

返回：目标条目附近的时间上下文（前后各 3 条）
```

### 工具 3：`get_observations` — 详情层

```
POST /api/observations/batch
Body: { ids: [id1, id2, id3] }

返回：完整 observation 数据，每条约 500-1000 tokens
```

### 工具 4：`__IMPORTANT` — 工作流说明

元工具，始终可见，向用户解释三层模式的使用方法。

### MCP Server 实现

位于 `plugin/scripts/mcp-server.cjs`，是**薄协议转换层**（无业务逻辑）：

```typescript
{
  name: 'search',
  handler: async (args) => {
    const url = `http://localhost:37777/api/search?${searchParams}`;
    const response = await fetch(url);
    return await response.json();
  }
}
```

---

## 六、Claude Agent SDK（AI 压缩层）

### SDK 版本

使用 V2 简化接口：

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession
} from '@anthropic-ai/claude-agent-sdk'

await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6-20250929'
})
```

### 两个 SessionId 的设计

claude-mem 维护**两套 session ID**：

| ID | 来源 | 用途 |
|----|------|------|
| `contentSessionId` | Claude Code 原始会话 ID | Hook 层面使用 |
| `memorySessionId` | SDK Agent 内部生成的 resume ID | SDK resume 功能必需 |

初始化流程：
1. Hook 创建 session 时，`memorySessionId = NULL`
2. SDK Agent 启动后，调用 `ensureMemorySessionIdRegistered()` 捕获真实 ID
3. 后续 observation 全部用真实 `memorySessionId` 存储

### 处理流水线

```
观察队列(内存)
  ↓
SDK Agent.send(压缩 prompt) → Claude API
  ↓
XML 响应解析 (src/sdk/parser.ts)
  ↓
SQLite 写入 + ChromaDB 同步
```

压缩 prompt 模板位于 `src/sdk/prompts.ts`，输出结构化 XML。

---

## 七、Worker Service API（22 个端点）

### 会话管理

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/sessions/:id/init` | 初始化 session |
| POST | `/sessions/:id/observations` | 添加观察 |
| POST | `/sessions/:id/summarize` | 生成总结 |
| GET | `/sessions/:id/status` | 查询状态 |
| DELETE | `/sessions/:id` | 删除 session |

### 数据查询

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/search` | FTS5 全文搜索 |
| GET | `/api/observations` | 分页观察 |
| GET | `/api/summaries` | 分页总结 |
| GET | `/api/prompts` | 分页 prompt |
| GET | `/api/stats` | 数据库统计 |
| POST | `/api/observations/batch` | 批量获取详情 |
| GET | `/api/projects` | 项目列表 |

### 实时 & 其他

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/stream` | SSE 实时推送 |
| GET | `/` | React 查看器 UI |

---

## 八、隐私控制

`<private>` 标签在 **Hook 层**就剥离：

```html
<private>
API keys, passwords, 敏感个人信息
</private>
```

剥离逻辑位于 `src/utils/tag-stripping.ts`，数据在到达 Worker/Database 之前就已经干净。

---

## 九、与本项目的架构对比

| 维度 | claude-mem | obsidian-shared-memory-bus |
|------|-------------|---------------------------|
| 持久化 | SQLite + ChromaDB | 本地 `.ai-memory` store (纯文件) |
| 协议层 | HTTP (Worker) + MCP | 直接 MCP 暴露 |
| AI 压缩 | Claude Agent SDK 内置 | 依赖外部 LLM |
| 会话跟踪 | SQLite session 表 | 无 session 概念 |
| 进程模型 | 独立 Worker 进程 | 内嵌 MCP Server |
| 渐进 Disclosure | MCP 三层工具 | search → get 多步工具 |
| 隐私处理 | Hook 层 tag stripping | 无（依赖 vault 隔离） |
| Obsidian 依赖 | 无 | 无（纯本地文件系统） |

**核心差异**：claude-mem 有独立的压缩 Worker + SDK；本项目将记忆直接落盘 `.ai-memory` store，更轻量但缺乏 AI 压缩层。

---

## 十、关键文件索引

```
claude-mem/
├── plugin/hooks/hooks.json          # 5 个 hook 的配置
├── src/hooks/
│   ├── context-hook.ts             # SessionStart: 上下文注入
│   ├── new-hook.ts                 # UserPromptSubmit: session 创建
│   ├── save-hook.ts                # PostToolUse: 观察捕获
│   ├── summary-hook.ts             # Stop: 总结生成
│   └── cleanup-hook.ts              # SessionEnd: 状态完成
├── src/services/
│   ├── worker-service.ts            # Express HTTP + SSE 服务端
│   └── sqlite/
│       ├── SessionStore.ts          # CRUD 操作
│       └── SessionSearch.ts         # FTS5 检索
├── src/sdk/
│   ├── worker.ts                    # SDK Agent 主循环
│   ├── prompts.ts                  # XML prompt 模板
│   └── parser.ts                   # XML 响应解析
└── plugin/scripts/mcp-server.cjs    # MCP 协议转换
```
