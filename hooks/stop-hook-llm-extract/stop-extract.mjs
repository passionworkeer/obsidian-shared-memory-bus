// stop-extract.mjs — Stop Hook LLM 提取入口
// 调用方式：node stop-extract.mjs <cwd> <session_id> <transcript_path>
// 或通过 Claude Code Stop Hook stdin JSON 传入参数

import { readFileSync, existsSync, appendFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

// === 配置 ===
const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721'
const MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 5000
const VAULT_ROOT = process.env.AI_MEMORY_OBSIDIAN_VAULT ?? 'E:\\desktop\\Obsidian Vault'
const AGENT_NAME = 'claude-code'
const SHARED_INBOX_JSONL = path.join(VAULT_ROOT, '00-System/ai-memory/structured/shared-inbox.jsonl')
const PENDING_JSONL = path.join(VAULT_ROOT, '00-System/ai-memory/structured/pending-extractions.jsonl')

// === stdin 读取（Claude Code Hook JSON）===
function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => {
      const data = chunks.join('')
      try {
        resolve(JSON.parse(data || '{}'))
      } catch (_) {
        resolve({}) // graceful fallback
      }
    })
  })
}

// === Markdown 转义 ===
function escapeForMarkdown(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/^#\s/mg, '\\# ')
    .replace(/`/g, '\\`')
}

// === 去重检测 ===
function isSessionProcessed(sessionId) {
  if (!existsSync(SHARED_INBOX_JSONL)) return Promise.resolve(false)
  return new Promise(resolve => {
    let found = false
    const rl = createInterface(createReadStream(SHARED_INBOX_JSONL, { encoding: 'utf-8' }))
    rl.on('line', line => {
      if (found) return
      try {
        if (JSON.parse(line).session_id === sessionId) {
          found = true
          rl.close()
          resolve(true)
        }
      } catch { /* skip malformed lines */ }
    })
    rl.on('close', () => resolve(found))
  })
}

// === SmartSlice（调用本地模块）===
async function smartSlice(transcriptPath) {
  // 延迟 import，避免顶层 await 错误
  const { SmartSlice } = await import('./src/transcript-slicer.mjs')
  const transcript = readFileSync(transcriptPath, 'utf-8')
  return SmartSlice(transcript)
}

// === LLM 调用 ===
async function extractFacts(content) {
  const systemPrompt = `你是记忆工程师。从会话记录中提取结构化事实。

规则：
- 只提取客观事实
- session_type 枚举：bugfix | feature | refactor | discovery | docs | chore
- entities 类型：module | concept | person | project | decision | bug | api
- confidence：0.0-1.0

输出格式（XML）：
<result>
  <session_type>...</session_type>
  <confidence>0.0</confidence>
  <facts><fact>...</fact></facts>
  <decisions><decision>...</decision></decisions>
  <entities><entity name="..." type="..."/></entities>
  <summary>一行话概括</summary>
</result>`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const allowedBase = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(\:\d+)?$/
  if (!allowedBase.test(API_BASE)) {
    clearTimeout(timer)
    console.error('[stop-extract] ANTHROPIC_BASE_URL must be localhost/loopback, skipping extraction')
    process.exit(0)
  }

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy-managed' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: `从以下会话中提取结构化信息：\n\n${content}` }]
      })
    })
    clearTimeout(timer)
    const json = await response.json()
    return parseExtraction(json)
  } catch (e) {
    clearTimeout(timer)
    throw e  // 超时走外层 fallback
  }
}

// === XML 解析 ===
function parseExtraction(text) {
  const get = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].trim() : ''
  }
  const getAll = (tag) => {
    const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    return matches.map(m => m[1].trim()).filter(Boolean)
  }
  const getEntities = () => {
    return [...text.matchAll(/<entity\s+name="([^"]+)"\s+type="([^"]+)"/g)]
      .map(m => ({ name: m[1], type: m[2] }))
  }
  return {
    session_type: get('session_type') || 'discovery',
    confidence: parseFloat(get('confidence')) || 0.5,
    facts: getAll('fact'),
    decisions: getAll('decision'),
    entities: getEntities(),
    summary: get('summary')
  }
}

// === 写入 Obsidian inbox ===
function writeToInbox(sessionId, cwd, result) {
  const inboxPath = path.join(VAULT_ROOT, `00-System/ai-memory/inbox/${AGENT_NAME}.md`)
  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    `\n## [session] ${result.session_type} | ${date}`,
    ``,
    result.summary ? `> ${escapeForMarkdown(result.summary)}` : '',
    ``,
    result.facts.length ? `**事实：**\n${result.facts.map(f => `- ${escapeForMarkdown(f)}`).join('\n')}` : '',
    result.decisions.length ? `**决策：**\n${result.decisions.map(d => `- ${escapeForMarkdown(d)}`).join('\n')}` : '',
    result.entities.length ? `**实体：**\n${result.entities.map(e => `- [[${escapeForMarkdown(e.name)}]] (${e.type})`).join('\n')}` : '',
    ``,
    `---`,
    `来源：session_${sessionId} | cwd: ${cwd}`,
    ``
  ].filter(l => l !== false)
  appendFileSync(inboxPath, lines.join('\n'), 'utf-8')
}

// === 写入 shared-inbox.jsonl ===
function writeToJsonl(sessionId, cwd, result, failed = false) {
  const record = {
    id: `rec_${Date.now()}`,
    session_id: sessionId,
    sourceKind: AGENT_NAME,
    memoryLevel: 'session',
    scope: 'project',
    content: result.summary || result.facts.join(' '),
    confidence: result.confidence,
    tier: 2,
    facts: result.facts.map(f => ({ entity: f, type: 'fact' })),
    concepts: result.decisions.map(d => d),
    entities: result.entities,
    metadata: {
      session_type: result.session_type,
      cwd
    },
    lifecycle: {
      tier: 2,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      access_count: 0,
      promotion_count: 0,
      archived: false
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    extraction_failed: failed
  }
  appendFileSync(SHARED_INBOX_JSONL, JSON.stringify(record) + '\n', 'utf-8')
}

// === 写入 pending-extractions.jsonl（超时时）===
function writePending(sessionId, cwd, transcriptPath, reason) {
  appendFileSync(PENDING_JSONL, JSON.stringify({
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    failed_at: new Date().toISOString(),
    reason: reason
  }) + '\n', 'utf-8')
}

// === Phase 1+3: 写入实体到 KG（提取成功后调用）=======================
async function writeEntitiesToKg(cwd, entities) {
  const project_key = path.basename(cwd)
  try {
    // knowledge-graph.js 是 CommonJS，使用 createRequire 兼容 ESM
    const { KnowledgeGraph } = await import(
      new URL('../../../ops/knowledge-graph.js', import.meta.url).href
    )
    const kg = new KnowledgeGraph({ vaultRoot: VAULT_ROOT })
    for (const entity of entities || []) {
      kg.upsertTriple({
        subject:      entity.name,
        subject_type: entity.type,
        predicate:    'mentioned_in',
        object:       project_key,
        source_scope: 'project',
      })
    }
    kg.close()
  } catch (e) {
    // Non-fatal: KG 写入失败不影响主流程，只记录日志
    console.error(`[stop-extract] KG write failed: ${e.message}`)
  }
}

// === 主流程 ===
async function main() {
  const input = await readStdin()
  const cwd = process.argv[2] || input.cwd || ''
  const sessionId = process.argv[3] || input.session_id || `unknown_${Date.now()}`
  const transcriptPath = process.argv[4] || input.transcript_path || ''

  // Reject paths outside Claude Code session directory
  const sessionDir = process.env.CLAUDE_SESSION_DIR || path.join(process.env.APPDATA || '', '.claude', 'sessions')
  if (!transcriptPath.startsWith(sessionDir) && !transcriptPath.includes(path.join('.claude', 'sessions'))) {
    console.error('[stop-extract] transcript_path not in allowed session directory, skipping')
    process.exit(0)
  }

  // 前置检查
  if (!transcriptPath || !existsSync(transcriptPath)) {
    process.exit(0)  // 无 transcript，静默退出
  }

  const processed = await isSessionProcessed(sessionId)
  if (processed) {
    process.exit(0)  // 已处理，跳过
  }

  // SmartSlice
  const slice = await smartSlice(transcriptPath)
  if (!slice || !slice.content.trim()) {
    process.exit(0)
  }

  // LLM 提取（5s 超时）
  try {
    const result = await extractFacts(slice.content)
    writeToInbox(sessionId, cwd, result)
    writeToJsonl(sessionId, cwd, result)
    // Phase 1+3 integration: write extracted entities to the KG
    await writeEntitiesToKg(cwd, result.entities)
  } catch (e) {
    // 超时或其他错误：写 pending，下次 SessionStart 补提取
    writePending(sessionId, cwd, transcriptPath, e.message || 'timeout')
    writeToJsonl(sessionId, cwd, {
      summary: `[提取失败，等待补提取]`,
      facts: [],
      decisions: [],
      entities: [],
      confidence: 0,
      session_type: 'unknown'
    }, true)
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
