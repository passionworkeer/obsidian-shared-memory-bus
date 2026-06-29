# 你的 Claude、Cursor、Kiro，能不能共用同一份记忆？

> 当你同时用 5 个 AI 编程工具，光是把"这是个 Next.js 项目，用 pnpm，数据库在 Supabase"解释 5 遍，就够你崩溃的了。

## 一个真实的崩溃时刻

设想这样一个下午：

你打开 Cursor 写前端，告诉它"这是 monorepo，包管理用 pnpm，后端在 `apps/api`"；切到 Claude Code 重构后端，又得把这套上下文再说一遍；打开 Kiro 想让它写测试，它对你项目的依赖关系一无所知。每个工具都有自己的"大脑"，但它们彼此隔绝——你花在重复解释上下文上的时间，甚至比写代码还多。

更扎心的是，这些记忆还都不互通。你在 Claude Code 里摸清的那个边界 case、那次踩过的坑、那条"千万别动 `legacy/` 目录"的约定，换个工具就全没了。

这不是某个工具的 bug，是整个 AI 编程生态的结构性缺陷：**每个 agent 各记各的，没有共享记忆层**。

## 解决方案：一个本地优先的共享记忆总线

[**local-ai-memory-bus**](https://github.com/passionworkeer/local-ai-memory-bus) 想做的事很简单——

**让所有 AI 编程工具共用同一个本地记忆后端。一次写入，处处可读；数据在本地，不传云。**

它的定位不是"又一个 AI 记忆框架"，而是填补一个具体的赛道空白：**本地优先、零依赖、原生中文、能被动同步闭源工具的共享记忆总线**。

一句话：clone 下来就能跑，不装数据库、不连云、不配 Docker，5 分钟让你的 8 个 AI 工具共享一份记忆。

## 五个核心特性，每一个都对应一个真实痛点

### 1. 零依赖文件存储——这是和同类项目最大的区别

调研过 mem0、Zep、Letta·MemGPT、Cognee、A-MEM 这类记忆框架的人都知道，它们大多背着一整套基础设施：Postgres 存元数据、Neo4j 做知识图谱、Redis 当缓存、还得跑个 Docker Compose。光是把环境跑起来，半天就过去了。

local-ai-memory-bus 用纯 JSONL 文件做存储。没有数据库、没有云服务、没有外部 API。**`git clone` + `npm install` + `node start.js`，三条命令跑起来。** 你的记忆就是磁盘上几个明文文件，能用 `cat` 看、能用 `grep` 搜、能纳入 git 版本管理。

代价是什么？超大规模数据下的查询性能不如专业数据库。但对个人开发者和中小团队的 AI 记忆场景（几千到几万条记录），这恰恰是最务实的取舍。

### 2. 原生中文检索——jieba 分词 + 中英混合 BM25

这对国内开发者是个硬痛点。很多海外记忆框架默认英文分词，中文 query 直接退化成"按空格切"。搜"用户登录态怎么维护"，它给你切成 `用`、`户`、`登`、`录`……召回质量惨不忍睹，只能靠翻译成英文再搜来"曲线救国"。

本项目用 jieba 做中文分词，BM25 支持中英混合文本，无需任何翻译降级。中文技术文档、中文注释、中英夹杂的代码，都能直接检索。

### 3. 六层记忆分层（L0–L5）——业界最细的记忆模型

记忆不是铁板一块，它有时间尺度和重要性梯度。本项目把记忆分成六层：

| 层级 | 角色 | 生命周期 |
|------|------|----------|
| L0 Working | 当前会话工作内存 | 进程内 |
| L1 Session | 短时记忆 | 7 天滚动 |
| L2 Essential | 关键项目信息 | 持久 |
| L3 Durable | 长期知识库 | 持久 |
| L4 Reference | 参考文档 | 持久 |
| L5 Archive | 归档（退出向量空间） | 冷存储 |

记忆会逐层"晋升"和"遗忘"——高频访问的升到上层，老旧不用的下沉归档。这比"一股脑全塞进一个向量库"的方案更接近人类记忆的工作方式，也更省检索成本。

对比同类项目：mem0 的分层较粗，Cognee 侧重知识图谱而非时间分层。**六层是当前开源记忆方案里最细的颗粒度。**

### 4. 被动同步闭源工具——watchdog 观察者模式

这是技术上最有意思的一块。

Cursor、Kiro 这些工具是闭源的，你没法让它们主动调用你的记忆 API。怎么办？本项目用 **watchdog 文件观察者**：后台监听这些工具自己的记忆/配置文件变化，一旦它们写入新内容，watchdog 自动把内容抽取、归一化、并入共享记忆。

闭源工具什么都不用配合，你什么都不用改——这就是"被动同步"的含义。你在 Cursor 里学到的项目约定，会自动流到共享记忆里，Claude Code 下次开会话就能读到。

### 5. 多 embedding 后端——从离线到云端可切换

向量嵌入不绑死单一方案：

- **本地 hash**（默认）：LSH 哈希，完全离线，零 API 依赖
- **HuggingFace**：Sentence Transformers 本地模型
- **OpenAI 兼容**：任何 OpenAI 格式的 embedding API
- **Gemini**：Google 嵌入

默认本地 hash 意味着**断网也能用**，这又是一个"本地优先"的体现。要追求语义质量，再切到 transformer 或 API 即可。

## 快速开始：npx 一键启动

```bash
# 启动 MCP 服务器（双击 start.bat 或命令行）
npx local-ai-memory-bus

# 接入你的 AI 工具（自动检测并写入对应配置）
npx local-ai-memory-bus setup --target=claude      # 单个工具
npx local-ai-memory-bus setup --target=all         # 一次接入全部 8 个
```

支持的 8 个 agent：**Claude Code/Desktop、Cursor、Kiro、Windsurf、Cline、Roo Code、Goose、Qoder**。新增一个 agent 只需要在 `setup-mcp.js` 的 `AGENT_REGISTRY` 里加一行——配置路径、格式、入口形状写清楚，剩下全自动。

不想直接写配置？先 `--dry-run` 预览将要改动的内容：

```bash
npx local-ai-memory-bus setup --target=cursor --dry-run
```

重启对应 AI 工具，它就能调用同一份共享记忆了。

## 技术亮点：给开发者看的部分

如果你是开发者，下面几点值得细看。

### MCP 协议是底座

整个项目构建在 [Model Context Protocol](https://modelcontextprotocol.io/)（MCP）之上。截至 2026 年，MCP 已是 AI 工具生态的事实标准——SDK 月下载量达 9700 万，主流编程工具几乎全部支持。这意味着任何 MCP client 都能零适配接入本项目的记忆服务。本项目的 memory server 跑在 `http://127.0.0.1:9338/mcp`，提供 28 个工具。

### 混合检索 + RRF 融合

检索不是单一算法，而是 BM25（关键词）+ 语义向量的混合：

- **默认 weighted 加权融合**：安全回退，无额外依赖
- **可选 RRF（Reciprocal Rank Fusion）**：`AI_MEMORY_FUSION=rrf` 启用，从已有 rank 反推融合，不改上游打分——这是检索领域的成熟 SOTA 做法

配套 `retrieval/eval/ndcg_benchmark.py`，自实现 NDCG@5 / Recall@10 / MRR 三项指标，可以量化评估融合策略的收益。

> 诚实说明：当前默认的本地 hash embedding 是纯哈希、不带语义，"混合检索"的语义部分还偏弱。这是项目当前最大的质量空白，路线图上排了接入 bge-reranker-v2-m3 做精排。但 BM25 + 中文分词的部分是实打实可用的，对于结构化、关键词明确的查询效果良好。

### Vault 自动发现（store/vault 统一）——本轮关键突破

之前版本有个让人头疼的问题：检索入口默认读一个本地空数据目录（`~/.ai-memory`，只有十几条自举示例），而真正的几万条记忆存在 Obsidian vault 里——两者语义分裂，导致"开箱检索为空"。

本轮做了一次端到端修复：检索系统现在按统一优先级解析 canonical store——

```
AI_MEMORY_STORE (显式覆盖)
    ↓ 未设则
Obsidian vault 的 00-System/ai-memory  ← 自动读 obsidian.json 发现任意盘 vault
    ↓ 未找到则
AI_MEMORY_ROOT
    ↓
~/.ai-memory (兜底)
```

实测效果：**默认配置（零环境变量）下，检索召回率从 0.0 提升到 0.94**，多个 query 的 NDCG@5=1.0、MRR=1.0。`search_shared_memory` 通过 MCP 返回 vault 真实数据（entryCount 143，score 1.015 / 0.999 / 0.971）。

> 另一个诚实说明：项目里有 `memory_search` 和 `search_shared_memory` 两个检索工具，容易混淆。**`search_shared_memory` 才是语义检索**（走 worker pool + Python，读 vault canonical 数据）；`memory_search` 是 BM25 项目工具，读 `projects/*.jsonl`，vault 里没有 projects 数据时返回空是设计行为，不是 bug。文档里对这一点做了醒目区分，避免新用户踩坑。

### 工程质量：1300 测试全绿

- JS 单元测试：718 个
- Python 测试：582 个
- **合计 1300，0 fail 0 skip**

本轮实测还顺手修了 4 个 Windows 致命启动 bug——之前 memory server 在 Windows 上根本起不来，连测试都没覆盖到端到端启动路径。现在端到端跑通：MCP 协议握手、工具列表、语义检索全链路验证。

## 差异化定位：它不是又一个 mem0

再强调一次，本项目的位置很明确——

| 维度 | local-ai-memory-bus | mem0 / Zep / Letta | Cognee |
|------|--------------------|--------------------|--------|
| 存储 | 纯 JSONL 文件 | Postgres + 向量库 | Postgres + Neo4j |
| 中文 | 原生 jieba | 多需翻译降级 | 弱 |
| 同步闭源工具 | watchdog 被动同步 | 需工具主动调用 | 需主动调用 |
| 记忆分层 | 6 层（L0–L5） | 较粗 | 偏图谱 |
| 启动成本 | clone 即用 | Docker Compose | 多依赖 |

如果你要的是"企业级、云端、图谱化"的记忆平台，mem0 和 Cognee 是更好的选择。但如果你是**个人开发者或小团队、用多个 AI 编程工具、想要本地可控、原生中文、5 分钟接入**的共享记忆——本项目目前是这个细分位置上几乎唯一的选择。

## 开源，MIT 协议，欢迎来 star 和贡献

项目完全开源，MIT 协议，仓库地址：

**https://github.com/passionworkeer/local-ai-memory-bus**

代码不藏私，文档不夸大——上面提到的"hash embedding 语义偏弱""reranker 还没接"这些限制，都明明白白写在路线图里。比起一个"看起来无所不能"的 demo，我更想要一个"知道自己在哪、要往哪走"的工程。

**如果你也被多个 AI 工具各记各的记忆折磨过，欢迎来 star 支持。** 也欢迎提 Issue 反馈你的接入场景、提 PR 接入更多 agent——前面说过，加一个 agent 只需在 `AGENT_REGISTRY` 里加一行。

本地优先，原生中文，多工具共享记忆。

**这一次，让你的 AI 工具们，长出同一块记忆。**
