# Logging

> Centralized log specification for the obsidian-shared-memory-bus PowerShell
> startup chain and MCP server processes. 详见最近一次 `docs/PROJECT_AUDIT_*.md` §4.3 相关条目。

## 1. Directory layout

All logs live under a single central directory:

```
~/.ai-memory/logs/
```

The store root is resolved in this priority order:

1. `AI_MEMORY_STORE` environment variable
2. `AI_MEMORY_STORE_ROOT` environment variable (legacy alias)
3. Platform default:
   - **Windows**: `%USERPROFILE%\.ai-memory\logs\`
   - **macOS / Linux**: `$HOME/.ai-memory/logs/`

Use `scripts/Get-LogPath.ps1` to resolve paths programmatically — never
hard-code the directory in new code.

### File naming convention

```
logs/
├── install-2026-06-18.log              # 安装日志（scripts/install.ps1 写入）
├── start-2026-06-18.log                # 启动日志（start-shared-mcp.ps1 按天追加）
├── start-2026-06-18.log.err            # 启动 stderr（脚本级错误输出）
├── runtime-2026-06-18.log              # 运行日志（MCP server 运行期 trace + structure log）
├── crash-2026-06-18T18-30-12.log       # 崩溃日志（带时间戳，每次崩溃一个文件）
├── memory.out.log                      # 单 server stdout（per-server，按 id 命名）
├── memory.err.log                      # 单 server stderr
├── fetch.out.log
└── fetch.err.log
```

| 文件 | 写入者 | 触发时机 | 内容 |
|------|--------|----------|------|
| `install-YYYY-MM-DD.log` | `scripts/install.ps1` | 安装/升级 | 环境检测、依赖安装、配置写入 |
| `start-YYYY-MM-DD.log` | `shared-mcp/start-shared-mcp.ps1` | 每次启动 | 脚本开始/结束、server 状态变更、PID 探测结果 |
| `start-YYYY-MM-DD.log.err` | `shared-mcp/start-shared-mcp.ps1` | 启动失败 | 脚本级 stderr（非 per-server） |
| `runtime-YYYY-MM-DD.log` | MCP server 进程 | 运行期 | 结构化日志、trace、请求摘要 |
| `crash-YYYY-MM-DDTHH-mm-ss.log` | `start-shared-mcp.ps1` catch 块 | 未捕获异常 | 完整异常信息 + ScriptStackTrace |
| `{server-id}.out.log` | `Start-SharedBackgroundProcess` | 子进程启动 | 该 server 的 stdout 原始输出 |
| `{server-id}.err.log` | `Start-SharedBackgroundProcess` | 子进程启动 | 该 server 的 stderr 原始输出 |

## 2. Log levels

| 级别 | 含义 | 写入目标 |
|------|------|----------|
| `DEBUG` | 详细诊断（端口探测、PID 探测中间步骤） | `start-*.log` |
| `INFO` | 正常流程（启动开始、server 就绪、状态变更） | `start-*.log` |
| `WARN` | 可恢复异常（state.json 损坏后重建、端口被占用但已清理） | `start-*.log` |
| `ERROR` | 不可恢复错误（server 启动失败、健康检查超时） | `start-*.log` + `start-*.log.err` |
| `CRASH` | 未捕获异常导致脚本终止 | `crash-*.log` |

日志行格式（由 `Write-LogEntry` 统一生成）：

```
[2026-06-18T18:30:12.1234567+08:00] [INFO] shared-mcp startup begin (PID=12345)
```

## 3. Log rotation

### 自动轮转

- **按天切割**：`install-*`、`start-*`、`runtime-*` 日志文件名含日期，每天自动产生新文件。
- **崩溃日志**：`crash-*` 文件名含秒级时间戳，每次崩溃独立文件，不覆盖。

### 清理策略

日志目录不会无限增长。建议的清理规则（可由 `scripts/watchdog.ps1` 或系统
定时任务执行）：

| 文件类型 | 保留期 | 清理方式 |
|----------|--------|----------|
| `install-*.log` | 30 天 | 超过 30 天的删除 |
| `start-*.log` / `start-*.log.err` | 14 天 | 超过 14 天的删除 |
| `runtime-*.log` | 7 天 | 超过 7 天的删除 |
| `crash-*.log` | 90 天 | 超过 90 天的删除（崩溃日志价值高，保留更久） |
| `{server-id}.out.log` / `.err.log` | 当前运行期 | 每次 server 重启时覆盖 |

手动清理示例：

```powershell
# 删除 14 天前的 start 日志
Get-ChildItem "$env:USERPROFILE\.ai-memory\logs\start-*.log*" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force
```

## 4. How to view logs

### 快速查看今天的启动日志

```powershell
# Windows
Get-Content "$env:USERPROFILE\.ai-memory\logs\start-$(Get-Date -Format 'yyyy-MM-dd').log" -Tail 50

# macOS / Linux
tail -50 "$HOME/.ai-memory/logs/start-$(date +%Y-%m-%d).log"
```

### 实时跟踪启动日志

```powershell
# Windows (PowerShell)
Get-Content "$env:USERPROFILE\.ai-memory\logs\start-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait -Tail 20

# macOS / Linux
tail -f "$HOME/.ai-memory/logs/start-$(date +%Y-%m-%d).log"
```

### 查看某个 server 的 stderr

```powershell
# 例如 memory server
Get-Content "$env:USERPROFILE\.ai-memory\logs\memory.err.log" -Tail 50
```

### 查看最近的崩溃日志

```powershell
Get-ChildItem "$env:USERPROFILE\.ai-memory\logs\crash-*.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 |
    Get-Content
```

## 5. Troubleshooting by log

### 症状：MCP server 启动后立即退出

1. 查看 `start-YYYY-MM-DD.log` — 找到该 server 的 `status` 行。
   - `failed-unhealthy` → 健康检查超时，server 启动了但端口没监听。
   - `skipped` → 配置缺失（如 MINIMAX_API_KEY 未设置）。
2. 查看 `{server-id}.err.log` — server 进程的原始 stderr，通常含具体报错。
3. 查看 `{server-id}.out.log` — server 进程的原始 stdout，含启动 banner。

### 症状：启动脚本本身崩溃（空白窗口 / 无输出）

1. 查看 `crash-*.log` — 最近的崩溃日志含完整异常栈。
2. 查看 `start-YYYY-MM-DD.log.err` — 脚本级 stderr。
3. 如果两个文件都不存在，说明崩溃发生在日志初始化之前（极少见），
   手动运行脚本查看控制台输出：
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\shared-mcp\start-shared-mcp.ps1
   ```

### 症状：state.json 损坏

`start-*.log` 中会出现：
```
[...] [WARN] state.json was corrupt, backed up to ...state.json.corrupt.YYYYMMDDHHmmss
```
脚本会自动备份损坏文件并从空状态重建，无需手动干预。

## 6. Programmatic access

### 在 PowerShell 脚本中使用

```powershell
# Dot-source the helper
. .\scripts\Get-LogPath.ps1

# 获取日志根目录（自动创建）
$logRoot = Get-LogRoot

# 获取今天的启动日志路径
$startLog = Get-DailyLogPath -Prefix "start"

# 获取今天的启动 stderr 路径
$startErr = Get-DailyLogPath -Prefix "start" -Error

# 获取崩溃日志路径（带时间戳）
$crashLog = Get-CrashLogPath

# 写入一条日志
Write-LogEntry -Path $startLog -Message "shared-mcp startup begin" -Level "INFO"
```

### 在 Node.js / 其他进程中使用

非 PowerShell 进程可通过环境变量 `AI_MEMORY_STORE`（或平台默认路径）自行
拼接日志目录：

```javascript
const path = require("path");
const os = require("os");
const fs = require("fs");

const storeRoot = process.env.AI_MEMORY_STORE ||
                  process.env.AI_MEMORY_STORE_ROOT ||
                  path.join(os.homedir(), ".ai-memory");
const logRoot = path.join(storeRoot, "logs");
fs.mkdirSync(logRoot, { recursive: true });
```

## 7. Fallback behavior

当 `~/.ai-memory/logs/` 不可写时（权限不足、磁盘满等），`start-shared-mcp.ps1`
会回退到 `shared-mcp/logs/`（仓库内目录）。这确保即使中央日志目录不可用，
启动链仍能记录日志，不会因日志写入失败而中断启动。

回退逻辑在 `start-shared-mcp.ps1` 的 `$logRoot` 解析中实现：先尝试
`Get-LogRoot`（中央目录），失败则使用 `Join-Path $root "logs"`（本地目录）。
