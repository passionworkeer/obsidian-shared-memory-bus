# 多 Agent 接入指南

local-ai-memory-bus 通过 **MCP 协议**接入 AI 编程工具。MCP 已是 2026 年事实标准（SDK 月下载 97M），本项目支持 **8 个主流 Agent 零适配接入**——只需一条命令写入各 Agent 的 MCP 配置。

---

## 快速接入

```bash
# 1. 启动 memory server（后台常驻，提供 MCP 端点）
node start.js

# 2. 接入全部已安装的 Agent（自动检测，幂等写入）
node setup-mcp.js --target=all

# 或指定单个 / 多个 Agent
node setup-mcp.js --target=cursor
node setup-mcp.js --target=cursor,kiro
```

重启对应 Agent 即生效。`setup-mcp.js` 是幂等的——重复运行不会产生重复配置。

### 常用选项

| 选项 | 说明 |
|------|------|
| `--target=<agent\|all\|a,b>` | 接入目标，默认 `all` |
| `--dry-run` | 只显示会写入什么，不实际修改配置 |
| `--help` | 列出所有支持的 target |

找不到某 Agent 的配置文件时，脚本会打印该 Agent 的**手动配置指引**（路径 + JSON 片段），不会报错退出。

---

## 支持的 Agent

| Agent | target | 配置路径 | 格式 | 状态 |
|-------|--------|---------|------|------|
| Claude Desktop | `claude` | `~/AppData/Roaming/Claude/claude_desktop_config.json`（Win）| `mcpServers.{id}:{url}` | ✅ |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `mcpServers.{id}:{url}` | ✅ |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json` | `mcpServers.{id}:{url}` | ✅ |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.{id}:{url}` | ✅ |
| Cline | `cline` | VS Code globalStorage `saoudrizwan.claude-dev/.../cline_mcp_settings.json` | `mcpServers.{id}:{url}` | ✅ |
| Roo Code | `roo` | VS Code globalStorage `rooveterinaryinc.roo-cline/.../mcp_settings.json` | `mcpServers.{id}:{url}` | ✅ |
| Goose | `goose` | `~/.config/goose/config.yaml`（extensions 块，标记隔离）| YAML | ✅ |
| Qoder | `qoder` | `~/.qoder/mcp.json` | json-mcpServers | ⚠️ unverified（官方推荐 UI 配置，路径待确认）|

macOS 路径：Claude = `~/Library/Application Support/Claude/claude_desktop_config.json`；其余 `~/.config/...` 或 `~/Library/Application Support/...`。

---

## MCP 端点

接入后，各 Agent 通过这些 HTTP 端点访问共享记忆：

| 服务 | URL | 用途 |
|------|-----|------|
| memory | `http://127.0.0.1:9338/mcp` | 共享记忆检索/写入（核心）|
| fetch | `http://127.0.0.1:9332/mcp` | 网页抓取 |
| time | `http://127.0.0.1:9333/mcp` | 时间/时区 |
| context7 | `http://127.0.0.1:9331/mcp` | 库文档 |
| playwright | `http://127.0.0.1:9337/mcp` | 浏览器自动化 |

---

## 通用接入三层

新 Agent 接入按优先级分三层（B1 调研结论）：

1. **MCP 端点（优先，覆盖 ~90% Agent）**——支持 MCP 的 Agent 直接配 `mcpServers`。本项目 `memory:9338/mcp` 是标准 MCP server，所有 MCP client 零代码接入。
2. **watchdog 被动同步（兜底）**——无 MCP 的工具，靠 watchdog 观察其原生记忆文件（如 Cline/Roo 的 `.clinerules`、各工具的 `*.md` 指令文件），自动同步到统一后端。这是本项目对闭源/无 MCP 工具的差异化能力。
3. **AGENTS.md 约定（指令层）**——在项目根放 `AGENTS.md`（2026 事实标准，被 Kiro/Trae/Goose/Cline/Roo/Continue 原生识别），指向 MCP 端点 + `.ai-memory` 存储。本项目根已有 `AGENTS.md`。

---

## 新增 Agent

支持新 Agent 只需在 `setup-mcp.js` 的 `AGENT_REGISTRY` 加一行：

```js
newagent: {
  name: 'New Agent',
  docUrl: 'https://docs.newagent.dev/mcp',
  configPath: () => ({ any: [join(homedir(), '.newagent', 'mcp.json')] }),
  format: 'json-mcpServers',  // 或 'goose-yaml' / 自定义
},
```

无需改其他代码。`--target=newagent` 即可接入。

---

## 验证接入

接入后，在 Agent 里调用 `search_shared_memory`（语义检索）验证：

```
search_shared_memory({ query: "项目架构", limit: 3 })
```

应返回 vault 真实记忆数据。参见 [API_REFERENCE.md](./API_REFERENCE.md) 了解 28 个工具。

> **注意**：`search_shared_memory` 是主检索工具（语义检索 vault 全量数据）；`memory_search` 是 BM25 项目工具（仅 `projects/*.jsonl`）。详见 API 参考。

---

## 故障排查

| 问题 | 排查 |
|------|------|
| Agent 连不上 server | 确认 `node start.js` 跑着，`netstat \| grep 9338` 有 LISTENING |
| 检索返回空 | 确认 vault 有数据 + 跑过 `rebuild_memory_embeddings`（见 [OPERATIONS.md](./OPERATIONS.md)）|
| 配置没写入 | 用 `--dry-run` 看检测到的路径；手动按打印的指引配 |
| memory_search 空 | 这是设计行为（BM25 项目工具）；语义检索用 `search_shared_memory` |

更多见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。
