# user-portrait · 用户画像 Skill

> 自动汇集本机所有 AI 工具日志里的**用户侧消息**,结合用户导出的微信/QQ 聊天记录,生成结构化个人画像——给自己看,也给所有 AI 助手看。

[SKILL.md](SKILL.md) 是 agent 执行协议;本文件面向人类用户。

## 它做什么

```
~/.claude  ~/.codex  ~/.cursor  ~/.copilot  ~/.gemini  opencode  ~/.zcode  ~/.codebuddy
   │          │         │          │          │          │         │          │
   └──────────┴─────────┴────┬─────┴──────────┴──────────┴─────────┴──────────┘
                            ▼
              collect 采集(只取用户消息 · 自动脱敏 · 去重)
                            ▼
                     messages.jsonl(原始层, P2 隐私)
                            ▼
              analyze 分析(时间线/时段/高频词/项目/习惯)
                            ▼
              render 渲染 ─┬─ PROFILE.md      画像主文件(事实层+AI观察层)
                           ├─ profile.json    结构化数据(给程序读)
                           ├─ dashboard.html  可视化(浏览器直接打开, 离线)
                           └─ inbox 回写      → 所有共享记忆 agent 可发现
```

## 快速开始

```bash
# 在本仓库根目录
node skills/user-portrait/run.js            # 全流程
node skills/user-portrait/run.js status     # 看产物在哪
# 然后浏览器打开 <store>/portrait/dashboard.html
```

跑完脚本后,对任意接入本记忆总线的 AI 助手说: **"按 skills/user-portrait/SKILL.md 第 4 步,补写我的画像定性部分"** —— AI 会抽样阅读你的历史消息,补写 PROFILE.md 的定性画像(技能方向/兴趣/工作方式/协作偏好),每条带置信度。

## 支持的数据源

| 来源 | 位置 | 取什么 |
| --- | --- | --- |
| Claude Code | `~/.claude/history.jsonl` + `projects/**/*.jsonl` | 输入流水 + 会话中的用户轮次 |
| Codex CLI | `~/.codex/sessions/**` + `archived_sessions/` + `history.jsonl` | rollout 中的用户消息 |
| Cursor | `~/.cursor/projects/**/agent-transcripts/*.jsonl` | agent 会话用户请求 |
| Copilot CLI | `~/.copilot/session-state/*/events.jsonl` | `user.message` 事件 |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json` | 会话用户消息 |
| opencode | `~/.local/share/opencode/storage/{message,part}/` | 用户消息 + 文本分片 |
| ZCode | `~/.zcode/cli/rollout/*.jsonl` | 请求中的用户轮次 |
| CodeBuddy | `~/.codebuddy/history.jsonl` | 输入流水 |
| 微信/QQ 导入 | 用户手动导出(见下) | 本人发送的消息 + 上下文 |

全平台支持(Windows / macOS / Linux):所有路径经 `os.homedir()` 解析;某工具未安装时自动跳过并在 `sources-report.md` 里注明。

## 微信 / QQ 聊天记录导出指南

画像的技术侧来自 AI 工具日志;生活侧、社交侧需要你自己导出聊天记录补充。**以下工具全部本地运行,数据不出你的电脑**;导出后把文件(或所在文件夹)路径告诉 agent 即可导入。

### 微信

| 工具 | GitHub | 特点 | 推荐导出格式 |
| --- | --- | --- | --- |
| **MemoTrace (WeChatMsg)** | LC044/WeChatMsg ⭐3w+ | 最流行,需在 PC 微信登录状态下解密数据库 | CSV 或 TXT |
| **echotrace** | ycccccccy/echotrace | 本地导出+分析+年度报告一体 | CSV / JSON |
| **WechatExporter** | BlueMatthew/WechatExporter | 老牌备份导出 | HTML |

典型流程(MemoTrace):PC 登录微信 → 打开 MemoTrace → 选择联系人/群 → 导出 CSV → 把 CSV 路径交给本 skill。

### QQ

- NTQQ 时代可使用社区导出工具(在 GitHub 搜 "QQ 聊天记录导出 / NTQQ export"),导出 CSV/JSON;
- QQ 自带"合并转发"导出的 TXT 也能被解析(按 `昵称 + 时间戳` 块识别);
- 手动整理的任意 CSV(含 时间/发送者/内容 三列)同样可导入。

### 导入命令

```bash
node skills/user-portrait/run.js import-chat "D:\exports\微信记录\张三.csv"
node skills/user-portrait/run.js import-chat "D:\exports\QQ"     # 整个目录批量导入
```

支持 `.csv / .txt / .json / .html`,表头自动识别(中英文均可)。本人发送的消息会被标记(依赖导出工具的 IsSend/发送者 字段),分析时与联系人消息分开统计;联系人昵称保留在原始层,不会进入 PROFILE.md 正文。

## 隐私与安全

- **本地优先**:采集、分析、渲染全程不联网;产物存在共享记忆库 `<store>/portrait/`。
- **自动脱敏**:API key、token、私钥、长 hex、带密码的连接串一律替换为 `[REDACTED:*]`;`--redact strict` 追加脱敏邮箱和手机号。
- **隐私分级**:产物按 ai-context 约定标 P2(高隐私)——仅本人与本地 AI 使用,禁止进入公开材料。
- **只读采集**:skill 不写入任何 AI 工具的数据目录。
- **chat-import 明确授权**:微信/QQ 数据永远不会被自动扫描,只在你显式给出路径时导入。

## CLI 一览

```
node skills/user-portrait/run.js                     # 全流程
node skills/user-portrait/run.js collect [--limit N] [--sources a,b] [--redact strict]
node skills/user-portrait/run.js analyze
node skills/user-portrait/run.js render [--title 名字] [--no-inbox]
node skills/user-portrait/run.js import-chat <path> [--peer 名]
node skills/user-portrait/run.js status
```

npm 快捷方式:`npm run portrait` / `npm run portrait:collect` / `npm run portrait:render`。

## 与共享记忆总线的集成

- 产物在 `<store>/portrait/`,与 JSONL 真相层同库;
- render 时向 `<store>/inbox/user-portrait.md` 追加指针,任何走 SKILL.md 读协议的 agent 都能发现画像;
- 画像事实可被 `search_shared_memory` 检索(未来:可将 profile.json 摘要写入 structured 流);
- PROFILE.md 第 6 节由 agent 增量维护,遵循仓库 ai-context 约定(事实/观察分离、置信度、隐私分级)。

## 常见问题

- **某工具显示 0 条**:看 `sources-report.md` 的"检测到但未解析的存储"与错误列;SQLite 类存储(如 Cursor 主聊天库)暂不解析,已有 jsonl 通道覆盖。
- **重跑会不会丢掉 AI 写的定性画像**:会覆盖第 6 节——重跑 render 前先备份(见 SKILL.md「增量更新」)。
- **想彻底删除**:删除 `<store>/portrait/` 目录与 `<store>/inbox/user-portrait.md` 即可,无其他副本。
