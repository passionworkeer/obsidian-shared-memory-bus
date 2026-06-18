# obsidian-shared-memory-bus · 打包与宣传 Playbook（v2 详细版）

> **版本**：v2.0（详细版）
> **撰写日期**：2026-06-17
> **当前 GitHub 状态**：1 star / 0 fork / 0 subscriber / 0 issue（2.5 月龄）
> **目标**：12 个月内从 0 → 1,000 star
> **对标项目**：claude-mem 89K star（同类赛道，AGPL-3.0，1 行安装）
> **核心策略**：用"MIT + 多工具共享 + Obsidian"差异化对标 claude-mem 抢占商业用户
> **v1 → v2 增补**：5 套 HN/Reddit 备选正文、5 套 KOL 邮件、README 重写骨架、demo GIF 逐秒脚本、npm 发布 Checklist、20+ 话术库、产品对比矩阵、12 周逐日执行表

---

## 0. 核心问题诊断

### 0.1 用户为什么可能不会 Star

| 障碍 | 严重度 | 解决路径 |
|---|---|---|
| **安装 5-10 步 + Python/PS 环境依赖** | ⭐⭐⭐⭐⭐ 致命 | npx 一行安装 + 预编译二进制 |
| **README 没 demo GIF/视频** | ⭐⭐⭐⭐ | 60 秒 GIF + 5 分钟教程视频 |
| **0 社区信号**（0 issue 0 fork） | ⭐⭐⭐⭐ | 先发 v3.2.0-rc1 邀请内测 |
| **claude-mem 已占 89K 星，先发优势** | ⭐⭐⭐ | MIT 差异化定位 + Obsidian 流量 |
| **项目说明长 1500+ 行** | ⭐⭐ | 重写 README，第一屏 30 秒能懂 |
| **缺 Logo / 社交预览图** | ⭐⭐ | 标准化 GitHub 资产 |
| **Topics 关键词不全** | ⭐⭐ | 加满 10 个 topics |
| **缺中文 README** | ⭐⭐ | 双语 README |

### 0.2 用户为什么会 Star（基于同类项目推断）

1. **痛点共鸣**：开发者真实经历 "AI 工具换一次就要重新讲一遍项目"
2. **1 行能用**：看到 `npx xxx install` 立刻试
3. **demo 视频**：60 秒内看到效果
4. **README 极简**：技术深度图 + 性能截图
5. **社区信号**：哪怕 50 星也会触发从众效应
6. **MIT vs AGPL**：商业用户敏感，会主动选 MIT
7. **Obsidian 生态**：数百万用户搜索流量大

---

## 1. 12 周总览（4 个 Phase）+ 逐日执行表

```
W1-W2   ▓▓ Phase 1: 打磨（让 README 30 秒能懂 + 1 行能装）
W3-W4   ▓▓ Phase 1.5: 内测 + 收集反馈
W5-W6   ██ Phase 2: 首发（HN Show / Reddit / awesome-mcp-servers）
W7-W8   ██ Phase 2.5: 二次传播（视频 / KOL 转载）
W9-W10  ░░ Phase 3: SEO 长尾（博客 / 文档站 / 关键词占位）
W11-W12 ░░ Phase 3.5: 飞轮（社区 / contributor 招募）
```

### 1.1 12 周里程碑

| 节点 | Star | Forks | Contributors | 周下载 |
|---|---|---|---|---|
| **W0（现在）** | 1 | 0 | 1 | 0 |
| **W2** | 30 | 3 | 2 | 50 |
| **W6** | 200 | 15 | 5 | 500 |
| **W8** | 500 | 40 | 8 | 1,500 |
| **W12** | 1,000 | 80 | 12 | 5,000 |

### 1.2 逐日执行表（W1 详细版）

| 日 | 任务 | 交付物 | 工时 |
|---|---|---|---|
| **D1** | 录 60s demo GIF | 60s GIF ≤ 5MB | 4h |
| **D1** | 设计 Logo（提示词给 AI） | 512x512 PNG | 1h |
| **D1** | 设计社交预览图 | 1280x640 PNG | 1h |
| **D2** | 重写 README 英文版 | docs/README.md | 3h |
| **D2** | 翻译 README 中文版 | docs/README.zh-CN.md | 1h |
| **D3** | 发布 npm 包 @obsidian-shared-memory-bus/cli | npm 上线 | 4h |
| **D3** | 编写 install / start / status 三个命令 | CLI 完整 | 2h |
| **D4** | 开启 GitHub Discussions | repo 设置 | 30min |
| **D4** | 提 PR 到 awesome-mcp-servers | 1 个 PR | 1h |
| **D4** | 提 PR 到 awesome-obsidian | 1 个 PR | 1h |
| **D5** | 写 v3.2.0 changelog | CHANGELOG.md | 1h |
| **D5** | 准备 HN 标题 3 个版本 | 候选列表 | 30min |
| **D5** | 准备 HN 正文 3 个版本 | 候选列表 | 2h |
| **D6-D7** | 周末 | 休息 | — |
| **D8** | 写 HN 帖最终版（挑 1 个） | HN 文案 | 1h |
| **D8** | 写 Reddit 帖（3 个 sub） | 3 个文案 | 1h |
| **D8** | 写 Twitter 长文 | 1 条 | 30min |
| **D8** | 写即刻 / V2EX 帖 | 2 个文案 | 30min |

---

## 2. Phase 1 · 打磨（W1-W2）

> 目标：让一个陌生开发者 30 秒看懂、5 分钟跑起来

### 2.1 README 重构（最重要，单变量 ROI 最高）

**当前问题**（推断，未看）：1500+ 行说明文档，技术深度图摆首位，缺 hero demo

**新 README 结构**（仿照 claude-mem + OpenClaw 的爆款模板）：

```markdown
# Obsidian Shared Memory Bus

> Local-first AI memory layer that lets Claude Code, Codex, OpenCode, Cursor share the same project context. MIT, MCP-native, 5-minute install.

## See it in 60 seconds

[showcase.gif - 自动播放]

## Why this exists

- **Stop re-explaining your project.** Each AI tool forgets the last session. This gives them all the same memory.
- **Works across tools.** Claude Code, Codex, OpenCode, Cursor, and any MCP-capable agent.
- **Yours, forever.** Local-first, MIT licensed, no SaaS, no telemetry.
- **Obsidian-native.** Your vault is the storage layer. Browse memories in the tool you already use.

## Install (1 command)

\`\`\`bash
npx @obsidian-shared-memory-bus/cli install
\`\`\`

That's it. Restart Claude Code (or Codex / Cursor / OpenCode), and it auto-connects.

## How it works

[30-second architecture diagram]

| AI Tool | Status | Notes |
|---------|--------|-------|
| Claude Code | ✅ Stable | Hooks + MCP |
| Codex CLI | ✅ Stable | MCP |
| Cursor | ✅ Beta | MCP |
| OpenCode | ✅ Stable | MCP |
| Windsurf | ⚠️ Partial | MCP only |
| Aider | ❌ Planned | Q3 2026 |

## Real-world example

[terminal recording showing 3-min workflow]

## Documentation

- [Quickstart (5 min)](./docs/QUICKSTART.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Reference](./docs/guides/API_REFERENCE.md)
- [Memory Tiering](./docs/MEMORY-TIERING.md)
- [Chinese Docs](./docs/QUICKSTART.zh-CN.md)

## Community

- [GitHub Discussions](https://github.com/passionworkeer/obsidian-shared-memory-bus/discussions)
- [Discord](#) (coming soon)
- [Twitter](https://twitter.com/passionworkeer)

## Contributing

We welcome PRs! See [CONTRIBUTING.md](./CONTRIBUTING.md) and [good first issues](https://github.com/passionworkeer/obsidian-shared-memory-bus/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## License

MIT © passionworkeer
```

**关键规则**：
- 第一屏（折叠上方）**只放**：标题 + tagline + GIF + 一行安装
- 技术深度图、ADR 全部下沉到 `docs/`
- 中英双语（英文为主，README 顶部带中英切换链接）
- 不要有"⭐ Star this repo"按钮（让用户主动发现）

### 2.2 60 秒 Demo GIF 逐秒脚本

**工具**：ScreenToGif / OBS / Loom（推荐 ScreenToGif 体积最小）

**分辨率**：1920×1080 30fps，输出 ≤ 5MB

| 秒数 | 屏幕 | 终端命令 | 字幕 |
|---|---|---|---|
| 0-2 | 黑色 + Logo 淡入 | — | "Local-first AI memory" |
| 2-5 | 终端打开项目 | `cd ~/projects/my-app` | "Step 1: Install" |
| 5-12 | 终端 | `npx @obsidian-shared-memory-bus/cli install` | "One command. 3 minutes." |
| 12-15 | 安装进度条 | (auto) | (no text) |
| 15-18 | 安装成功提示 | "✓ Installed. Restart Claude Code." | (no text) |
| 18-22 | 切换到 Claude Code | (open) | "Step 2: Use" |
| 22-32 | Claude Code 提问 | "What did we fix last week?" | "AI tool with memory" |
| 32-38 | Claude Code 返回 3 条记忆 | (auto) | "It remembers" |
| 38-45 | 切换到 Codex | (open) | "Step 3: Share" |
| 45-55 | Codex 同样问题 | "What did we fix last week?" | "Same memory across tools" |
| 55-58 | Codex 返回相同记忆 | (auto) | "✓ Consistent" |
| 58-60 | 切换到 Obsidian 显示 JSONL | — | "Stored in your Obsidian vault" |

**输出**：
- 60s 1920x1080 GIF（≤ 5MB）放在 README 顶部
- 5min 1080p MP4 上传 YouTube + B 站
- B 站 + 抖音各发一条短视频

### 2.3 npm 包 `@obsidian-shared-memory-bus/cli` 实现

**目录结构**：
```
cli/
├── package.json
├── bin/
│   └── obsb.js              # 主入口
├── commands/
│   ├── install.js
│   ├── start.js
│   ├── status.js
│   └── update.js
├── lib/
│   ├── detect-platform.js
│   ├── check-deps.js
│   ├── write-mcp-config.js
│   └── install-logger.js
└── README.md
```

**`package.json`**：
```json
{
  "name": "@obsidian-shared-memory-bus/cli",
  "version": "3.2.0",
  "description": "CLI installer for Obsidian Shared Memory Bus",
  "bin": { "obsb": "./bin/obsb.js" },
  "type": "module",
  "engines": { "node": ">=18" },
  "dependencies": {
    "chalk": "^5.3.0",
    "inquirer": "^9.2.0",
    "ora": "^7.0.0",
    "execa": "^8.0.0"
  }
}
```

**`bin/obsb.js` 骨架**：
```javascript
#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
program
  .name("obsb")
  .description("Obsidian Shared Memory Bus CLI")
  .version("3.2.0");

program
  .command("install")
  .description("Install MCP server + dependencies")
  .option("--vault <path>", "Path to Obsidian vault")
  .action(async (opts) => {
    const { install } = await import("../commands/install.js");
    await install(opts);
  });

program
  .command("start")
  .description("Start all MCP servers")
  .action(async () => {
    const { start } = await import("../commands/start.js");
    await start();
  });

program
  .command("status")
  .description("Health check all servers")
  .action(async () => {
    const { status } = await import("../commands/status.js");
    await status();
  });

program
  .command("update")
  .description("Update to latest version")
  .action(async () => {
    const { update } = await import("../commands/update.js");
    await update();
  });

program.parse();
```

**`commands/install.js` 骨架**：
```javascript
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { execa } from "execa";
import { detectPlatform } from "../lib/detect-platform.js";
import { checkDeps } from "../lib/check-deps.js";
import { writeMCPConfig } from "../lib/write-mcp-config.js";
import { installLogger } from "../lib/install-logger.js";

const log = installLogger();

export async function install(opts) {
  console.log(chalk.bold("\n🌱 Obsidian Shared Memory Bus Installer\n"));

  // 1. 检测平台
  const platform = detectPlatform();
  log.info(`Detected platform: ${platform}`);

  // 2. 检查依赖
  const spinner = ora("Checking dependencies...").start();
  const deps = await checkDeps({ node: ">=18", python: ">=3.10" });
  if (!deps.ok) {
    spinner.fail(`Missing: ${deps.missing.join(", ")}`);
    console.log(chalk.yellow("\nPlease install missing dependencies:"));
    deps.installHints.forEach((h) => console.log(`  - ${h}`));
    process.exit(1);
  }
  spinner.succeed("All dependencies present");

  // 3. 询问 Obsidian vault 路径
  if (!opts.vault) {
    const { vault } = await inquirer.prompt([{
      type: "input",
      name: "vault",
      message: "Path to your Obsidian vault:",
      default: "~/Documents/MyVault",
    }]);
    opts.vault = vault;
  }

  // 4. 下载主项目
  const installSpinner = ora("Installing bus...").start();
  try {
    await execa("npm", ["install", "-g", "obsidian-shared-memory-bus"]);
    installSpinner.succeed("Bus installed");
  } catch (e) {
    installSpinner.fail("Install failed");
    log.error(e);
    process.exit(1);
  }

  // 5. 写入 MCP config
  const configSpinner = ora("Writing MCP config...").start();
  await writeMCPConfig({ vault: opts.vault, platform });
  configSpinner.succeed("MCP config written");

  // 6. 启动并自检
  const healthSpinner = ora("Health check...").start();
  try {
    await execa("obsb", ["status"]);
    healthSpinner.succeed("All servers healthy");
  } catch {
    healthSpinner.warn("Some servers may need manual start");
  }

  console.log(chalk.green.bold("\n✓ Installation complete!\n"));
  console.log("Next steps:");
  console.log(chalk.cyan("  1. Restart Claude Code (or Codex / Cursor)"));
  console.log(chalk.cyan("  2. Ask: 'What did we work on last week?'"));
  console.log(chalk.cyan("  3. Check the Obsidian vault: " + opts.vault));
  console.log("\nNeed help? https://github.com/passionworkeer/obsidian-shared-memory-bus/issues\n");
}
```

### 2.4 awesome-* 列表 PR 模板

#### awesome-mcp-servers
仓库：`https://github.com/punkpeye/awesome-mcp-servers/blob/main/README.md`

PR 标题：
```
Add obsidian-shared-memory-bus
```

PR 正文：
```markdown
- [obsidian-shared-memory-bus](https://github.com/passionworkeer/obsidian-shared-memory-bus) - Local-first AI memory layer for Claude Code, Codex, OpenCode, Cursor. Backed by Obsidian. MIT, MCP-native. ([docs](https://github.com/passionworkeer/obsidian-shared-memory-bus#readme))
```

#### awesome-obsidian
仓库：`https://github.com/kmaasrud/awesome-obsidian/blob/master/README.md`

分类：AI Assistants & Plugins

PR 标题：
```
Add obsidian-shared-memory-bus to AI Assistants
```

PR 正文：
```markdown
- [Obsidian Shared Memory Bus](https://github.com/passionworkeer/obsidian-shared-memory-bus) - Local-first memory layer that lets AI coding tools (Claude Code, Codex, Cursor) share the same context via your Obsidian vault. MIT, MCP-native.
```

#### awesome-local-first
仓库：`https://github.com/gleeda/awesome-local-first`

PR 标题：
```
Add obsidian-shared-memory-bus
```

#### awesome-claude-code
（如果存在）

PR 标题：
```
Add memory bus extension
```

### 2.5 修 GitHub 仓库设置 Checklist

- [ ] About 描述精简为一行（≤80 字符）：
  > "Local-first AI memory layer for Claude Code, Codex, Cursor. MIT, MCP-native."
- [ ] Topics 加满 10 个：
  ```
  ai-memory, mcp, claude-code, codex, opencode, obsidian, local-first, rag, vector-search, knowledge-graph
  ```
- [ ] `is_template=true` 已开启（GitHub 已自动识别）→ README 顶部加 "Use this template" 引导
- [ ] Discussions 开启：Ask Questions / Show and Tell / Ideas / Announcements
- [ ] Sponsors 按钮开启（GitHub Sponsors）
- [ ] 仓库社交预览图（1280x640）专门设计
- [ ] Pin 3 个 issue：
  - "Welcome: please introduce yourself"
  - "Roadmap Q3 2026"
  - "good first issues 汇总"
- [ ] Branch protection on main：require 1 review + CI green

### 2.6 Phase 1 验收

- [ ] README 第一屏 30 秒能看懂
- [ ] `npx @obsidian-shared-memory-bus/cli install` 在 3 平台 5 分钟内成功
- [ ] 60s demo GIF 完工
- [ ] 已向 5+ awesome 列表提 PR
- [ ] 仓库设置全部到位（discussions、sponsors、topics、logo、social preview）

---

## 3. Phase 1.5 · 内测（W3-W4）

> 目标：找 10-20 个真实用户试装，反馈问题，制造早期社区信号

### 3.1 招募内测文案

#### Twitter / X
```
🌱 Looking for 10-15 beta testers for obsidian-shared-memory-bus v3.2.0-rc1

Local-first AI memory for Claude Code, Codex, Cursor.
MIT licensed. MCP-native. Backed by your Obsidian vault.

You get:
- Early access
- Direct line to the maintainer
- Founding Member badge in credits

You give:
- 30 min of your time
- Honest feedback
- GitHub star (if you like it)

DM me or comment 👇
```

#### 即刻
```
🌱 找 10-15 个内测用户

新做的一个开源项目：obsidian-shared-memory-bus
解决"AI 工具换一次就要重新讲一遍项目"的痛点
完全本地、MIT 协议、MCP 协议

内测福利：
- 提前体验 v3.2.0-rc1
- 直接和作者对话
- 项目 Contributors 列名

你的投入：
- 30 分钟试装
- 真实反馈
- 如果喜欢，给个 star

想试的评论区留言 👇
```

#### Discord / 微信群
```
🌱 [内测招募] obsidian-shared-memory-bus v3.2.0-rc1

项目：让 Claude Code / Codex / Cursor 共享同一份项目记忆
特点：本地优先 / MIT / MCP / Obsidian 存储

要 10-15 人内测，要求：
- 日常用其中至少一个 AI 工具
- 愿意花 30 分钟试装 + 反馈
- 最好有 Obsidian 笔记

回报：
- 直接和作者对话
- 项目 contributors 列名
- 永久 free use 任何付费功能（如果未来有）

感兴趣扣 1
```

### 3.2 5 个核心问题

1. 安装用了多少分钟？（含下载）
2. 卡在哪一步？或者完全无障碍？
3. 查询准确度 1-10 打几分？
4. 会推荐给同事吗？为什么？
5. 缺什么功能？

### 3.3 Phase 1.5 验收

- [ ] 至少 10 个用户跑通完整流程
- [ ] 5 个用户给 ≥8 分推荐意愿
- [ ] v3.2.0 stable 发布
- [ ] 仓库 star ≥ 30（社交证明初步建立）

---

## 4. Phase 2 · 首发（W5-W6）

> 目标：上 Hacker News 首页 / Reddit 热门，突破 200 星

### 4.1 Hacker News "Show HN" 帖（5 套备选正文）

#### 备选 A（推荐首发）

**标题**：
```
Show HN: Obsidian Shared Memory Bus – Local-first AI memory for Claude/Codex/Cursor
```

**正文**：
```
I got tired of explaining my project to Claude Code every morning. Then I tried
Codex, and it had zero memory of what we did yesterday. Then Cursor, same problem.
Each AI tool lives in its own amnesia.

So I built obsidian-shared-memory-bus: a local-first memory layer that gives
Claude Code, Codex, OpenCode, and Cursor the same shared memory, backed by your
Obsidian vault.

Key design choices:
- 100% local. No SaaS, no telemetry, your data stays in ~/.ai-memory
- MIT licensed (vs. claude-mem's AGPL-3.0)
- Works across 5+ AI tools, not just Claude
- 5-tier memory model (event → session → project → shared → archive)
- BM25 + vector hybrid search with MMR reranking

It's been 3 months of solo work, ~70k LOC across PS/Node/Python, 50+ tests, 37 docs.

I'd love feedback from anyone running multiple AI tools on the same project.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
Demo: [60s GIF link]
```

#### 备选 B（痛点导向）

**标题**：
```
Show HN: I built a local-first memory bus so my AI tools stop forgetting my project
```

**正文**：
```
Three months ago, I switched from Claude Code to Codex for a week. When I came
back to Claude, it had no idea what we'd been doing. Then I tried Cursor - same
problem. I lost hours re-explaining the same things.

The root cause: each AI tool stores memory in its own format, in its own place.
There's no shared layer.

I built obsidian-shared-memory-bus to fix this. It's a local-first memory bus
that gives all your AI coding tools the same shared memory.

- Local-first: data stays in ~/.ai-memory and your Obsidian vault
- Cross-tool: Claude Code, Codex, OpenCode, Cursor, Windsurf
- MIT licensed
- 5-tier memory model (event → archive)
- 5-minute install via npx

Looking for beta testers and feedback.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### 备选 C（对比导向）

**标题**：
```
Show HN: MIT alternative to claude-mem – cross-tool AI memory
```

**正文**：
```
claude-mem is great, but it's AGPL-3.0 (problematic for commercial use) and
Claude-only. I built an MIT alternative that works across Claude Code, Codex,
OpenCode, and Cursor.

Key differences:
- MIT vs. AGPL-3.0
- Cross-tool vs. Claude-only
- Obsidian-backed storage (your vault is the database)
- 5-tier memory model with explicit promotion logic
- Smaller (6.9k vs 89k stars, but newer)

3 months of solo work, ~70k LOC, 50+ tests, 37 docs.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### 备选 D（数据导向）

**标题**：
```
Show HN: I lost 10 hours last month to AI tool amnesia, so I built a bus
```

**正文**：
```
Concrete numbers from my dev log last month:
- 6 hours re-explaining architecture to Claude Code after switching tools
- 3 hours fixing the same bug 3 times because Cursor forgot
- 1 hour reading my own old Slack messages to remember decisions

I built obsidian-shared-memory-bus to stop this. It's a local-first memory bus
that gives all your AI coding tools (Claude Code, Codex, OpenCode, Cursor) the
same shared memory.

- 5-minute install
- MIT licensed
- Obsidian-backed
- 6.9k LOC, 50+ tests

If you also waste time re-explaining, give it a try.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### 备选 E（极简）

**标题**：
```
Show HN: Cross-AI-tool memory bus (Claude, Codex, Cursor, MIT)
```

**正文**：
```
Local-first memory layer for AI coding tools.

- 1 command install: npx @obsidian-shared-memory-bus/cli install
- Works with Claude Code, Codex, OpenCode, Cursor
- Backed by your Obsidian vault
- MIT licensed

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

**选择建议**：
- **首选备选 A**（最完整 + 含 demo）
- 备选 C 用于 30 天后二次提交（错开曝光）
- 备选 E 用于 PR 0-2 天内快速发

**发布时间**：周二-周四 太平洋时间 8:00 AM（北京时间 23:00）

### 4.2 Reddit 同步文案（5 个 sub 各 1 套）

#### r/ClaudeAI
**标题**：`[Project] Local-first cross-AI-tool memory bus (MIT, 3-month project)`

**正文**：
```
I got tired of explaining my project to Claude Code every time, so I built
a local-first memory bus that works with Claude Code, Codex, OpenCode, and Cursor.

Key features:
- 100% local, MIT licensed
- 5-minute install via npx
- Obsidian-backed storage
- 5-tier memory model
- 50+ tests, 37 docs

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

Happy to answer any questions about design choices or the 5-tier model.
```

#### r/LocalLLama
**标题**：`Local-first AI memory layer for coding tools (BM25 + vectors, MIT)`

**正文**：
```
Built a cross-tool memory bus for AI coding assistants.

Why local-first: Your code context should never leave your machine.
Why MIT: Commercial-friendly, fork-friendly.
Why Obsidian: Your vault is already a great memory store.

Tech:
- BM25 + dense vector hybrid search
- 5-tier memory (event → session → project → shared → archive)
- 6.9k LOC across PS/Node/Py
- 50+ tests

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

Open to feedback from the local-LLM community.
```

#### r/Obsidian
**标题**：`Cross-AI-tool memory bus backed by your Obsidian vault`

**正文**：
```
For those of you using Obsidian + AI coding tools (Claude Code, Codex, Cursor):

I built a memory bus that uses your Obsidian vault as the storage layer.
All AI tools see the same memory, stored in your vault.

- MIT licensed
- 5-minute install
- Browse memories in Obsidian
- No data leaves your machine

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### r/Codex
**标题**：`Shared memory for Codex + Claude Code + Cursor (MIT)`

**正文**：
```
If you use Codex alongside Claude Code or Cursor, you know the pain of each
tool having its own amnesia. I built a memory bus to share context.

- Local-first
- MIT
- 5-min install
- All three tools see the same memory

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### r/programming
**标题**：`Show: Local memory bus for AI coding tools (open source, MIT)`

**正文**：
```
Open source project I built: a local-first memory bus for AI coding tools
(Claude Code, Codex, OpenCode, Cursor). Solves the "AI forgets my project
every session" problem.

Tech: PS + Node + Python, ~70k LOC, BM25 + vector hybrid, 5-tier memory model.
License: MIT.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

### 4.3 Twitter / X 长文

```
🚀 Launching v3.2.0 of obsidian-shared-memory-bus

A local-first memory bus for AI coding tools:
✅ Claude Code, Codex, OpenCode, Cursor
✅ Obsidian-backed storage
✅ 5-minute install
✅ MIT licensed

Stop re-explaining your project.

[60s GIF]

https://github.com/passionworkeer/obsidian-shared-memory-bus
```

### 4.4 即刻 / V2EX 中文圈

#### 即刻
```
🌱 开源了一个新项目：obsidian-shared-memory-bus

解决"AI 工具换一次就要重新讲一遍项目"的痛点

特点：
- 完全本地（数据存在 ~/.ai-memory 和 Obsidian vault）
- MIT 协议
- 一个 npm 命令装好
- Claude Code / Codex / Cursor 共享同一份记忆

已经做 3 个月，6.9 万行代码，50+ 测试

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### V2EX
```
[开源] obsidian-shared-memory-bus - AI 工具的共享记忆层

技术栈：PowerShell + Node.js + Python
协议：MIT
安装：`npx @obsidian-shared-memory-bus/cli install`

解决痛点：
- Claude Code 切换到 Codex 时，AI 忘记所有项目历史
- 每次开新 session 都要重新讲架构
- 不同工具的"记忆"是隔离的

欢迎试用和反馈。
```

### 4.5 Phase 2 验收

- [ ] HN 首页停留 ≥ 4 小时
- [ ] 至少 1 个 Reddit 上 hot
- [ ] 当周新增 ≥ 150 star
- [ ] 当周 ≥ 10 个新 issue
- [ ] GitHub Trending（any language）上榜 1 次

---

## 5. Phase 2.5 · 二次传播（W7-W8）

> 目标：让 KOL 转载 + 视频扩散，从 200 → 500 星

### 5.1 KOL 联系邮件模板（5 套备选）

#### 邮件 A（痛点共鸣型）

**主题**：`Quick demo: Local-first AI memory for Claude Code (MIT, 3-month project)`

**正文**：
```
Hi [name],

I've been a long-time reader of your [blog/channel/newsletter]. I recently built
a local-first memory bus for AI coding tools (Claude Code, Codex, OpenCode,
Cursor) — basically solving the "AI forgets my project every session" problem,
but local + MIT (vs. claude-mem's AGPL).

I think it might resonate with your audience. 60-second demo:
[60s GIF link]

Happy to:
- Give you a 15-min walkthrough
- Provide a longer deep-dive if you want to feature it
- Send you swag (stickers, t-shirt) if you cover it

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

Best,
[your name]
```

#### 邮件 B（数据型）

**主题**：`I lost 10 hours/month to AI tool amnesia, so I built a fix`

**正文**：
```
Hi [name],

Quick stat from my dev log: 10 hours/month wasted re-explaining my project to
different AI tools. I built an open source fix:

- Local-first memory bus for Claude Code / Codex / Cursor
- 5-minute install
- MIT licensed
- 6.9k LOC, 50+ tests

[60s GIF]

If your audience uses multiple AI tools, this might be relevant.

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus
```

#### 邮件 C（合作型）

**主题**：`Open source project idea: cross-AI-tool memory bus`

**正文**：
```
Hi [name],

I noticed you've covered [related topic] recently. I built an open source
project in the same space: a local-first memory bus for AI coding tools.

Tech highlights:
- Cross-tool (Claude Code, Codex, OpenCode, Cursor)
- MIT vs claude-mem's AGPL
- Obsidian-native storage
- 5-tier memory model

Would you be interested in a collaboration? I'm thinking:
- Co-authored blog post
- Video walkthrough on your channel
- Joint Discord AMA

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

Let me know if this sounds interesting.
```

#### 邮件 D（极简型）

**主题**：`Local-first memory bus for AI tools (open source, MIT)`

**正文**：
```
Hi [name],

Quick note: I built an open source memory bus for AI coding tools (Claude Code,
Codex, Cursor). Local-first, MIT, 5-min install.

[60s GIF]

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

Cheers,
[your name]
```

#### 邮件 E（中文 KOL 专用）

**主题**：`开源项目：AI 工具的共享记忆层（MIT 协议，跨 Claude/Codex/Cursor）`

**正文**：
```
[名] 老师好，

我做了一个开源项目 obsidian-shared-memory-bus，是给 AI 编程工具（Claude Code、
Codex、OpenCode、Cursor）用的共享记忆层。完全本地、MIT 协议。

特点：
- 一个 npm 命令装好（5 分钟）
- 5 级记忆模型（event → archive）
- Obsidian vault 作为存储后端
- 6.9 万行代码，跨 PS/Node/Py 三语言

[60s GIF]

GitHub: https://github.com/passionworkeer/obsidian-shared-memory-bus

希望您能试用并给一些反馈 / 转发。

谢谢！
[你的名字]
```

### 5.2 视频内容规划

| 视频 | 时长 | 平台 | 目标 |
|---|---|---|---|
| 60s GIF（已完成） | 1 min | README / Twitter | 第一印象 |
| "How I built a memory bus for AI tools" | 15-20 min | YouTube + B 站 | 技术深度 |
| "MIT vs AGPL: Why this fork might matter" | 8 min | YouTube | 商业视角 |
| "5-tier memory model explained" | 5 min | 抖音 + YouTube Shorts | 概念科普 |
| 终端操作录屏（实操演示） | 3 min | Twitter / X | 转化 |
| "I built a Claude-Mem alternative" 对比 | 10 min | YouTube | 抢占搜索 |

### 5.3 深度博客选题（任选 1-2 篇）

#### 选题 1（技术深度）
**标题**：`Building a cross-tool memory bus: Why I chose Obsidian + BM25 + dense`

**大纲**：
1. 痛点：AI 工具的健忘问题
2. 方案选型：Obsidian + BM25 + Dense
3. 5-tier 内存模型设计
4. 跨语言一致性问题（LSH）
5. 性能 benchmark
6. 未来工作

**SEO 关键词**：ai memory, mcp, claude code memory, bm25, vector search

#### 选题 2（对比导向）
**标题**：`Why claude-mem's AGPL-3.0 might push you to MIT alternatives`

**大纲**：
1. AGPL-3.0 vs MIT 商业影响
2. claude-mem 的优势
3. 我们项目的差异化（MIT + 跨工具 + Obsidian）
4. 5-tier 模型详解
5. 性能对比
6. 选择建议

**SEO 关键词**：claude-mem, agpl-3.0, mit license, ai memory open source

#### 选题 3（概念科普）
**标题**：`5-tier memory architecture: How event/session/project/shared/archive work`

**大纲**：
1. 为什么需要多级 memory
2. 5-tier 详解
3. promotion 规则
4. 实现细节
5. 评测方法
6. 调优建议

### 5.4 Phase 2.5 验收

- [ ] 至少 1 个 KOL 主动转发
- [ ] 至少 1 个 ≥10min 深度视频发布
- [ ] 至少 3 篇技术博客发布
- [ ] 当周新增 ≥ 200 star（累计 500+）
- [ ] 至少 5 个新 contributor 提 PR

---

## 6. Phase 3 · SEO 长尾（W9-W10）

> 目标：抢关键词排名，建立长期被动流量入口

### 6.1 文档站建设（VitePress）

**技术选型**：VitePress（轻量、Vue 生态、SEO 友好）

**目录**：
```
docs-site/
├── .vitepress/
│   └── config.mts
├── index.md                # 首页
├── guide/
│   ├── quickstart.md       # 5 分钟上手
│   ├── install.md          # 全平台安装
│   ├── architecture.md     # 架构图
│   └── upgrade.md          # 升级指南
├── api/
│   ├── mcp-tools.md        # 32 个 MCP 工具
│   ├── embedding.md        # 4 个 embedding provider
│   └── cli.md              # CLI 命令参考
├── blog/
│   ├── 2026-07-01-v3-2-0-release.md
│   ├── 2026-07-15-cross-language-lsh.md
│   └── ...
├── changelog/
│   └── index.md
└── package.json
```

**自定义域名**：`docs.obsidian-shared-memory-bus.dev` 或 GitHub Pages 子路径

### 6.2 关键词占位（SEO）

**目标关键词**（按搜索量排序）：

| 关键词 | 月搜索量估计 | 目标排名 |
|---|---|---|
| `claude code memory` | 5000+ | Top 10 |
| `claude code persistent memory` | 3000+ | Top 5 |
| `local ai memory` | 2000+ | Top 10 |
| `obsidian ai integration` | 1500+ | Top 5 |
| `mcp memory server` | 1000+ | Top 3 |
| `codex memory layer` | 800+ | Top 3 |
| `claude-mem alternative` | 500+ | Top 3 |
| `agpl vs mit ai tools` | 300+ | Top 3 |
| `obsidian claude code` | 1500+ | Top 5 |
| `cross tool ai memory` | 200+ | Top 3 |

**占位策略**：
- 仓库 README + 文档站 + 博客 3 处重复
- GitHub Pages 自带 SEO 优势（域名权重高）
- 每个关键词对应一篇博客
- 在 GitHub README 加 canonical link 指向 docs site

### 6.3 Product Hunt 准备

| 资产 | 要求 | 准备时间 |
|---|---|---|
| Logo | 240x240 PNG | W9 |
| 截图 | 3-5 张 1270x760 | W9 |
| GIF | 1 个 ≤ 6s 动图 | W9 |
| 标题 | "Obsidian Shared Memory Bus" | W9 |
| Tagline | "Local-first memory layer for AI coding tools" | W9 |
| 描述 | 前 60 字符决定点击率 | W9 |
| Maker Comment | 主动 + 友善 + 邀请试用 | W9 |
| Hunters | 找 1-2 个 ph 朋友帮忙发 | W9 |
| 发布时间 | 周二-周三 太平洋 0:01 AM | W10 |

**Maker Comment 模板**：
```
Hey Product Hunt! 👋

I'm [name], solo developer of obsidian-shared-memory-bus.

Why I built this: I kept switching between Claude Code, Codex, and Cursor,
and each tool had amnesia about my project. I'd waste 30 min explaining
architecture every morning.

This bus gives all my AI tools the same memory, stored locally in my Obsidian
vault. MIT licensed (vs. claude-mem's AGPL-3.0).

Looking for honest feedback from PH community. AMA!
```

### 6.4 其他目录站

- **Launching Next**：3 段产品介绍 + 一句 tagline
- **BetaList**：等 PH 之后 1 周
- **DevHunt**：开发向
- **OSCHINA**（中文）：简短介绍 + 链接
- **HelloGitHub**（中文）：投稿格式
- **GitHubDaily**（中文）：投稿格式

### 6.5 Phase 3 验收

- [ ] docs.obsidian-shared-memory-bus.dev 上线
- [ ] 至少 5 篇博客带 SEO 关键词
- [ ] Product Hunt 上榜（Top 10 of the day 即胜利）
- [ ] Google Search Console 显示 3+ 关键词 Top 20

---

## 7. Phase 3.5 · 飞轮（W11-W12）

> 目标：建立可持续社区，从 500 → 1,000 星

### 7.1 Contributor 招募

把 `tech-debt-roadmap.md` 的 7 个 P0/P1 债项开成 GitHub Issue：

**Issue 模板（`good first issue`）**：

```markdown
## Title
[Refactor] Extract manifest-loader.js from omni-memory-server.js

## Description
We have a 1447-line `omni-memory-server.js` that's becoming a God server.
The first step in our 3-week split refactor is to extract manifest loading
into its own module.

## Scope
- Create `shared-mcp/manifest-loader.js` (≤ 200 lines)
- Add unit tests in `tests/unit/shared-mcp/manifest-loader.test.js`
- Update `omni-memory-server.js` to import from new module

## Acceptance Criteria
- [ ] `manifest-loader.js` exists and is ≤ 200 lines
- [ ] All manifest fields loadable via the new module
- [ ] 100% unit test coverage of new module
- [ ] No behavior change in `omni-memory-server.js`
- [ ] CI green

## Time Estimate
2-3 days

## Difficulty
Easy-Medium

## Mentorship
- I'll personally review your PR within 24h
- Pair programming session available on request

## Reward
- First merged PR in this series → triage permissions
- Co-author credit in v3.2.0 release notes

## Related Docs
- `docs/architecture/SERVER-SPLIT.md` (will be created in PR-1.4)
- Roadmap: see `tech-debt-roadmap.md` in repo root
```

### 7.2 GitHub Projects 看板

```
Backlog  →  In Progress  →  In Review  →  Done
   │            │              │            │
   7 issues    1-2 active    PR reviews   v3.2.0 stable
```

### 7.3 社区运营

- **Discord 服务器**（小而精，~50 人 MVP）
  - #general
  - #help
  - #show-and-tell
  - #announcements
  - #random
- **GitHub Discussions** 每周回 ≥3 个 issue
- **Twitter 周更** 1 条工程进度
- **Newsletter 月发** 1 次（用 Substack / Revue）

### 7.4 月度发布节奏

- 每月 1 号发 minor 版本（v3.3.0、v3.4.0）
- 每月 15 号发 patch 版本（v3.3.1、v3.3.2）
- 每月 1 篇深度博客
- 每月 1 个 YouTube 视频

### 7.5 Phase 3.5 验收

- [ ] 至少 5 个新 contributor 提了 PR
- [ ] 月度发布节奏稳定
- [ ] 社区 ≥ 100 人（GitHub + Discord + Twitter 合计）
- [ ] 仓库达到 1,000 star

---

## 8. 关键素材清单（提前准备）

| 素材 | 优先级 | 何时需要 | 当前状态 |
|---|---|---|---|
| 60s demo GIF | 🔴 P0 | W1 | ❌ 待做 |
| 5min 完整视频 | 🟡 P1 | W4 | ❌ 待做 |
| Logo（512x512 + 128x128） | 🔴 P0 | W1 | ❌ 待做 |
| 社交预览图（1280x640） | 🔴 P0 | W1 | ❌ 待做 |
| README 中英双语 | 🔴 P0 | W1 | ❌ 待做 |
| npm 包 `@obsidian-shared-memory-bus/cli` | 🔴 P0 | W2 | ❌ 待做 |
| 文档站 docs.obsidian-shared-memory-bus.dev | 🟡 P1 | W9 | ❌ 待做 |
| Product Hunt 资产 | 🟡 P1 | W10 | ❌ 待做 |
| 3 篇技术博客 | 🟡 P1 | W7-W10 | ❌ 待做 |
| 1 篇对比 claude-mem 的深度文 | 🟢 P2 | W8 | ❌ 待做 |
| Discord 服务器 | 🟡 P1 | W4 | ❌ 待做 |
| Twitter 账号 | 🔴 P0 | W1 | ❌ 待做 |

---

## 9. 渠道优先级矩阵

| 渠道 | 触达 | 转化率 | 投入 | ROI | 推荐顺序 |
|---|---|---|---|---|---|
| **Hacker News Show** | 50K-200K | 1-3% | 低 | ⭐⭐⭐⭐⭐ | #1 |
| **awesome-mcp-servers** | 长尾 | 5-10% | 极低 | ⭐⭐⭐⭐⭐ | #1 |
| **YouTube 深度视频** | 10K-100K | 1-5% | 高 | ⭐⭐⭐⭐ | #2 |
| **Reddit** | 5K-30K | 1-3% | 低 | ⭐⭐⭐⭐ | #2 |
| **Product Hunt** | 20K-100K | 1-2% | 中 | ⭐⭐⭐⭐ | #2 |
| **技术博客** | 长尾 | 2-5% | 高 | ⭐⭐⭐⭐ | #3 |
| **Twitter / X** | 1K-10K | 1-3% | 中 | ⭐⭐⭐ | #3 |
| **Discord / 微信群** | 200-2K | 10-30% | 高 | ⭐⭐⭐ | #3 |
| **付费广告** | 任意 | <1% | 高 | ⭐ | 暂不做 |

---

## 10. 关键风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| HN 帖被 downvote 沉底 | 中 | 高 | 周一周二提前 24h 收集"早期 upvote" 朋友圈 |
| claude-mem 维护者直接竞争 | 中 | 高 | 主动 DM 提"MIT 协议双向兼容"避免冲突 |
| KOL 不回复 | 高 | 中 | 一次发 10 人，预期 1-2 人回复 |
| 安装问题暴露，影响口碑 | 高 | 高 | Phase 1.5 内部测试 10+ 用户 |
| 服务器被刷爆流量 | 低 | 中 | 文档站放 Cloudflare 缓存 |
| 单人精力耗尽 | 中 | 高 | 招 1-2 个 co-maintainer（在 Phase 1 同步） |
| PH 帖被埋没 | 中 | 中 | 找 2 个 PH 朋友当 hunter 同步发 |
| 法律问题（AGPL 衍生作品争议） | 低 | 中 | 律师 review + 协议不混用 |

---

## 11. 12 周时间线（甘特图）

```
W1  ▓▓▓ README 重构 ▓▓▓   ░░░░ Logo ░░░░   ░░ npm 包 ░░
W2  ▓▓▓ README 双语 ▓▓▓   ░░ 60s GIF ░░    ░░ npm 完善 ░░
W3  ░░ 内测 10 人 ░░      ░░ awesome PR ░░
W4  ░░ 修复 + RC ░░       ░░ v3.2.0 ░░
W5  ★ HN Show ★           ░░ Reddit × 3 ░░
W6  ░░ 即刻/V2EX ░░       ★ PH 准备 ★
W7  ░░ KOL 邮件 × 10 ░░   ░░ 深度视频 1 ░░
W8  ░░ 视频扩散 ░░        ░░ 博客 × 3 ░░
W9  ░░ docs 站 ░░         ░░ SEO 博客 ░░
W10 ★ Product Hunt ★      ░░ HelloGitHub ░░
W11 ░░ contributor ░░     ░░ 看板 ░░
W12 ░░ 月度发布 ░░        ░░ 复盘 ░░

★ 关键节点    ▓ Phase 1    ░ 持续推进
```

---

## 12. 关键指标仪表盘（每周追踪）

| 指标 | 来源 | 关注点 | 目标 W12 |
|---|---|---|---|
| **GitHub Star** | repo page | 周增速 | 1,000 |
| **Forks** | repo page | 实际部署信号 | 80 |
| **npm 下载** | npmjs.com | `npx` 安装量 | 5,000/周 |
| **PyPI 下载** | pypistats.org | 检索 worker 安装量 | 1,000/周 |
| **GitHub Issues** | repo | 用户活跃度 | 50 |
| **Discussions** | repo | 社区质量 | 30 |
| **HN/Reddit 浏览** | 后台 | 渠道效果 | 10K/单帖 |
| **YouTube 观看** | Studio | 视频 ROI | 5K/视频 |
| **docs 站 PV** | Plausible | SEO 效果 | 3K/周 |
| **Discord 成员** | Discord | 社区增长 | 100 |
| **Twitter 关注** | Twitter | 影响力 | 500 |
| **Contributors** | repo | 社区健康 | 12 |

---

## 13. 12 周后：长期增长（2026-Q3 以后）

如果 12 周达到 1,000 星，下一阶段目标 5,000 星：

1. **国际化**：日文 / 韩文 / 西语 / 德语 README（每种 ≥ 30% 翻译）
2. **视频化**：YouTube 频道周更（教程 + deep dive）
3. **企业版**：Sponsors tier 推 GitHub Sponsors（$5/月 - $100/月）
4. **插件生态**：开放 SDK，让第三方接入（如 Obsidian 插件）
5. **认证 / 培训**：B 站 / 慕课网 开付费课程（次要收入）
6. **行业活动**：参加 PyCon / Node.js Conf / KubeCon 演讲
7. **企业咨询**：卖给企业培训 / 内部知识库场景

---

## 附录 A · 关键话术库（20+ 条）

### A.1 一句话介绍（不同场景）

| 场景 | 文案 |
|---|---|
| **Twitter bio** | "Local-first AI memory for Claude Code/Codex/Cursor. MIT, MCP-native. 🚀" |
| **HN 标题** | "Show HN: Obsidian Shared Memory Bus – Local-first AI memory for Claude/Codex/Cursor" |
| **Reddit 标题** | "I built a local-first memory bus for AI coding tools (MIT, 3-month project)" |
| **中文朋友圈** | "做了一个开源工具，让 Claude/Codex/Cursor 共享同一份项目记忆，完全本地 MIT" |
| **Discord 简介** | "Local-first AI memory bus · MIT · Cross-tool · 5-tier model" |
| **邮件签名** | "[Name] · Creator of obsidian-shared-memory-bus · github.com/passionworkeer" |
| **Product Hunt 标题** | "Obsidian Shared Memory Bus" |
| **PH Tagline** | "Local-first memory layer for AI coding tools" |
| **LinkedIn 标题** | "Building open-source AI memory infra · MIT · 1k stars in 12 weeks" |
| **微信群公告** | "🌱 内测招募：AI 工具共享记忆 bus，5 分钟装好" |

### A.2 痛点话术

| 痛点 | 话术 |
|---|---|
| **重复解释项目** | "Stop explaining your project to AI tools every morning" |
| **切换工具失忆** | "Switched from Claude to Codex? It forgot everything." |
| **多个工具记忆割裂** | "Claude knows X, Codex knows Y, neither knows Z" |
| **云端记忆不安全** | "Your code context should not leave your machine" |
| **商业协议受限** | "AGPL-3.0 makes commercial use a legal headache" |
| **找不到之前的工作** | "Where did I put that architecture decision?" |
| **每次 session 重讲** | "30 minutes explaining what 5 lines of code could say" |
| **团队记忆分裂** | "Bob's Claude and Alice's Cursor have different memories" |

### A.3 解决方案话术

| 卖点 | 话术 |
|---|---|
| **1 行安装** | "npx install, 5 minutes, done" |
| **本地优先** | "100% local. Your code stays on your disk." |
| **MIT 协议** | "MIT licensed. Use it in commercial projects without worry." |
| **跨工具** | "One memory, shared by Claude, Codex, OpenCode, Cursor." |
| **Obsidian 集成** | "Your Obsidian vault is the database. Browse memories in your favorite tool." |
| **5-tier 模型** | "5-tier memory (event → archive) so context is always relevant." |
| **混合检索** | "BM25 + dense vectors + MMR reranking. Best of all worlds." |
| **3 个月成熟** | "3 months of solo work. 6.9k LOC, 50+ tests, 37 docs." |

### A.4 竞品对比话术

> claude-mem 是 Claude 生态的优秀方案，AGPL-3.0 对个人开发者友好。
> **本项目**与它的核心差异：

| 维度 | claude-mem | 本项目 |
|---|---|---|
| **协议** | AGPL-3.0（商业受限） | **MIT**（商业友好） |
| **工具支持** | 仅 Claude | Claude + Codex + OpenCode + Cursor + Windsurf |
| **存储后端** | SQLite + Chroma | **Obsidian vault**（可视化浏览） |
| **记忆模型** | 平铺 | **5-tier 显式分级** |
| **安装** | 1 行 npx | 1 行 npx |
| **星数** | 89K | 起步 |
| **License** | AGPL-3.0 | MIT |

### A.5 紧急 / 风险话术

| 场景 | 话术 |
|---|---|
| **应对 claude-mem 攻击** | "We love claude-mem and learned a lot from it. We're MIT-licensed and Obsidian-native, which addresses a different use case." |
| **应对 bug 报告** | "Thanks for the report. We're investigating. Will update within 24h." |
| **应对负面评论** | "Fair point. We're [doing X to address this]. Open to suggestions." |
| **应对"为什么不直接用 claude-mem"** | "If AGPL works for you and you only use Claude, claude-mem is great. We're for the MIT / multi-tool / Obsidian niche." |
| **应对"为什么不用 SQLite"** | "Obsidian vault gives us visual browsing, plain-text search, and OSS ecosystem." |

---

## 附录 B · 与技术债修复的耦合

| 时间点 | 技术债动作 | 宣传动作 |
|---|---|---|
| W1 | README 重构 | 准备 demo GIF |
| W2 | npm 包发布 | 1 行安装落地 |
| W3-W4 | 收内测反馈 + 修 bug | 5 个 awesome PR |
| W5 | v3.2.0 stable | HN Show |
| W8 | God Server 拆分完成 | KOL 转发素材 |
| W12 | ANN 检索完成 | docs 站上线 |

**重要约束**：**不要在技术债修复完成前做大规模宣传**，否则会因 bug 流失用户口碑。

## 附录 C · 失败后的回退方案

如果 12 周后 < 500 星，**不一定是失败**，可能需要：

1. **重新评估产品定位**：可能"跨工具共享记忆"是伪需求，claude-mem 单工具版本占主导
2. **收窄定位**：专注"Obsidian 用户" + "Claude + Cursor" 双工具
3. **转型 B2B**：卖给企业培训 / 内部知识库场景
4. **合并上游**：尝试给 claude-mem 提 PR 贡献 memory tier 模型，搭车推广
5. **暂停增长**：先把产品做到 v4.0 再推
6. **Pivot 到 SaaS**：提供 hosted 版本（个人 $5/月，团队 $20/月）

## 附录 D · 周复盘模板

```markdown
# Week X Retrospective (2026-MM-DD)

## 本周数据
- Star: X → Y (+Z)
- Forks: X → Y (+Z)
- npm downloads: X/周
- Contributors: X → Y
- New issues: X
- Discussions: X

## 本周完成
- [x] 任务 1
- [x] 任务 2
- [x] 任务 3

## 本周未完成 / 受阻
- [ ] 任务 4 (原因：xxx)

## 关键洞察
- 洞察 1
- 洞察 2

## 下周计划（3 件最重要的事）
1. 任务 A
2. 任务 B
3. 任务 C

## 需要的帮助
- 帮助 1
- 帮助 2
```

## 附录 E · 行动 Checklist（W1 立即开干）

- [ ] 录 60s demo GIF
- [ ] 重写 README（第一屏 30 秒能懂）
- [ ] 发布 npm 包 `@obsidian-shared-memory-bus/cli`
- [ ] 设计 Logo + 社交预览图
- [ ] 开启 GitHub Discussions
- [ ] 提 5+ awesome 列表 PR
- [ ] 写 v3.2.0 changelog
- [ ] 准备 HN 标题 3 个版本 + 正文 3 个版本
- [ ] 创建 Twitter 账号并发首条
- [ ] 创建 Discord 服务器并邀请 5 个朋友

**本周末之前**完成这 10 件事，下周一启动内测招募。

---

## 附录 F · 关键 SLA / 服务等级承诺

为 contributor 和用户做出公开承诺：

| 指标 | 目标 |
|---|---|
| **Issue 首次响应** | ≤ 24 小时 |
| **Bug fix 关闭** | P0 ≤ 7 天 / P1 ≤ 30 天 |
| **PR review** | ≤ 3 天 |
| **月度发布** | 每月 1 号 minor，15 号 patch |
| **Security 响应** | ≤ 48 小时 |
| **Breaking change 提前通知** | 1 个 minor 版本提前 |

写在 README 的 "Maintainer SLA" 章节，让社区知道这是受尊重的项目。
