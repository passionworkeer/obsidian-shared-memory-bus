# yt · 让多个 AI 工具共享同一个本地记忆

> 一句话：**Claude Code、Codex、Cursor、Copilot 等所有 AI 工具共用同一份本地记忆，不再重复解释上下文。**

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/promotion/QUICKSTART.zh-CN.md">中文快速开始</a> ·
  <a href="docs/promotion/QUICKSTART.en.md">English Quick Start</a> ·
  <a href="docs/promotion/POST.zh-CN.md">推广长文</a> ·
  <a href="docs/promotion/VIDEO-STORYBOARD.zh-CN.md">视频分镜</a>
</p>

<p align="center">
  <a href="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml"><img src="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml/badge.svg" alt="Test CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen" alt="Node 18+"></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/Python-3.10+-orange" alt="Python 3.10+"></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen" alt="Platforms">
  <img src="https://img.shields.io/badge/Docker-ready-blue" alt="Docker">
  <img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP">
  <img src="https://img.shields.io/badge/local--first-%E2%9C%93-success" alt="Local-first">
  <img src="https://img.shields.io/badge/no--SaaS-%E2%9C%93-success" alt="No SaaS">
  <img src="https://img.shields.io/github/stars/passionworkeer/obsidian-shared-memory-bus?style=social" alt="Stars">
</p>

---

## 它解决了什么问题

| 痛点 | 现象 | 后果 |
|------|------|------|
| **每个 AI 工具一个记忆** | Claude Code、Codex、Cursor 各自存自己的 notes/context | 切换工具 = 重新解释一遍项目 |
| **云端 SaaS 锁定** | 不少记忆方案要上传到厂商服务器 | 隐私顾虑 + 离线不可用 |
| **MCP 配置碎片化** | 每个工具的 mcp.json 格式不一样 | 安装一次要改 5 个地方 |
| **检索中文差** | 主流 embedding 对中文支持参差 | 中文项目检索召回率低 |

**yt 一次解决四件事**：

1. **共享同一份**本地持久化记忆（JSONL + 向量索引）
2. **本地优先**，数据存在 `~/.ai-memory`，不上云
3. **统一 MCP 端点**，所有工具连同一个 server
4. **混合检索**（BM25 + 语义向量 + 中文分词），英文/中文都友好

---

## 什么时候用它

> **场景化示例**：下面三段都是真实用户场景，不是 PPT。

### 场景 A · 你同时跑 Claude Code 和 Codex

早上用 Claude Code 改了一版 API contract，下午切到 Codex 继续写 OpenAPI schema —— **不用再贴一遍上下文**，Codex 直接看到 Claude 早上写的设计决策。

### 场景 B · 你在 Obsidian 里维护项目文档

把 `~/.ai-memory/derived/`（自动导出的 Markdown）放进 Obsidian vault，**在 Obsidian 里编辑就是改 memory**。Graph view 自动展示记忆之间的关系。

### 场景 C · 你想给"项目"做长期知识库

5 层记忆模型（L0 Working → L5 Archive）让临时笔记、关键事实、长期知识各归其位，**不会因为一个闲聊污染你的项目知识库**。

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **共享记忆** | 多个 AI 工具共享同一份持久化记忆 |
| **本地优先** | 数据存储在本地 `~/.ai-memory` 目录 |
| **混合检索** | BM25 + 语义向量混合搜索，支持中文分词 |
| **MCP 协议** | 支持 Model Context Protocol，多工具兼容 |
| **观察者模式** | 后台 watchdog 自动同步工具记忆（cascade 队列增量更新） |
| **多语言** | Node.js + Python 协同，跨语言 hash 等价性测试 |
| **ANN 加速** | 可选 hnswlib 后端，10k+ 条向量查询 P99 < 10ms |
| **导出 Markdown** | JSONL 事件流 → 可读 .md，Obsidian 直接消费 |
| **无 SaaS 依赖** | 完全本地运行，离线可用 |

---

## 架构（一张图看懂）

```
┌────────────────────────────────────────────────────────────────┐
│                       AI 客户端                                │
│  Claude Code │ Codex │ Cursor │ Copilot │ OpenCode │ Trae    │
└─────────────────────────┬──────────────────────────────────────┘
                          │ MCP (stdio / HTTP)
                          ▼
┌────────────────────────────────────────────────────────────────┐
│                     Shared MCP 层                             │
│  memory:9338  context7:9331  fetch:9332  time:9333  pw:9337  │
└─────────────────────────┬──────────────────────────────────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
   ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
   │ bus/         │ │ ops/     │ │ retrieval/        │
   │ 记忆总线     │ │ 运维导出 │ │ 检索 + ANN       │
   │ (Node/PowerShell) │ │(Markdown 派生) │ │(Python)        │
   └──────┬───────┘ └────┬─────┘ └────────┬─────────┘
          │              │                │
          ▼              ▼                ▼
   ┌─────────────────────────────────────────────┐
   │         真相层 ~/.ai-memory                  │
   │  structured/*.jsonl  │  derived/*.md        │
   │  embeddings/         │  cascade.sqlite3     │
   └─────────────────────────────────────────────┘
```

**数据流**：
1. 任意 AI 工具 → MCP `memory/*` 工具 → 写入 `structured/<source>.jsonl`（append-only）
2. Cascade 队列（`cascade.sqlite3`）记录每个变更的 LSN + content_sha256
3. Worker 拉队列 → 增量更新 embeddings / ANN 索引
4. `ops/export/export-md.js` 把 JSONL 派生为 `derived/*.md` 给 Obsidian

---

## 快速开始（4 步）

```bash
# 1. 克隆
git clone https://github.com/passionworkeer/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus

# 2. 安装依赖
npm install

# 3. 启动 MCP 服务器（Windows 双击 start.bat，Unix/Mac ./start.sh）
node start.js

# 4. 配置 Claude Code（自动写入 .claude/mcp_servers.json）
node setup-mcp.js
```

**重启 Claude Code / Codex / Cursor**，MCP 工具列表里就会多出 `memory_search` / `search_shared_memory` / `memory_write` 等。

完整中文引导：[docs/promotion/QUICKSTART.zh-CN.md](docs/promotion/QUICKSTART.zh-CN.md)

---

## 推广 / Onboarding 入口

如果你想给别人介绍这个项目：

| 入口 | 受众 | 时长 |
|------|------|------|
| [Universal SKILL.md](SKILL.md) | 所有 AI 工具加入共享记忆的统一协议 | 1 分钟 |
| [Agent Boot](.agents/skills/AGENT_BOOT.md) | 任何 AI host 的启动指令（可粘贴） | 2 分钟 |
| [中文快速开始](docs/promotion/QUICKSTART.zh-CN.md) | 中文新用户 | 5 分钟 |
| [English Quick Start](docs/promotion/QUICKSTART.en.md) | English onboarding | 5 minutes |
| [推广长文](docs/promotion/POST.zh-CN.md) | 技术论坛 / 公众号 | 10 分钟读 |
| [视频分镜](docs/promotion/VIDEO-STORYBOARD.zh-CN.md) | 60 秒短视频脚本 | 1 分钟看 |

---

## 工具支持

| 工具 | 等级 | 集成方式 |
|------|------|---------|
| Claude Code | ✅ 一级 | MCP + 自动 setup-mcp.js |
| Codex | ✅ 一级 | MCP + agent skill |
| OpenCode | ✅ 一级 | MCP + AGENTS.md |
| Cursor | ✅ 支持 | MCP 配置 |
| VS Code / Copilot | ✅ 支持 | MCP + AGENTS.md |
| OpenClaw | ✅ 支持 | 结构化记忆同步 |
| Trae | ✅ 支持 | AGENTS.md 集成 |

---

## 记忆分层

| 层级 | 名称 | 用途 | 持久化 |
|------|------|------|--------|
| L0 | Working | 当前会话工作内存 | 内存 |
| L1 | Session | 短时记忆（7 天滚动） | `.ai-memory/session/` |
| L2 | Essential | 关键项目信息 | `.ai-memory/structured/` |
| L3 | Durable | 长期知识库 | `.ai-memory/durable/` |
| L4 | Reference | 参考文档 | `.ai-memory/reference/` |
| L5 | Archive | 归档（不进入向量空间） | `archive-manifest.jsonl` |

详见 [docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md)。

---

## MCP 端点

> 端口单一来源: `shared-mcp/port-registry.js` (`CRITICAL_PORTS`); 下表为人读摘要

| 服务 | URL | 用途 |
|------|-----|------|
| Memory | http://127.0.0.1:9338/mcp | 记忆读写、检索 |
| Context7 | http://127.0.0.1:9331/mcp | 库文档查询 |
| Fetch | http://127.0.0.1:9332/mcp | HTTP 抓取 |
| Time | http://127.0.0.1:9333/mcp | 时间工具 |
| Playwright | http://127.0.0.1:9337/mcp | 浏览器自动化 |

> 9334/9335 为 `port-registry.js` CRITICAL_PORTS 中的预留 integration 端口 (供未来 4-server 拆分 `omni-memory-retrieval/bridge/dream/mgmt` 9338-9341 外的扩展使用)

---

## 性能（10k 条 384 维向量内测）

| 指标 | 全量扫描 | ANN (hnswlib) | Cascade 增量 |
|------|---------|---------------|---------------|
| Dense 评分 P99 | ~180 ms | **~6 ms** | **~10 ms / 单条** |
| 内存峰值 | ~150 MB | ~70 MB | 不重建 |
| 崩溃恢复 | — | — | 从 LSN 续传 |

详见 [docs/architecture/SERVER-SPLIT.md](docs/architecture/SERVER-SPLIT.md) 和 [docs/guides/LOGGING.md](docs/guides/LOGGING.md)。

---

## 项目结构

```
obsidian-shared-memory-bus/
├── bus/                    # 核心运行时（Node + PowerShell）
│   ├── lsh-hash.js          # 跨语言 LSH 哈希（FNV-1a + 大小写不敏感 + 中文 bigram/trigram）
│   ├── bm25.js              # BM25 搜索引擎
│   ├── memory-bus*.ps1      # PowerShell 记忆总线
│   └── memory-watchdog*.ps1 # 后台观察者
├── shared-mcp/             # MCP 服务器
│   ├── omni-memory-server.js  # 主服务器（thin entrypoint ~278 行）
│   ├── memory-*.js            # 5 个 memory-* 工厂模块
│   ├── tool-registry.js       # 29 个工具按职责切片 (RETRIEVAL/BRIDGE/DREAM/MGMT)
│   └── manifest.json          # MCP 清单
├── ops/                    # 运维 + 派生
│   ├── build/                 # 分层/交接包/bootstrap
│   ├── cascade/               # ★ Cascade 增量队列 (EverOS 借鉴)
│   ├── export/                # ★ JSONL → Markdown 真相派生层 (EverOS 借鉴)
│   └── adapters/              # schema-registry 多语生成
├── retrieval/              # 检索模块（Python）
│   ├── search_index.py        # 关键词检索
│   ├── ann_index.py           # ★ ANN 索引（hnswlib + numpy fallback）
│   ├── search_ranking.py      # dense + hybrid scoring
│   └── lsh_utils.py           # Py 端 LSH（与 JS 端等价）
├── tests/                  # 测试套件
│   ├── unit/{js,py}/          # 单元测试
│   ├── integration/           # 跨模块集成测试
│   ├── cross-language/        # JS ↔ Py 等价性
│   └── e2e/                   # 端到端
├── scripts/                # 安装 + 运维脚本
└── docs/                   # 文档
    ├── architecture/          # 设计文档 (SERVER-SPLIT, DATA-FLOW...)
    ├── guides/                # 用户指南 (LOGGING, API_REFERENCE...)
    └── promotion/             # 推广素材 (QUICKSTART, POST, VIDEO-STORYBOARD)
```

---

## 测试覆盖

| 类型 | 数量 | 状态 |
|------|------|------|
| JS 单元测试 | 600+ | ✅ 通过 |
| Python 测试 | 700+ | ✅ 全部通过 |
| 跨语言等价 | 59 | ✅ JS ↔ Py LSH 完全一致 |
| 集成 + E2E | 50+ | ✅ |
| **总计** | **1400+** | **✅ 99%+** |

> 跑测试：`npm test`（JS）+ `npm run test:py`（Python）+ `npm run test:cross`（跨语言）

---

## 配置

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AI_MEMORY_STORE` | `~/.ai-memory` | 共享记忆存储根（优先） |
| `AI_MEMORY_STORE_ROOT` | `~/.ai-memory` | 旧别名 |
| `AI_MEMORY_PYTHON` | auto | Python 运行时路径 |
| `AI_MEMORY_EMBED_BACKEND` | `hash` | `hash` / `transformer` / `openai-compatible` / `gemini` |
| `AI_MEMORY_EMBED_BASE_URL` | — | OpenAI 兼容 API 地址 |
| `AI_MEMORY_EMBED_API_KEY` | — | API 密钥（仅 env 注入，不入代码） |
| `AI_MEMORY_EMBED_MODEL` | — | 嵌入模型名 |

### 嵌入后端选项

- **本地（默认）**：`hash` — 离线 LSH 哈希，零 API 成本
- **HuggingFace**：`transformer` — Sentence Transformers
- **OpenAI 兼容**：`openai-compatible` — 任何 OpenAI 格式 API
- **Gemini**：`gemini` — Google Gemini 嵌入

---

## 安全

- ❌ 代码里**绝不**存 token / API key
- ✅ 所有密钥通过环境变量注入
- ✅ 本地优先，无外部数据传输
- ⚠️ 分叉前请扫描敏感信息泄露

---

## 文档

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构详解 |
| [docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md) | 5 层记忆模型 |
| [docs/architecture/SERVER-SPLIT.md](docs/architecture/SERVER-SPLIT.md) | MCP server 拆分 |
| [docs/architecture/DATA-FLOW.md](docs/architecture/DATA-FLOW.md) | 数据流图 |
| [docs/guides/LOGGING.md](docs/guides/LOGGING.md) | 中央日志规范 |
| [docs/guides/API_REFERENCE.md](docs/guides/API_REFERENCE.md) | MCP 工具 API |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 常见问题 |

---

## 许可证

[MIT](LICENSE) — 可自由使用、修改和分发。

---

## 贡献

欢迎 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

<p align="center"><strong>让 AI 工具共享记忆，告别重复解释。</strong></p>
<p align="center">
  <sub>本地优先 · 跨工具 · 中英双语 · 跨语言等价 · 增量更新</sub>
</p>