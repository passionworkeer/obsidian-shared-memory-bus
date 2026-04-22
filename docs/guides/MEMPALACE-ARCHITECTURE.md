# MemPalace 记忆框架架构详解

> 项目来源：https://github.com/milla-jovovich/mempalace
> 分析日期：2026-04-11
> 目的：深入理解 MemPalace 的记忆实现机制，为 Obsidian Shared Memory Bus 的架构演进提供参考

---

## 1. 项目定位与核心哲学

MemPalace 是一个**本地优先（Local-First）、零 API 依赖**的 AI 记忆系统。它为 AI 助手（Claude Code、ChatGPT、Codex 等）提供持久化、可搜索的记忆能力，所有数据存储在用户本机。

### 1.1 核心哲学：原文存储，永不摘要

与许多将对话压缩为摘要的记忆系统不同，MemPalace 的默认策略是：

- **Verbatim Storage**：对话和项目文件原文存入，不做 summarization
- **分段管理**：大文件切成 800 字符块（抽屉），保留原文以便将来按需检索
- **按需压缩**：仅在 L2 层使用 AAAK 有损格式做上下文压缩，作为 AI 唤醒时的快速引导

这一哲学直接影响了其存储层设计（ChromaDB）和知识图谱策略（关系三元组 + 时间有效性）。

### 1.2 与 Obsidian Shared Memory Bus 的本质区别

| 维度 | MemPalace | Obsidian Shared Memory Bus |
|------|-----------|--------------------------|
| **规范存储** | ChromaDB + SQLite | 本地 `.ai-memory` store + JSONL |
| **知识结构化** | 内置三元组知识图谱（有时间维度） | 依赖 KG + JSONL schema 约束 |
| **摘要格式** | AAAK 符号化格式（~30x 压缩） | AUTO-DREAM / GLOBAL-CONTEXT JSON |
| **多工具共享** | MCP 单服务器（无 watchdog 跨源同步） | Shared MCP + Watchdog 多源同步 |
| **向量检索** | 内置 ChromaDB（开箱即用） | Python 混合检索（BM25 + dense） |
| **外部数据源** | 项目文件 + 对话导出 | claude-mem + OpenClaw + 多源导入 |
| **中文支持** | 无内置 | jieba 分词支持 |
| **安装复杂度** | 极简（chromadb + pyyaml） | 复杂（PowerShell + Node.js + Python） |
| **Obsidian 依赖** | 无 | 无（纯本地文件系统） |

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                      USER / AI AGENT                       │
│           (Claude Code / ChatGPT / Codex 等)              │
└───────────────────────┬──────────────────┬───────────────┘
                        │                  │
                        ▼                  ▼
               ┌─────────────┐    ┌──────────────────────┐
               │   CLI       │    │  MCP Server (19工具)  │
               │  init/mine │    │  + WAL 审计日志       │
               │  search    │    │  + Palace Protocol    │
               │  compress  │    │    内嵌协议指南        │
               └──────┬──────┘    └──────────┬───────────┘
                     │                      │
                     └──────────┬────────────┘
                                ▼
                    ┌─────────────────────┐
                    │   4层记忆栈 (L0-L3)  │
                    ├─────────────────────┤
                    │ L0: Identity         │
                    │ L1: Essential Story  │
                    │ L2: On-Demand       │
                    │ L3: Deep Search     │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
      ┌───────────────┐              ┌────────────────────────┐
      │   ChromaDB    │              │       SQLite          │
      │   Palace     │              │   Knowledge Graph      │
      │  (向量存储)   │              │   (三元组关系)          │
      └───────────────┘              └────────────────────────┘
```

---

## 3. 核心概念：宫殿结构（Palace Metaphor）

MemPalace 用"宫殿"隐喻组织记忆，对应三级层级：

```
WING（翼）    →  ROOM（房间）    →  DRAWER（抽屉）
 人 / 项目         主题 / 方面        原文文本块
```

### 3.1 Wing（翼）

最顶层组织单元，通常对应：
- **人物**：`wing: user_Alice`
- **项目**：`wing: project_MemPalace`
- **主题**：`wing: personal`

### 3.2 Room（房间）

第二层，按话题/方面划分：

```
MemPalace
  ├── backend     (ChromaDB / SQLite 等)
  ├── frontend    (UI / CLI 界面)
  ├── architecture (设计决策)
  └── testing     (测试策略)
```

Room 的来源：
- 从 onboarding 时用户定义
- 从文件夹结构自动推断（`room_detector_local.py`）
- 从文件名/内容关键词匹配

### 3.3 Drawer（抽屉）

最小存储单位，对应 ChromaDB 中的一个向量条目：
- **大小**：800 字符原文块（`chunk_size=800`）
- **重叠**：相邻块间 100 字符重叠（`chunk_overlap=100`）
- **原文**：完全保留原始文本，不摘要
- **元数据**：`{wing, room, source_file, chunk_index}`

---

## 4. 存储层：双数据库架构

### 4.1 ChromaDB 向量库（Palace Store）

**路径**：`~/.mempalace/palace/`

**Collection**：`mempalace_drawers`

**每个 Drawer 的结构**：
```json
{
  "id": "uuid-v4",
  "embedding": [0.123, -0.456, ...],  // 1536维向量（text-embedding-3-small）
  "document": "这里存储的是原文，800字符...",
  "metadata": {
    "wing": "MemPalace",
    "room": "backend",
    "source_file": "/path/to/chromadb_setup.py",
    "chunk_index": 3,
    "mtime": "2026-04-10T12:00:00Z"
  }
}
```

**检索语义**：
- 使用语义相似度（cosine similarity）搜索
- 可按 `wing` / `room` 过滤
- 支持 `where` 子句元数据过滤

### 4.2 SQLite 知识图谱（Knowledge Graph）

**路径**：`~/.mempalace/knowledge_graph.sqlite3`

**Schema**：

```sql
-- 实体表
CREATE TABLE entities (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT,           -- 'person' / 'project' / 'concept'
  properties   TEXT,           -- JSON: {aliases: [...], context: "..."}
  created_at   TEXT
);

-- 三元组表
CREATE TABLE triples (
  id           INTEGER PRIMARY KEY,
  subject      TEXT NOT NULL,
  predicate    TEXT NOT NULL,
  object       TEXT NOT NULL,
  valid_from   TEXT,           -- ISO date: "2015-04-01"
  valid_to     TEXT,           -- NULL = 永久有效
  confidence   REAL DEFAULT 1.0,
  source_closet TEXT,          -- 来源 wing
  source_file  TEXT
);
```

**时间有效性**：
```python
# 示例：Alice 的孩子
("Max", "child_of", "Alice", valid_from="2015-04-01")
# 示例：Max 的担忧（已过期）
("Alice", "worried_about", "Max injury", valid_from="2026-01", valid_to="2026-02")
# 示例：项目实现（永久有效）
("MemPalace", "implements", "knowledge_graph", confidence=0.95)
```

**时间过滤查询**：
```python
# 查询 2026-01-01 时 Alice 的所有三元组
SELECT * FROM triples
WHERE subject = 'Alice' OR object = 'Alice'
  AND (valid_from IS NULL OR valid_from <= '2026-01-01')
  AND (valid_to IS NULL OR valid_to >= '2026-01-01');
```

---

## 5. 4 层记忆栈

```
┌─────────────────────────────────────────────────────┐
│  L0  Identity           ~100 tokens   用户手写        │
│  L1  Essential Story    ~500-800t     自动生成摘要    │
│  L2  On-Demand         ~200-500t/个  按需加载        │
│  L3  Deep Search        无限制       ChromaDB 全量    │
└─────────────────────────────────────────────────────┘
```

### 5.1 L0: Identity（身份层）

- **存储位置**：`~/.mempalace/identity.txt`
- **内容**：用户手写的纯文本自我介绍
- **格式**：
  ```
  I am Atlas, a personal AI assistant for Alice.
  My owner is Alice. Her husband is Jordan.
  Their children are Max (born 2015) and Lily (born 2018).
  ```

### 5.2 L2: On-Demand（按需层）——AAAK 格式

详见第 6 节。

### 5.3 L3: Deep Search（深层搜索）

- **存储**：ChromaDB 中的全量 drawer
- **触发**：当 L0/L1/L2 无法满足时
- **特点**：可返回原文 + 相似度分数

### 5.4 对比 OSMB 的分层

| 层 | MemPalace | OSMB |
|----|-----------|------|
| 身份 | `identity.txt` (手写) | `L0-bootstrap.md` (store) |
| 核心事实 | L1 Essential Story (自动生成) | `GLOBAL-CONTEXT.md` (生成) |
| 按需加载 | L2 AAAK (按 wing/room) | `HANDOFF.json` / `MEMORY-LAYERS.json` |
| 全量搜索 | L3 ChromaDB | JSONL + BM25/dense |

---

## 6. AAAK 压缩格式

**AAAK**（Agent-to-Agent Abstraction Knowledge）是一种 MemPalace 自创的**有损摘要格式**，用于 L2 层压缩，使 AI 能在有限上下文内快速获取背景信息。

### 6.1 核心标记

```
★         重要性星级（★ 到 ★★★★★）
★★        高重要性
ALC       实体代码（3字母大写 = Alice）
JOR       Jordan
RIL       Lily
*warm*    情感标记
*raw*     脆弱情绪
*bloom*   成长情绪
FAM:      家庭域
PROJ:     项目域
hall_     主题域前缀
```

### 6.2 结构化字段

```
★★  ALC 专注 | FAM: Max, Lily, JOR | PROJ: MemPalace, DataSync
     | PREF: 总是先解释再行动 | never: 不过度承诺
```

### 6.3 主题域（Hall）

```
hall_facts        已知事实
hall_events       重要事件
hall_discoveries  新发现
hall_preferences  偏好
hall_advice       建议
```

### 6.4 示例

```
★  ALC 的当前优先级
   hall_facts: JOR 在创业 | Max/Lily 上学中
   hall_events: 上周完成了 MemPalace v2 发布
   PROJ: DataSync (进行中) | MemPalace (维护模式)
   PREF: 喜欢清晰的文档 | 讨厌没有测试的 PR

★★  JOR 的公司
   hall_facts: 创业公司 CTO | AI 方向 | 远程工作
   FAM: ALC 丈夫 | Max/Lily 父亲
   *warm* 家庭优先 | *fierce* 工作要求高
```

### 6.5 压缩效果

- **压缩比**：~30x（原文 10KB → AAAK ~300 字节）
- **不可逆**：无法从 AAAK 还原原文
- **目的**：让 AI 快速建立上下文，而非精确回忆

---

## 7. 知识图谱系统

### 7.1 实体检测（Entity Detection）

**`entity_detector.py`** 使用两轮检测：

**第一轮：候选提取**
- 收集所有可能的人名候选（专有名词、对话标记）

**第二轮：打分分类**
```
Person 信号：
  - 对话标记（"Alice 说："）
  - 动词模式（child_of, married_to, works_for）
  - 代词邻近度（she/her/him/his 附近）

Project 信号：
  - 版本化命名（v1.0, v2.0）
  - 代码引用模式
  - 架构关键词
```

### 7.2 实体注册表（Entity Registry）

**路径**：`~/.mempalace/entity_registry.json`

```json
{
  "entities": [
    {
      "name": "Max",
      "type": "person",
      "sources": ["learned"],
      "aliases": ["Maximiliane"],
      "disambiguation": "Alice and Jordan's first child, born 2015",
      "context": "Family: child of ALC and JOR, sibling of Lily"
    },
    {
      "name": "MemPalace",
      "type": "project",
      "sources": ["onboarding", "learned"],
      "aliases": ["MP"],
      "context": "AI memory system, local-first, ChromaDB-based"
    }
  ]
}
```

**来源分类**：
- `onboarding`：用户 onboarding 时明确填写
- `learned`：从对话/文件中自动推断
- `wiki`：Wikipedia 查询（用于消歧）

### 7.3 实体消歧

处理歧义情况：
```
"ever"   → 非人名实体
"Ever"   → 可能是人名（首字母大写）
"Maria"  → 自动消歧：根据上下文判断是哪个 Maria
```

---

## 8. MCP Server：19 工具详解

**路径**：`mempalace/mcp_server.py`

MCP Server 通过 Model Context Protocol 暴露 19 个工具给 AI 调用。

### 8.1 读取工具

| 工具 | 功能 |
|------|------|
| `mempalace_status` | 返回宫殿概览 + AAAK spec |
| `mempalace_list_wings` | 列出所有 wing |
| `mempalace_list_rooms` | 列出指定 wing 的所有 room |
| `mempalace_get_taxonomy` | 返回完整 wing/room/drawer 层级 |
| `mempalace_search` | 语义搜索（支持 wing/room 过滤） |
| `mempalace_check_duplicate` | 检查内容是否已存在 |
| `mempalace_get_aaak_spec` | 返回 AAAK 格式规范 |
| `mempalace_traverse` | 图遍历：从某 room 出发 BFS |
| `mempalace_find_tunnels` | 查找跨 wing 的连接（tunnel） |
| `mempalace_graph_stats` | 知识图谱统计 |

### 8.2 写入工具

| 工具 | 功能 |
|------|------|
| `mempalace_add_drawer` | 添加文本抽屉（文件内容） |
| `mempalace_delete_drawer` | 删除抽屉 |

### 8.3 知识图谱工具

| 工具 | 功能 |
|------|------|
| `mempalace_kg_query` | 查询实体关系 |
| `mempalace_kg_add` | 添加三元组 |
| `mempalace_kg_invalidate` | 结束三元组有效期 |
| `mempalace_kg_timeline` | 获取实体的时序事实 |
| `mempalace_kg_stats` | 图谱概览 |

### 8.4 日记工具

| 工具 | 功能 |
|------|------|
| `mempalace_diary_write` | 以 AAAK 格式写 AI 日记 |
| `mempalace_diary_read` | 读取最近的日记条目 |

### 8.5 Palace Protocol（内置协议指南）

MCP status 响应中包含内嵌的"宫殿协议"，教 AI 如何使用记忆：

```
ON WAKE-UP:
  → 调用 mempalace_status 获取宫殿概览 + AAAK spec

BEFORE RESPONDING about any person/project/event:
  → 先查询，不要假设

IF UNSURE about a fact:
  → 说 "let me check" 然后查询

AFTER EACH SESSION:
  → 调用 mempalace_diary_write

WHEN FACTS CHANGE:
  → 先 invalidate 旧的，再 add 新的
```

---

## 9. 挖掘子系统（Mining）

### 9.1 项目文件挖掘（miner.py）

**工作流**：
```
1. 读取 ~/.mempalace/mempalace.yaml 配置
2. 扫描目录（尊重 .gitignore）
3. 对每个可读文件：
   a. mtime 比较 → 已挖过则跳过
   b. 读取文件内容
   c. 路径/关键词 → 检测 room
   d. 800字符分块 + 100字符重叠
   e. 存入 ChromaDB（原文，不摘要）
4. 报告统计
```

### 9.2 对话挖掘（convo_miner.py）

**支持格式**（normalize.py）：
- Claude.ai JSON 导出
- ChatGPT conversations.json
- Claude Code JSONL
- OpenAI Codex CLI JSONL
- Slack JSON 导出
- 纯文本（`>` 标记）

**提取模式**：
- `exchange` 模式：Q+A 对 = 一个单元
- `general` 模式：5 类记忆抽取

### 9.3 5 类通用记忆抽取

从对话中自动提取：

| 类型 | 关键词/模式 |
|------|------------|
| **DECISIONS** | "we went with X because Y" |
| **PREFERENCES** | "always use X", "never do Y" |
| **MILESTONES** | breakthroughs, "it worked" |
| **PROBLEMS** | "it broke", root causes, fixes |
| **EMOTIONAL** | feelings, vulnerability, relationships |

---

## 10. WAL 审计日志

**路径**：`~/.mempalace/wal/write_log.jsonl`

所有 MCP 写操作在执行前先记日志：

```json
{"timestamp": "2026-04-11T10:00:00Z", "operation": "add_drawer", "params": {"wing": "Alice", "room": "diary", "content": "..."}}
{"timestamp": "2026-04-11T10:05:00Z", "operation": "kg_add", "params": {"subject": "Max", "predicate": "child_of", "object": "Alice"}}
{"timestamp": "2026-04-11T10:10:00Z", "operation": "kg_invalidate", "params": {"subject": "Alice", "predicate": "worried_about", "object": "Max injury"}}
```

**用途**：
- 记忆污染检测（外部写入溯源）
- 审计追溯
- 回滚支持

---

## 11. CLI 命令参考

```bash
# 初始化
mempalace init <dir>              # 交互式初始化
mempalace init --yes <dir>        # 非交互式

# 挖掘
mempalace mine <dir>               # 挖掘项目文件
mempalace mine <dir> --mode convos # 挖掘对话
mempalace mine <dir> --dry-run    # 预览不执行

# 搜索
mempalace search "query"                       # 全量搜索
mempalace search "query" --wing myproject      # 按 wing 过滤
mempalace search "query" --wing X --room Y     # 按 wing+room 过滤

# MCP
mempalace mcp                 # 显示 MCP 配置命令
mempalace mcp --install       # 安装 MCP 配置

# 工具
mempalace wake-up             # 显示 L0+L1 上下文
mempalace status              # 宫殿统计
mempalace compress            # AAAK 压缩
mempalace repair              # 重建索引
mempalace split <dir>         # 拆分超大会话文件
```

---

## 12. Onboarding 流程

```
1. 模式选择：work / personal / combo
2. 人物录入：姓名、关系、上下文、昵称
3. 项目录入：主要项目名
4. Wing 定制：Room 分类体系
5. 自动检测：扫描文件 + Wikipedia 补充
6. 歧义警告：常见英文单词 → 非人名
7. 生成：entity_registry.json + AAAK 引导文件
```

---

## 13. 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 向量存储 | ChromaDB | >= 0.5.0, < 0.7 |
| 知识图谱 | SQLite3 | Python 内置 |
| 语言 | Python | 3.9 - 3.12 |
| CLI | argparse | Python 内置 |
| 配置 | PyYAML | >= 6.0 |
| 测试 | pytest | dev |
| 代码质量 | ruff | dev |

**极简依赖**：仅 `chromadb` + `pyyaml` 两个运行时依赖。

---

## 14. 架构亮点与可借鉴之处

### 14.1 值得借鉴

1. **AAAK 格式**：MemPalace 的符号化压缩格式比纯文本摘要更结构化，OSMB 的 AUTO-DREAM 可参考 AAAK 的实体代码和情感标记设计

2. **WAL 审计日志**：所有写操作先记日志再执行，为记忆污染检测和回滚提供基础。OSMB 目前缺少这一层

3. **Palace Protocol 内嵌**：MCP status 响应中附带协议指南，让 AI 主动使用记忆，而不是被动响应

4. **两轮实体检测**：先候选提取 → 再打分分类，比单轮更可靠。OSMB 的 entity-extractor.py 可参考此模式

5. **时间维度知识图谱**：三元组带 `valid_from` / `valid_to`，支持事实的时序演变。OSMB 的 5 层 tier 可考虑融合此思路

6. **Room 自动推断**：`room_detector_local.py` 按文件夹结构自动映射，减少 onboarding 成本

### 14.2 OSMB 优于 MemPalace 的方面

| 方面 | OSMB 优势 |
|------|----------|
| 多源同步 | Watchdog + 跨工具同步，MemPalace 无跨源概念 |
| 多工具共享 | Shared MCP 统一入口，MemPalace 每工具独立 |
| 中文支持 | jieba 分词，MemPalace 无中文处理 |
| 跨项目记忆 | Tiers 3/4 跨项目共享，MemPalace 以 wing 隔离 |
| 文档深度 | 5 层 plane 架构、typed promotion、query routing |
| 混合检索 | BM25 + dense + routing，MemPalace 只有 dense |

### 14.3 MemPalace 可直接移植到 OSMB 的实现

```
可借鉴实现：
├── retrieval/semantic-search.py  → 参考 AAAK 格式设计 L2 压缩
├── ops/entity-extractor.js       → 参考 entity_detector 两轮模式
├── ops/knowledge-graph.js         → 参考 temporal triple + valid_from/valid_to
└── shared-mcp/omni-memory-server.js → Palace Protocol 指南嵌入 status
```

---

## 15. 总结：MemPalace 的记忆本质

MemPalace 的记忆系统本质上是一个**以 ChromaDB 为核心的向量检索系统**，加上一个**以 SQLite 为载体的时序知识图谱**，组织在**4 层记忆栈**中，通过**AAAK 有损格式**控制上下文大小。

它的优势在于**极简实现**（仅 2 个运行时依赖）和**对原文的坚持**（永不摘要原始抽屉）。劣势在于**缺乏跨工具同步机制**和**多源数据桥接能力**。

对于 OSMB 而言，MemPalace 的 AAAK 格式、实体检测两轮模式、WAL 审计机制和时间维度知识图谱是最值得深入研究和借鉴的方向。
