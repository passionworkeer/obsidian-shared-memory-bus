---
name: user-portrait
description: Build the user's personal profile (个人画像) by harvesting local AI-agent logs (Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, opencode, ZCode, CodeBuddy) and user-imported WeChat/QQ chat exports, then analyzing and rendering PROFILE.md / profile.json / dashboard.html into the shared memory store. Trigger when the user asks to 生成/更新"用户画像/个人画像/persona", or wants AI tools to "更了解我", or asks to analyze their AI usage history or exported chats.
version: 0.1.0
---

# user-portrait · 用户画像 Skill

> 一句话:自动汇集本机所有 AI 工具里的"用户侧消息"+ 用户导出的微信/QQ 聊天记录,产出结构化个人画像,存入共享记忆库,供本人查看、供所有 AI 助手读取。

## 能力边界

- **采集(自动)**:扫描本机 `~/.claude`、`~/.codex`、`~/.cursor`、`~/.copilot`、`~/.gemini`、`~/.local/share/opencode`、`~/.zcode`、`~/.codebuddy` 中的用户消息(只取用户说的,不取模型回复),自动脱敏、去重。
- **采集(手动)**:用户自行导出微信/QQ 聊天记录后执行 `import-chat`(导出方法见同目录 README.md)。
- **分析**:时间线、活跃时段、高频词、项目足迹、语言习惯等——全部本地计算,不联网。
- **画像**:脚本产出"事实层",agent 补写"观察层"(带置信度),两者严格分离。
- **消费**:产物写入 `<store>/portrait/`,并向 `<store>/inbox/user-portrait.md` 写指针,任何接入共享记忆总线的 agent 都能发现并读取。

## 工作流程(agent 按此执行)

### 1. 采集

```bash
node skills/user-portrait/run.js            # collect → analyze → render 全流程
node skills/user-portrait/run.js status     # 查看存储位置与已有产物
```

可选参数:`--limit N`(每源消息上限)、`--sources claude-code,codex`(只采集部分来源)、`--home <dir>`(非默认主目录)、`--redact strict`(同时脱敏邮箱/手机号)。

### 2. 核对采集报告

读 `<store>/portrait/sources-report.md`:确认各来源扫描文件数/留存数/错误。若某来源数据异常(如 0 条但用户明显在用),把"检测到但未解析的存储"提示转告用户。

### 3. 渲染

```bash
node skills/user-portrait/run.js render --title <用户名或昵称>
```

生成 `PROFILE.md`、`profile.json`、`dashboard.html`、`sources-report.md`,并回写总线 inbox。

### 4. 补写定性画像(agent 的核心增值步骤)

脚本只产出统计事实;以下定性部分**必须由 agent 完成**:

1. 读 `<store>/portrait/stats.json`(高频词 top_latin_terms/top_cjk_terms、项目 top_projects、活跃规律、samples.recent 最近消息样本)。
2. 抽样阅读 `<store>/portrait/messages.jsonl` 中不同时期的用户消息(每源抽 10-20 条即可,不要全读)。
3. 填写 `PROFILE.md` 第 6 节的六个子节:一句话画像 / 核心技能与方向 / 兴趣主题 / 工作方式 / 协作偏好 / 待验证观察。
4. 同步把结论写入 `profile.json` 的 `ai_sections` 字段(保持 JSON 合法)。
5. **每条观察必须标注置信度**:【高置信】(多条消息直接支持)/【中置信】(间接推断)/【待验证】(单一线索)。
6. 区分"事实"(用户原话/可验证数据)与"观察"(AI 推断),不得混写;不确定就写"待验证",不要编造。

### 5. 微信 / QQ 补充(建议用户,不代做)

当画像的技术侧信息已足够、但生活侧/社交侧稀薄时,建议用户:

> "你可以把微信/QQ 聊天记录导出成 CSV/TXT(方法见 skills/user-portrait/README.md,推荐 MemoTrace/echotrace,全程本地),然后告诉我文件路径,我来导入分析。"

用户给出文件后:

```bash
node skills/user-portrait/run.js import-chat <文件或目录> [--peer 对方名]
```

### 6. 汇报

向用户展示:数据覆盖(哪些工具、多少条、时间跨度)、3-5 条最有意思的发现、dashboard.html 路径(浏览器打开)、以及画像如何被其他 AI 使用(读 inbox 指针)。

## 隐私规则(强制)

- 所有产物默认 **P2 高隐私**,只存本地 `<store>/portrait/`;绝不写入公开目录、不上传。
- 凭据自动脱敏(`[REDACTED:*]`);发现漏网敏感信息立即修复 messages.jsonl 并告知用户。
- 引用画像回答时可以概括,不得大段粘贴原始消息到公开渠道。
- `messages.jsonl` 只在用户明确要求时才展示内容;agent 内部抽样阅读即可。
- 不得把画像用于:向第三方系统发送、训练上传、生成针对用户的心理操纵内容。

## 增量更新

重复运行安全:collect 会整体重建 messages.jsonl(全量重扫,幂等);agent 补写的第 6 节在重跑 render 后会被覆盖——**重跑前先把 PROFILE.md 第 6 节与 profile.json 的 ai_sections 备份/迁移**,再回填。约定:把上次画像的第 6 节先拷到 `PROFILE.section6.backup.md`,render 后还原。

## 依赖

- Node ≥ 18(与主仓库一致),无新增 npm 依赖。
- 复用主仓库:`bus/bm25.js`(分词)、`bus/store-root.js`(存储定位)。
