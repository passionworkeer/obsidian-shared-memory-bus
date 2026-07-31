# yt · 多个 AI 工具共享同一份本地记忆

> `yt-memory-bus` 是一个 local-first 的共享记忆运行时。多个支持 MCP 的客户端可以连接到同一组本地 HTTP 端点，共享结构化记忆、检索索引和派生的 Markdown 文档。

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/promotion/QUICKSTART.zh-CN.md">中文快速开始</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a>
</p>

<p align="center">
  <a href="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml"><img src="https://github.com/passionworkeer/obsidian-shared-memory-bus/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen" alt="Node 22+">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-brightgreen" alt="Platforms">
</p>

## 项目解决什么问题

当 Claude Desktop、Cursor、Codex、Claude Code 或其他 AI 客户端分别保存上下文时，切换工具通常意味着重复解释项目背景。yt 提供一份本地持久化存储，并通过 MCP 暴露检索、写入和管理能力。

核心能力包括：

- 多个 MCP 客户端共享同一份结构化记忆。
- JSONL 事件数据、检索索引和 Markdown 派生文件保存在本地。
- 默认支持 BM25、本地 hash embedding，并可选接入其他 embedding 后端。
- 默认使用拆分式 memory 服务，也保留 legacy monolithic 兼容模式。
- Obsidian 是可选的查看和维护界面，不是运行项目的必需条件。

## 当前稳定边界

`npm start` 启动项目当前维护的核心服务：

| 服务 | 默认端口 | 说明 |
|---|---:|---|
| `fetch` | 9332 | HTTP 抓取，需要对应 Python MCP 包 |
| `time` | 9333 | 时间工具，需要对应 Python MCP 包 |
| `memory-retrieval` | 9338 | 检索与状态查询 |
| `memory-bridge` | 9339 | 跨工具记忆桥接 |
| `memory-dream` | 9340 | 异步重建与 dream 任务 |
| `memory-mgmt` | 9341 | 索引、embedding 和知识图谱管理 |

设置 `AI_MEMORY_SERVER_MODE=monolithic` 后，四个 memory 服务会替换为单个 `memory:9338`。设置 `AI_MEMORY_BASE_PORT` 可整体平移端口，例如 base port 为 `10000` 时，fetch 使用 `10002`。

`shared-mcp/manifest.json` 还记录了一些可选或实验性 MCP，但它们不会由 `npm start` 自动启动。Docker 文件目前也属于实验性部署入口，不建议作为首次安装方式。

## 环境要求

- Node.js 22 或更高版本（运行时使用 `node:sqlite`）。
- Python 3.10 或更高版本，用于 Python 检索组件以及 fetch/time 服务。
- PowerShell 7，用于部分安装和运维脚本。
- Obsidian 可选。

## 快速开始

```bash
git clone https://github.com/passionworkeer/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus
npm install
npm start
```

另开一个终端检查环境：

```bash
node bin.js doctor
```

为已经支持自动写入的客户端生成配置：

```bash
# 查看全部目标
node setup-mcp.js --help

# 示例：配置 Cursor
node setup-mcp.js --target=cursor

# 只预览，不写文件
node setup-mcp.js --target=cursor --dry-run
```

当前自动配置目标包括 Claude Desktop、Cursor、Kiro、Windsurf、Cline、Roo Code 和 Goose。Qoder 的磁盘配置路径未经官方确认，默认只输出人工配置提示。Claude Code、Codex、Copilot、OpenCode 和其他 MCP 客户端可以手动填写上方 HTTP 端点，或使用仓库中的 Agent Skill/模板；`setup-mcp.js` 不会自动修改它们。

## 存储位置

存储根目录按运行时 resolver 决定：

1. 显式设置的 `AI_MEMORY_STORE`，或兼容别名 `AI_MEMORY_STORE_ROOT`。
2. 检测到 Obsidian vault 时，使用 vault 下的 `00-System/ai-memory`。
3. 安装或源码运行时配置的 `AI_MEMORY_ROOT`。
4. 最后回退到用户目录下的 `.ai-memory`。

执行 `node bin.js doctor` 可以查看当前解析结果。备份前不要只根据 README 猜测路径，应先确认实际 store root。

## 记忆分层

持久化记录采用五层模型：

| Tier | 名称 | 主要用途 |
|---:|---|---|
| 1 | Event / Working | 当前会话实时工作缓冲 |
| 2 | Session Durable | 已确认的会话级经验 |
| 3 | Project Durable | 跨会话验证的项目事实 |
| 4 | Shared Durable | 跨项目事实、用户偏好和参考资料 |
| 5 | Archive | 不参与向量检索的归档记录 |

详细 TTL、promotion 和 embedding 规则见 [docs/MEMORY-TIERING.md](docs/MEMORY-TIERING.md)。会话中的临时上下文可以称为 working context，但不再额外编号成 L0-L5 六层体系。

## 配置

常用环境变量：

| 变量 | 说明 |
|---|---|
| `AI_MEMORY_STORE` | 显式指定共享存储根目录 |
| `AI_MEMORY_OBSIDIAN_VAULT` | 指定 Obsidian vault |
| `AI_MEMORY_SERVER_MODE` | `split`（默认）或 `monolithic` |
| `AI_MEMORY_BASE_PORT` | 核心 MCP 服务的 base port，默认 9330 |
| `AI_MEMORY_PYTHON` | Python 可执行文件路径 |
| `AI_MEMORY_EMBED_BACKEND` | `hash`、`transformer`、`openai-compatible` 或 `gemini` |
| `AI_MEMORY_EMBED_BASE_URL` | OpenAI-compatible 服务地址 |
| `AI_MEMORY_EMBED_API_KEY` | embedding API key，建议只通过环境变量提供 |
| `AI_MEMORY_EMBED_MODEL` | embedding 模型名称 |

完整示例见 [.env.example](.env.example)。

## 测试

仓库不在 README 中维护容易过期的“测试总数”或“通过率”数字，以 GitHub Actions 的实际结果为准。

```bash
npm run lint
npm test
npm run test:concurrent
npm run test:integration
npm run test:cross
npm run test:py
npm run test:e2e
```

`npm run test:all` 会运行更完整的组合，但其中部分测试需要 Python、PowerShell 或本地运行环境。

## 安全与隐私

默认 hash embedding 和本地检索不会把记忆发送到外部服务。配置 `openai-compatible`、Gemini 或其他远程后端后，相关文本可能会发送给所配置的服务商，因此不能笼统理解为“任何配置下都不出本机”。

不要把 API key 写入仓库或共享配置文件，优先使用环境变量。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
bus/          核心记忆总线与平台抽象
shared-mcp/   MCP server、端口与进程相关逻辑
retrieval/    Python 检索和 ANN 组件
ops/          导出、迁移、检查和运维工具
cli/          命令行入口
tests/        unit、integration、cross-language、e2e
docs/         架构、规范和使用指南
```

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [记忆分层](docs/MEMORY-TIERING.md)
- [Server 拆分](docs/architecture/SERVER-SPLIT.md)
- [数据流](docs/architecture/DATA-FLOW.md)
- [API Reference](docs/guides/API_REFERENCE.md)
- [Troubleshooting](docs/guides/TROUBLESHOOTING.md)
- [贡献指南](CONTRIBUTING.md)

## 许可证

[MIT](LICENSE)
