# Local AI Memory Bus

> 让多个 AI 工具共享一个本地记忆系统，不再重复解释上下文

[![Test CI](https://github.com/passionworkeer/local-ai-memory-bus/actions/workflows/test.yml/badge.svg)](https://github.com/passionworkeer/local-ai-memory-bus/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-orange)](https://python.org)
[![Platforms: Windows | macOS | Linux](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen)]()
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](https://docker.com)

---

## 问题

如果你同时使用多个 AI 编程工具（Claude Code、Codex、Cursor、Copilot 等），每个工具都有自己独立的记忆，互不共享。

**解决方案**：让所有 AI 工具共享同一个本地记忆后端，不再重复解释上下文。

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **共享记忆** | 多个 AI 工具共享同一份持久化记忆 |
| **本地优先** | 数据存储在本地 `.ai-memory` 目录 |
| **混合检索** | BM25 + 语义向量混合搜索，支持中文分词 |
| **MCP 协议** | 支持 Model Context Protocol，多工具兼容 |
| **观察者模式** | 后台 watchdog 自动同步工具记忆 |
| **无依赖 SaaS** | 完全本地运行，无外部服务依赖 |

---

## 支持的 AI 工具

| 工具 | 状态 | 说明 |
|------|------|------|
| Claude Code | ✅ 一级支持 | 完整集成验证 |
| Codex | ✅ 一级支持 | 完整集成验证 |
| OpenCode | ✅ 一级支持 | 完整集成验证 |
| OpenClaw | ✅ 支持 | 通过结构化记忆同步 |
| Cursor | ✅ 支持 | MCP 配置支持 |
| VS Code / Copilot | ✅ 支持 | MCP 配置支持 |
| Trae | ✅ 支持 | AGENTS.md 集成 |

---

## 快速开始

### 4 步完成配置

```bash
# 1. 克隆仓库
git clone <repo-url>
cd local-ai-memory-bus

# 2. 安装依赖（首次）
npm install

# 3. 启动 MCP 服务器（双击 start.bat 或命令行）
node start.js

# 4. 配置 Claude Code（自动检测并写入配置）
node setup-mcp.js
```

重启 Claude Code 即可使用共享记忆系统。

### MCP 端点

| 服务 | URL |
|------|-----|
| Memory | http://127.0.0.1:9338/mcp |
| Fetch | http://127.0.0.1:9332/mcp |
| Time | http://127.0.0.1:9333/mcp |
| Context7 | http://127.0.0.1:9331/mcp |
| Playwright | http://127.0.0.1:9337/mcp |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Clients                              │
│   Claude Code  │  Codex  │  OpenCode  │  Cursor  │  Others  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Shared MCP Layer                          │
│  memory:9338  │  context7/fetch/time  │  playwright:9337     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Local Runtime                             │
│         bus/memory-bus.ps1  │  bus/memory-watchdog.ps1       │
│              BM25 + Dense + Hybrid Retrieval                │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Canonical Store                            │
│                   .ai-memory Store                           │
│     structured/*.jsonl  │  inbox/  │  generated/            │
└─────────────────────────────────────────────────────────────┘
```

---

## 记忆分层

| 层级 | 名称 | 说明 | 持久化 |
|------|------|------|--------|
| L0 | Working | 当前会话工作内存 | 内存 |
| L1 | Session | 短时记忆（7天滚动） | `.ai-memory/session/` |
| L2 | Essential | 关键项目信息 | `.ai-memory/structured/` |
| L3 | Durable | 长期知识库 | `.ai-memory/durable/` |
| L4 | Reference | 参考文档 | `.ai-memory/reference/` |
| L5 | Archive | 归档（不进入向量空间） | `archive-manifest.jsonl` |

---

## 测试覆盖

| 测试类型 | 测试数 | 状态 |
|----------|--------|------|
| JS 单元测试 | 576 | ✅ 通过 (573/576) |
| Python 测试 | 582 | ✅ 全部通过 |
| **总计** | **1158** | **✅ 99.7%** |

> 注：3 个失败的 JS 测试为 MCP 集成测试，需要真实 MCP 服务器环境。

---

## 快速启动（Docker）

```bash
# 构建镜像
docker build -t local-ai-memory-bus .

# 启动（使用默认 ~/.ai-memory 存储）
docker run --rm -v ~/.ai-memory:/root/.ai-memory \
  -p 9338:9338 -p 9090:9090 \
  local-ai-memory-bus

# 或使用 docker-compose
docker-compose up -d
```

---

## 项目结构

```
local-ai-memory-bus/
├── bus/                    # 核心运行时
│   ├── memory-bus.ps1       # 主内存总线
│   ├── memory-watchdog.ps1  # 后台观察者
│   ├── lsh-hash.js          # 本地敏感哈希
│   └── bm25.js             # BM25 搜索引擎
├── shared-mcp/             # MCP 服务器
│   ├── omni-memory-server.js  # 主服务器
│   ├── memory-retrieval.js     # 记忆检索
│   ├── memory-status.js        # 状态监控
│   └── manifest.json           # MCP 清单
├── ops/                    # 运维脚本
│   ├── build-memory-layers.js  # 构建记忆分层
│   ├── build-handoff-pack.js   # 生成交接包
│   └── inbox/                   # 收件箱操作
├── retrieval/              # 检索模块
│   ├── semantic_search.py  # 语义搜索（Python）
│   ├── search_cache.py     # 搜索缓存
│   └── embedding_providers.py  # 向量提供者
├── tests/                  # 测试套件
│   ├── unit/              # 单元测试
│   ├── integration/       # 集成测试
│   └── e2e/               # 端到端测试
├── scripts/                # 安装脚本
│   ├── install.ps1        # Windows 安装
│   └── install.sh         # Unix 安装
└── docs/                   # 文档
```

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_MEMORY_ROOT` | repo root / runtime root | 运行时根目录；旧入口仍可能把它当作存储回退 |
| `AI_MEMORY_STORE` | `~/.ai-memory` | 共享记忆存储根目录，优先使用 |
| `AI_MEMORY_STORE_ROOT` | `~/.ai-memory` | `AI_MEMORY_STORE` 的旧别名 |
| `AI_MEMORY_PYTHON` | auto | Python 运行时路径 |
| `AI_MEMORY_EMBED_BACKEND` | `hash` | 向量嵌入后端（hash=本地，openai=API） |
| `AI_MEMORY_EMBED_BASE_URL` | — | OpenAI 兼容 API 地址 |
| `AI_MEMORY_EMBED_API_KEY` | — | API 密钥 |
| `AI_MEMORY_EMBED_MODEL` | — | 嵌入模型名 |

### 向量嵌入选项

- **本地（默认）**: `hash` - 离线 LSH 哈希，无需 API
- **HuggingFace**: `transformer` - 使用 Sentence Transformers
- **OpenAI 兼容**: `openai-compatible` - 支持任何 OpenAI 格式 API
- **Gemini**: `gemini` - Google Gemini 嵌入

---

## 文档

| 文档 | 说明 |
|------|------|
| [快速开始](docs/platform/SETUP_OVERVIEW.md) | 各平台安装指南 |
| [架构设计](docs/ARCHITECTURE.md) | 系统架构详解 |
| [记忆分层](docs/MEMORY-TIERING.md) | 5 层记忆模型 |
| [MCP 工具](docs/guides/API_REFERENCE.md) | 工具 API 参考 |
| [开发指南](docs/guides/DEVELOPMENT.md) | 开发与测试指南 |
| [故障排除](docs/TROUBLESHOOTING.md) | 常见问题解答 |

---

## 安全

- ❌ 不在代码中存储任何 token 或 API key
- ✅ 所有密钥通过环境变量注入
- ✅ 本地优先，无外部数据传输
- ⚠️ 分叉前请扫描敏感信息泄露

---

## 许可证

[MIT License](LICENSE) - 可自由使用、修改和分发

---

## 贡献

欢迎提交 Issue 和 Pull Request！请查看 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

<p align="center">
  <strong>让 AI 工具共享记忆，告别重复解释</strong>
</p>
