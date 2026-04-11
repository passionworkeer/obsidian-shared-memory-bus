# 融合优化 Plan：Hook 写入 + 渐进式读取

> 目标：解决"写入质量差 + 读取全量"两个核心问题"
> 依据：claude-mem Hook 机制 + MemPalace L0-L3 分层加载

---

## 当前问题定位

| 问题 | 根因 | 借鉴来源 |
|------|------|---------|
| inbox 写入质量差，agent 常忘写或不写 | 依赖 agent 主动决定写什么 | claude-mem 的被动 Hook 提取 |
| 读取全量加载 G-CONTEXT，token 浪费 | 无分层策略，始终全量 | MemPalace L0-L3 按需加载 |
| TTL 分层粗糙 | 用时间做唯一维度 | MemPalace 实体+时间双维度 |
| MCP 一次返回过多 | 工具设计平 | claude-mem 渐进式 Disclosure |

---

## 三阶段实施路线

### Phase 1（最高优先级）：Stop Hook LLM 提取

**改动范围：** 新增 `hooks/stop-hook-llm-extract/` 目录 + 修改 `plugin/hooks/hooks.json`

**新增文件：**
```
hooks/stop-hook-llm-extract/
├── stop-extract.js          # Stop Hook 入口，调用 LLM 压缩
├── src/
│   ├── prompts.ts           # 压缩 prompt 模板
│   ├── parser.ts            # LLM XML 输出解析
│   ├── transcript-slicer.ts # 对话切片策略
│   └── dedup.ts             # session_id 去重检测
```

**stop-extract.js 核心逻辑：**

```
Stop Hook 触发
  ↓
读取 Hook stdin JSON → 获取 transcriptPath + session_id + cwd
  ↓
[去重检测] shared-inbox.jsonl 中是否已有此 session_id
  → 有：exit 0，跳过
  ↓ 无：继续
  ↓
SmartSlice(transcriptPath, cwd)
  → 开头 500 tokens（用户原始意图）
  → 所有 tool_name 含 decision/error/warn 的调用结果
  → 结尾 500 tokens（最终结果）
  ↓
调用 LLM 提取（5s 超时）
  → 成功：写入 Obsidian + JSONL
  → 失败（超时）：写 shared-inbox.jsonl + extraction_failed=true
```

**解析输出格式（写入 Obsidian）：**

```markdown
## [session] {type} | {date}

**事实：**
- {fact 1}
- {fact 2}

**决策：**
- {decision 1}

**实体：**
- [[{entity}]] ({type})

---
来源：session_{id}
```

**验证标准：**
- [ ] Stop Hook 触发后 5s 内完成提取（成功路径）
- [ ] 重复 session_id 不产生重复记录
- [ ] extraction_failed=true 的记录在下次 SessionStart 补提取

---

### Phase 2：L0-L3 读取分层

**改动范围：** 修改 `build-memory-layers.js` + 新增 MCP 分层工具

**新 MCP 工具：**

```
memory_boot(agent_id, cwd)
  → cwd 必填，作为 current_project 解析来源
  → 返回 L0（~100 tokens，固定）
  → 返回 L1（~500 tokens，按 cwd 项目 KG 事实过滤）
  → 不触发 L2/L3

memory_query(query, depth?, cwd)
  → depth=compact: title + 摘要（50 tokens/条）← 等效 claude-mem search
  → depth=full: 原文（按需）                   ← 等效 claude-mem get_observations
```

**L0-L1 生成逻辑（`build-memory-layers.js` 新增）：**

```typescript
// cwd 是 agent 传入的必填参数，作为 current_project 解析来源
// 解析规则：从 cwd 提取最内层目录名作为 project_key
// 例：E:\desktop\obsidian-shared-memory-bus → project_key = "obsidian-shared-memory-bus"

const project_key = path.basename(cwd)

// L0: 固定上下文，手写存储在 00-System/ai-memory/L0-fixed.md
const L0_fixed = read("00-System/ai-memory/L0-fixed.md")

// L1: 从 KG 抽取（仅限当前 project_key）
const L1_knowledge = kg
  .query({ project_key, limit: 20 })  // ← 明确用 project_key 而非模糊 scope
  .map(triple => `- ${triple.subject} ${triple.relation} ${triple.object}`)

// 拼接 bootstrap
const bootstrap = L0_fixed + "\n\n## L1 本次相关事实\n" + L1_knowledge
write("00-System/ai-memory/L1-bootstrap.md", bootstrap)
```

**current_project 解析规则（明确）：**

```
cwd = E:\desktop\obsidian-shared-memory-bus
  → project_key = "obsidian-shared-memory-bus"
  → 用于 KG query({ project_key })
  → 用于判断是否为同一项目

cwd 跨项目时（如 E:\desktop\other-project）：
  → L1 返回 other-project 的 KG 事实
  → 行为正确，不静默返回错误项目
```

**GLOBAL-CONTEXT.md 生成逻辑变更：**
- 旧：`GLOBAL-CONTEXT.md` = 全量历史摘要
- 新：`GLOBAL-CONTEXT.md` = L0 + L1，agent 主动查 L2

**验证标准：**
- [ ] SessionStart 注入的 token 减少 60%+
- [ ] L2 查询延迟 < 500ms

---

### Phase 3：KG 时间维度 + 实体关系

**改动范围：** 新增 `ops/kg-query.js` + 修改 `knowledge-graph.js` + 新增 migration 脚本

**KG migration 版本管理（新增 `ops/migrations/kg-v1-to-v2.js`）：**

```javascript
// ops/migrations/kg-v1-to-v2.js
// 运行前检查当前 schema 版本，不重复执行

const CURRENT_VERSION = 2

async function migrate() {
  const meta = db.get('PRAGMA table_info(triples)')
  const has_valid_from = meta.find(c => c.name === 'valid_from')

  if (has_valid_from) {
    console.log('Migration already applied, skipping')
    return
  }

  db.run(`ALTER TABLE triples ADD COLUMN valid_from TEXT`)
  db.run(`ALTER TABLE triples ADD COLUMN valid_to TEXT`)     // NULL = 当前有效
  db.run(`ALTER TABLE triples ADD COLUMN confidence REAL`)   // 0.0-1.0，跨项目累积
  db.run(`ALTER TABLE triples ADD COLUMN source_scope TEXT`) // 'project'|'shared'|'archive'
  db.run(`INSERT INTO schema_versions (version, applied_at) VALUES (2, datetime('now'))`)

  console.log('KG migration v1→v2 applied')
}

migrate().catch(console.error)
```

**KG 查询示例（迁移后）：**

```sql
-- 当前有效的 MemPalace 相关事实
SELECT * FROM triples
WHERE entity_type IN ('project', 'concept')
  AND (valid_to IS NULL OR valid_to > datetime('now'))
ORDER BY confidence DESC;
```

**与 Phase 1 的联动：**
Stop Hook 提取的 entities 直接写入 KG：
```javascript
// stop-extract.js 新增一步（写入 KG 前先检查 current_project）
const project_key = path.basename(cwd)

for (const entity of extracted.entities) {
  kg.upsertTriple({
    subject: entity.name,
    subject_type: entity.type,
    relation: 'mentioned_in',
    object: project_key,
    valid_from: now(),
    confidence: extracted.confidence,
    source_scope: 'project'
  })
}
```

**验证标准：**
- [ ] KG 查询可以按时间窗口过滤
- [ ] 跨项目实体（被 3+ 项目引用）自动提升 confidence
- [ ] migration 脚本可重复运行（幂等）

---

## 不实施的项（避免过度复杂）

| 放弃项 | 原因 |
|--------|------|
| MemPalace AAAK 格式 | 符号化摘要可读性差 |
| claude-mem ChromaDB | 已有 BM25 + 向量，够用 |
| Wing/Room/Drawer 命名 | 换汤不换药，保持现有命名 |
| L3 全量历史加载 | 几乎不用，不实现 |
| BM25 降级提取 | 关键词提取无法生成结构化 facts/decisions/entities，降级后格式不一致会破坏下游解析 |

---

## 里程碑

```
Week 1:  ✅ Phase 1 完成 → Stop Hook LLM 提取上线
Week 2:  ✅ Phase 2 完成 → L0-L3 分层读取上线
Week 3-4: ✅ Phase 3 完成 → KG 时间维度上线（含 migration）
Week 5:  待验证 → 全量测试 + 回归验证
```

---

## 第一步详细设计（Stop Hook LLM 提取）

### Prompt 模板（`src/prompts.ts`）

```typescript
export const EXTRACT_SYSTEM_PROMPT = `你是记忆工程师。你的任务是从 AI 编程会话记录中提取结构化事实。

规则：
- 只提取客观事实，不推测 agent 意图
- entities 使用标准化类型：module | concept | person | project | decision | bug | api
- session_type 枚举：bugfix | feature | refactor | discovery | docs | chore
- confidence：0.0-1.0，你对提取质量的信心

输出格式（XML，无其他内容）：
<result>
  <session_type>...</session_type>
  <confidence>0.0</confidence>
  <facts>
    <fact>...</fact>
  </facts>
  <decisions>
    <decision>...</decision>
  </decisions>
  <entities>
    <entity name="..." type="..."/>
  </entities>
  <summary>一行话概括本次 session</summary>
</result>`

export const EXTRACT_USER_PROMPT = (conversation: string) => `从以下会话中提取结构化信息：

${conversation}
`
```

### 对话切片策略（`src/transcript-slicer.ts`）

SmartSlice 保证关键信息不丢失：

```typescript
interface SliceResult {
  content: string   // 组装后的切片内容
  tokenCount: number
  source: string[]  // 标注每段来源：[head | tool:{name} | tail]
}

function SmartSlice(transcript: string, cwd: string): SliceResult {
  const lines = transcript.split('\n')
  const DECISION_TOOLS = ['Bash', 'Write', 'Edit', 'Task', 'Agent']
  const ERROR_KEYWORDS = ['error', 'Error', 'ERROR', 'failed', 'Failed', 'FAILED', 'exception', 'warn', 'Warn']

  const chunks: { text: string; source: string; tokens: number }[] = []

  // 1. 开头 500 tokens（用户原始意图）
  const headTokens = tokenCount(lines.slice(0, Math.ceil(lines.length * 0.1)))
  chunks.push({ text: takeTokens(lines, 500), source: 'head', tokens: Math.min(headTokens, 500) })

  // 2. 所有 decision/error 类工具调用的结果
  for (const [i, line] of lines.entries()) {
    const isDecisionTool = DECISION_TOOLS.some(t => line.includes(`"tool":"${t}"`) || line.includes(`"tool_name":"${t}"`))
    const isErrorLine = ERROR_KEYWORDS.some(k => line.includes(k))
    if (isDecisionTool || isErrorLine) {
      // 收集该工具调用的上下文（前后各3行）
      const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n')
      chunks.push({ text: context, source: `tool:${extractToolName(line)}`, tokens: tokenCount(context) })
    }
  }

  // 3. 结尾 500 tokens（最终结果）
  chunks.push({ text: takeLastTokens(lines, 500), source: 'tail', tokens: 500 })

  // 按原顺序拼接
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0)
  if (totalTokens > 3000) {
    // 超限：优先保留 head + tail，减少中间工具结果
    return {
      content: chunks.filter(c => c.source === 'head' || c.source === 'tail').map(c => c.text).join('\n'),
      tokenCount: chunks.filter(c => c.source === 'head' || c.source === 'tail').reduce((s, c) => s + c.tokens, 0),
      source: ['head', 'tail']
    }
  }

  return {
    content: chunks.map(c => c.text).join('\n'),
    tokenCount: totalTokens,
    source: chunks.map(c => c.source)
  }
}
```

### 超时与补提取策略

```typescript
async function extractWithFallback(
  transcript: string,
  sessionId: string,
  cwd: string
): Promise<{ status: 'success' | 'failed'; data?: ExtractedSession }> {
  try {
    const result = await callLLM(transcript, { timeout: 5000 })
    return { status: 'success', data: parseXML(result) }
  } catch (e) {
    // 超时：跳过本次提取，写入标记，下次 SessionStart 补提取
    // 不降级到 BM25——关键词提取无法生成结构化 facts/decisions/entities
    appendToJsonl(getPendingPath(), {
      session_id: sessionId,
      cwd,
      transcript_path: transcriptPath,
      failed_at: new Date().toISOString(),
      reason: e instanceof Error ? e.message : 'unknown'
    })
    return { status: 'failed' }
  }
}
```

**补提取触发（SessionStart Hook）：**

```typescript
// SessionStart 时检查 pending-extractions.jsonl
function replayPendingExtractions() {
  const pending = readJsonl(getPendingPath())
  for (const record of pending) {
    // 最多补提取 3 条，防止 SessionStart 耗时过长
    if (extracted >= 3) break
    extractWithFallback(readFile(record.transcript_path), record.session_id, record.cwd)
    removePending(record.session_id)  // 去重，防止重复补提取
    extracted++
  }
}
```

### 去重检测（`src/dedup.ts`）

```typescript
// stop-extract.js 最前置步骤
function isSessionProcessed(sessionId: string): boolean {
  const jsonlPath = getSharedInboxPath()
  if (!exists(jsonlPath)) return false

  // 流式读取，仅检查 session_id 字段（不需要全量加载）
  const rl = createReadline(jsonlPath)
  for (const line of rl) {
    const record = JSON.parse(line)
    if (record.session_id === sessionId) return true
  }
  return false
}
```

### L0-fixed.md 更新机制（明确触发方）

**触发方：Watchdog（`memory-watchdog.ps1`）**

更新流程写入 `ops/merge-l0-updates.js`：

```typescript
// ops/merge-l0-updates.js
// 由 memory-watchdog.ps1 每小时调用一次

function collectL0Suggestions(): Suggestion[] {
  const inboxPath = getInboxPath()
  return parseInbox(inboxPath).filter(n => n.tags.includes('L0-update'))
}

function mergeToL0(suggestions: Suggestion[]) {
  const current = read('00-System/ai-memory/L0-fixed.md')
  const merged = applyMergeStrategy(current, suggestions)  // diff3 合并
  write('00-System/ai-memory/L0-fixed.md', merged)
  // 从 inbox 移除已合并的 suggestion
}

function applyMergeStrategy(base: string, suggestions: Suggestion[]): string {
  // 保留 L0 格式，只合并 facts，不合并时保留 base
  // 冲突时：取较新日期，标注来源 agent
}
```

```powershell
# memory-watchdog.ps1 中新增
# 每小时运行一次 L0 合并
$l0MergeScript = Join-Path $AI_MEMORY_ROOT "ops/merge-l0-updates.js"
Invoke-Expression "node $l0MergeScript"
```

---

## 待确认 → 已确认

### 1. LLM Provider：用户接入的 Agent

直接复用用户配置的 LLM：
- 生产环境：`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`（现有代理配置）
- 模型：`claude-haiku-4-5-20251001`（约 $0.20/M 输入 tokens，最便宜）
- 调用方式：`POST ${ANTHROPIC_BASE_URL}/v1/messages`（标准 Anthropic API）
- 超时：5s，超时写入 pending-extractions.jsonl，下次 SessionStart 补提取

```typescript
const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721'
const MODEL = 'claude-haiku-4-5-20251001'

async function extractFacts(conversation: string): Promise<ExtractedSession> {
  const response = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy-managed' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: EXTRACT_USER_PROMPT(conversation) }]
    })
  })
  return parseXML(await response.json())
}
```

### 2. Session Log 来源：Claude Code Hook stdin + transcriptPath

Claude Code Hook 触发时通过 **stdin 传入 JSON**：

```typescript
{
  session_id: string,       // 会话 ID
  cwd: string,              // 当前工作目录（current_project 来源）
  prompt: string,           // 用户 prompt
  last_assistant_message: string,
  tool_name: string,        // 工具名
  tool_input: any,          // 工具输入
  tool_response: any,       // 工具输出
  transcript_path: string   // 完整对话记录文件路径
}
```

### 3. L0-fixed.md：用户手写初始内容 + Watchdog 审核合并

```
<vault-root>/00-System/ai-memory/L0-fixed.md
```

初始内容用户手写，Agent 通过 inbox 写入 `tags: [L0-update]`，Watchdog 每小时审核合并一次。
