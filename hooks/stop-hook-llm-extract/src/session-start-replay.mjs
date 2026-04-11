// session-start-replay.mjs
// 由 SessionStart Hook 调用，补提取上次超时的记录

import { existsSync, readFileSync, appendFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

const VAULT_ROOT = process.env.AI_MEMORY_OBSIDIAN_VAULT ?? 'E:\\desktop\\Obsidian Vault'
const PENDING_PATH = path.join(VAULT_ROOT, '00-System/ai-memory/structured/pending-extractions.jsonl')
const SHARED_INBOX = path.join(VAULT_ROOT, '00-System/ai-memory/structured/shared-inbox.jsonl')
const INBOX_PATH = path.join(VAULT_ROOT, `00-System/ai-memory/inbox/claude-code.md`)
const MAX_REPLAY = 3  // 每次最多补提取 3 条

const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721'
const MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 5000

export async function replayPendingExtractions() {
  if (!existsSync(PENDING_PATH)) return 0

  const pending = []
  const rl = createInterface(createReadStream(PENDING_PATH, { encoding: 'utf-8' }))
  for await (const line of rl) {
    try {
      pending.push(JSON.parse(line))
    } catch {}
  }

  if (!pending.length) return 0

  const { isSessionProcessed } = await import('./dedup.mjs')
  const { SmartSlice } = await import('./transcript-slicer.mjs')
  const { parseExtraction } = await import('./parser.mjs')

  let replayed = 0
  for (const record of pending) {
    if (replayed >= MAX_REPLAY) break

    // 再次检查是否已处理（可能上次处理后没有删除）
    const already = await isSessionProcessed(SHARED_INBOX, record.session_id)
    if (already) {
      await removePendingRecord(record.session_id)
      continue
    }

    // 读取 transcript 重新提取
    if (!record.transcript_path || !existsSync(record.transcript_path)) {
      continue
    }

    try {
      const transcript = readFileSync(record.transcript_path, 'utf-8')
      const slice = SmartSlice(transcript, record.cwd || '')
      if (!slice?.content?.trim()) continue

      const result = await extractWithTimeout(slice.content)
      if (result) {
        writeResult(record, result)
        await removePendingRecord(record.session_id)
        replayed++
      }
    } catch {
      // 仍然失败，保留在 pending 中
    }
  }

  return replayed
}

async function extractWithTimeout(content) {
  const systemPrompt = `你是记忆工程师。从会话记录中提取结构化事实。...（同上）`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const resp = await fetch(`${API_BASE}/v1/messages`, {
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
    return parseExtraction(await resp.json())
  } catch {
    clearTimeout(timer)
    return null
  }
}

function writeResult(record, result) {
  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    `\n## [session] ${result.session_type} | ${date} [补提取]`,
    result.summary ? `> ${result.summary}` : '',
    result.facts.length ? `**事实：**\n${result.facts.map(f => `- ${f}`).join('\n')}` : '',
    result.decisions.length ? `**决策：**\n${result.decisions.map(d => `- ${d}`).join('\n')}` : '',
    result.entities.length ? `**实体：**\n${result.entities.map(e => `- [[${e.name}]] (${e.type})`).join('\n')}` : '',
    ``,
    `---`,
    `来源：session_${record.session_id} [补提取] | cwd: ${record.cwd}`,
    ``
  ].filter(Boolean)
  appendFileSync(INBOX_PATH, lines.join('\n'), 'utf-8')

  appendFileSync(SHARED_INBOX, JSON.stringify({
    id: `rec_${Date.now()}`,
    session_id: record.session_id,
    sourceKind: 'claude-code',
    memoryLevel: 'session',
    scope: 'project',
    content: result.summary || result.facts.join(' '),
    confidence: result.confidence,
    tier: 2,
    facts: result.facts.map(f => ({ entity: f, type: 'fact' })),
    concepts: result.decisions,
    entities: result.entities,
    metadata: { session_type: result.session_type, cwd: record.cwd, replayed: true },
    lifecycle: {
      tier: 2,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      access_count: 0, promotion_count: 0, archived: false
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    extraction_failed: false
  }) + '\n', 'utf-8')
}

async function removePendingRecord(sessionId) {
  if (!existsSync(PENDING_PATH)) return
  const lines = []
  const rl = createInterface(createReadStream(PENDING_PATH, { encoding: 'utf-8' }))
  for await (const line of rl) {
    try {
      if (JSON.parse(line).session_id !== sessionId) lines.push(line)
    } catch {}
  }
  const { writeFileSync } = await import('fs')
  writeFileSync(PENDING_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
}

// CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  replayPendingExtractions()
    .then(n => { console.log(`补提取完成: ${n} 条`); process.exit(0) })
    .catch(() => process.exit(0))
}
