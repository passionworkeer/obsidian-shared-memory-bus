# Stop Hook LLM 提取

Claude Code Stop Hook 触发时，自动从 transcript 文件提取结构化事实，写入 Obsidian inbox，不阻塞主进程。

## 文件结构

```
hooks/stop-hook-llm-extract/
├── stop-extract.mjs        # 主入口（ES module）
├── src/
│   └── transcript-slicer.mjs # SmartSlice 切片逻辑
├── hooks.json               # Stop Hook 配置（追加到 claude-mem）
└── README.md                # 本文件
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AI_MEMORY_OBSIDIAN_VAULT` | `E:\desktop\Obsidian Vault` | Obsidian vault 根目录 |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:15721` | 本地代理地址（支持 /v1/messages） |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | 提取用模型（可选） |

## 安装方法

### Step 1：确认 claude-mem 的 hooks.json 路径

Claude Code Stop Hook 通过 claude-mem 插件触发，hooks.json 位于：

```
C:/Users/wang/.claude/plugins/cache/thedotmack/claude-mem/10.6.2/plugin/hooks/hooks.json
```

### Step 2：合并 hooks 配置

不要直接修改 claude-mem 的 `hooks.json`。将 `stop-hook-llm-extract/hooks.json` 中的 `"Stop"` 条目追加到现有 hooks.json 的 `hooks.Stop` 数组中。

**示例合并（hooks.json 合并后）：**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /之前/的/hook.js", "timeout": 30 }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "node E:/desktop/obsidian-shared-memory-bus/hooks/stop-hook-llm-extract/stop-extract.mjs",
            "description": "Stop Hook LLM 提取",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Step 3：确认路径

将上述合并后的配置写入 claude-mem 的 hooks.json，或联系 claude-mem 作者支持 `~/.claude/hooks.d/` 目录（推荐）。

## Claude Code Hook stdin 格式

Claude Code Stop Hook 通过 stdin 传入 JSON，格式如下：

```json
{
  "session_id": "abc123",
  "cwd": "E:/project",
  "transcript_path": "C:/Users/wang/.claude/sessions/abc123/transcript.txt",
  ...
}
```

`stop-extract.js` 优先读取命令行参数，其次读取 stdin JSON。

## 预期行为

- **耗时**：< 5 秒（含 5 秒 LLM 超时）
- **阻塞**：不阻塞 Claude Code 主进程（`process.exit(0)` 即时返回）
- **静默失败**：transcript 不存在或已处理时静默退出，不写日志
- **超时处理**：LLM 超时写入 `pending-extractions.jsonl`，下次 SessionStart 补提取

## 输出文件

| 文件 | 位置 | 说明 |
|------|------|------|
| Inbox MD | `00-System/ai-memory/inbox/claude-code.md` | Obsidian inbox（追加） |
| shared-inbox.jsonl | `00-System/ai-memory/structured/shared-inbox.jsonl` | 共享事实记录（去重用） |
| pending-extractions.jsonl | `00-System/ai-memory/structured/pending-extractions.jsonl` | 超时待补提取会话 |

## 提取字段

从 transcript 中提取：

- `session_type` — bugfix | feature | refactor | discovery | docs | chore
- `facts` — 客观事实列表
- `decisions` — 决策列表
- `entities` — 实体（name + type）
- `summary` — 一句话概括
- `confidence` — 置信度 0.0–1.0

## SmartSlice 策略

`src/transcript-slicer.mjs` 按以下顺序拼接切片：

1. **开头 500 tokens** — 保留用户原始意图
2. **所有 decision/error/warn 类工具调用** — Bash/Write/Edit/Task/Agent 等工具 + 前后各 3 行上下文
3. **结尾 500 tokens** — 保留最终执行结果

总 token 预算 3000，超限时优先保头尾，中间工具结果裁剪。

### 调试

手动运行：

```bash
# 方式 1：命令行参数
node --input-type=module stop-extract.mjs "E:/project" "session_123" "C:/transcript.txt" < /dev/null

# 方式 2：stdin JSON
echo '{"session_id":"test","cwd":"E:/project","transcript_path":"C:/transcript.txt"}' \
  | node --input-type=module stop-extract.mjs

# 方式 3：单独测试 SmartSlice
node -e "
import('./hooks/stop-hook-llm-extract/src/transcript-slicer.mjs')
  .then(m => console.log(JSON.stringify(m.SmartSlice('开用户意图...\n[Bash]执行命令\n[Error]失败', ''), null, 2)))
"

## 依赖

- Node.js >= 18（内置 ES module、fetch、fs、readline）
- 无任何第三方 npm 包

## SessionStart 补提取（可选）

当 LLM 超时时，会话记录写入 `pending-extractions.jsonl`。
下次 Claude Code 启动时（SessionStart），补提取这些超时会话：

```json
// 在 claude-mem 的 hooks.json 的 SessionStart 中追加：
{
  "hooks": [
    {
      "type": "command",
      "command": "node \"${AI_MEMORY_ROOT}/hooks/stop-hook-llm-extract/src/session-start-replay.mjs\"",
      "timeout": 60
    }
  ]
}
```

每次 SessionStart 最多补提取 3 条，防止启动耗时过长。
