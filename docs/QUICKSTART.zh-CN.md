# 快速开始 (Quick Start)

中文 | [English](./QUICKSTART.md)

## 一键启动

### Windows

```powershell
# 1. 克隆项目
git clone <repo-url>
cd obsidian-shared-memory-bus

# 2. 一键启动所有服务
.\scripts\start-all.ps1

# 3. 配置 Claude Code hooks（可选）
.\scripts\setup-hooks.ps1
```

### macOS / Linux

```bash
# 1. 克隆项目
git clone <repo-url>
cd obsidian-shared-memory-bus

# 2. 一键启动
pwsh ./scripts/start-all.ps1

# 3. 配置 hooks
pwsh ./scripts/setup-hooks.ps1
```

## 启动流程

```
start-all.ps1 会自动：
1. 检查 Node.js、Python、npm 依赖
2. 安装必要的 npm 和 Python 包
3. 启动所有 MCP 服务器（端口 9331-9338）
4. 启动 Watchdog 观察者
5. 验证服务状态
```

## 手动分步启动

如果需要手动控制：

```powershell
# 1. 启动 MCP 服务器
.\shared-mcp\start-default-shared-mcp.ps1

# 2. 检查状态
.\shared-mcp\status-shared-mcp.ps1

# 3. 启动 Watchdog
.\memory-watchdog.ps1 -Daemon
```

## MCP 服务器端口

| 端口 | 服务 | 说明 |
|------|------|------|
| 9331 | context7 | 代码/文档搜索 |
| 9332 | fetch | HTTP 请求 |
| 9333 | time | 时间工具 |
| 9334 | sequential-thinking | 推理助手 |
| 9338 | memory | 记忆系统 |

## 配置 AI 工具

### Claude Code

```powershell
.\scripts\setup-hooks.ps1
```

### Cursor

复制 `onboarding/cursor/.cursor/mcp.json` 到你的 Cursor 配置。

### VS Code

复制 `onboarding/vscode/mcp.json` 到 `~/.config/Code/User/mcp.json`。

### Codex

复制 `onboarding/codex/codex.shared-mcp.toml` 到 `~/.codex/config.toml`。

## 验证安装

```powershell
.\ops\verify\verify-integrations.ps1
```

## 记忆文件位置

- **本地存储**: `~/.ai-memory/`

### 目录结构

```
ai-memory/
├── inbox/           # 各工具的收件箱
│   ├── claude-code.md
│   ├── openclaw.md
│   └── ...
├── generated/       # 生成的上下文
│   ├── GLOBAL-CONTEXT.md
│   └── MEMORY-LAYERS.md
└── structured/      # 结构化数据
    ├── session-memory.jsonl
    └── task-memory.jsonl
```

## 故障排除

### MCP 服务器无法启动

```powershell
# 检查端口占用
netstat -ano | findstr "9338"

# 查看详细日志
.\shared-mcp\start-default-shared-mcp.ps1 -Verbose
```

### Hooks 不生效

```powershell
# 重新配置 hooks
.\scripts\setup-hooks.ps1 -Uninstall
.\scripts\setup-hooks.ps1
```

### 记忆文件未写入

1. 检查 9338 端口是否运行：`Test-NetConnection 127.0.0.1 -Port 9338`
2. 查看 Watchdog 日志
3. 手动同步：`.\bus\memory-bus.ps1 -Action SyncAll`

## 下一步

- 阅读 [完整启动指南](./docs/STARTUP_GUIDE.md)
- 阅读 [架构文档](./docs/ARCHITECTURE.md)
- 查看 [MCP 工具文档](./docs/reference/MCP-TOOLS.md)
