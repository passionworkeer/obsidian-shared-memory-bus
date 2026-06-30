// stop-extract.mjs — Stop Hook LLM 提取入口（v2，去掉 Obsidian 依赖）
// 调用方式：Claude Code Stop Hook stdin JSON，字段：cwd, session_id, transcript_path

import { readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { resolveStoreRoot, getProjectsRoot } = require('../../bus/store-root.js')

// Atomic append via O_APPEND — safe under concurrent stop-hook invocations
// (multiple Claude sessions ending at once). appendFileSync can interleave/
// truncate on Windows FILE_APPEND_DATA; flag 'a' seeks to EOF atomically.
function appendAtomic(filePath, line) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = openSync(filePath, 'a')
  try {
    writeSync(fd, line.endsWith('\n') ? line : `${line}\n`)
  } finally {
    closeSync(fd)
  }
}

// === 配置 ===
const API_BASE   = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721'
const MODEL      = process.env.AI_MEMORY_MODEL    ?? 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 8000

// === 路径解析 ===
function getProjectJsonlPath(cwd) {
  const name = path.basename(cwd || 'default') || 'default'
  const root  = getProjectsRoot()
  mkdirSync(root, { recursive: true })
  return path.join(root, `${name}.jsonl`)
}

function getPendingPath() {
  return path.join(resolveStoreRoot(), 'pending-extractions.jsonl')
}

// === stdin 读取（Claude Code Hook JSON）===
function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(chunks.join('') || '{}')) } catch { resolve({}) }
    })
  })
}

// === 去重检测（扫描 project.jsonl）===
function isSessionProcessed(jsonlPath, sessionId) {
  if (!existsSync(jsonlPath)) return Promise.resolve(false)
  return new Promise(resolve => {
    let found = false
    const rl = createInterface(createReadStream(jsonlPath, { encoding: 'utf-8' }))
    rl.on('line', line => {
      if (found) return
      try {
        if (JSON.parse(line).session_id === sessionId) { found = true; rl.close(); resolve(true) }
      } catch { /* skip malformed lines */ }
    })
    rl.on('close', () => resolve(found))
  })
}

// === SmartSlice ===
async function smartSlice(transcriptPath) {
  const { SmartSlice } = await import('./src/transcript-slicer.mjs')
  const transcript = readFileSync(transcriptPath, 'utf-8')
  return SmartSlice(transcript)
}

// === LLM 提取 ===
async function extractFacts(content) {
  const allowedBase = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(\:\d+)?$/
  if (!allowedBase.test(API_BASE)) {
    throw new Error('ANTHROPIC_BASE_URL must be localhost/loopback')
  }

  const systemPrompt = `你是记忆工程师。从会话记录中提取结构化事实。
规则：只提取客观事实，session_type 枚举：bugfix|feature|refactor|discovery|docs|chore
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
    // Extract text content from Anthropic API response format
    const textContent = json?.content?.[0]?.text ?? ''
    return parseExtraction(textContent)
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// === XML 解析 ===
function parseExtraction(text) {
  const get    = (tag) => { const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : '' }
  const getAll = (tag) => [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1].trim()).filter(Boolean)
  const getEntities = () => [...text.matchAll(/<entity\s+name="([^"]+)"\s+type="([^"]+)"/g)].map(m => ({ name: m[1], type: m[2] }))
  return {
    session_type: get('session_type') || 'discovery',
    confidence:   parseFloat(get('confidence')) || 0.5,
    facts:        getAll('fact'),
    decisions:    getAll('decision'),
    entities:     getEntities(),
    summary:      get('summary')
  }
}

// === 写入 project.jsonl ===
function writeToProjectJsonl(jsonlPath, sessionId, cwd, result, failed = false) {
  const record = {
    id:           `rec_${Date.now()}`,
    session_id:   sessionId,
    project:      path.basename(cwd || 'default'),
    scope:        'project',
    content:      result.summary || result.facts[0] || '',
    confidence:   result.confidence,
    facts:        result.facts,
    decisions:    result.decisions,
    entities:     result.entities,
    session_type: result.session_type,
    extraction_failed: failed,
    t:            new Date().toISOString()
  }
  appendAtomic(jsonlPath, JSON.stringify(record))
}

// === 写入 pending-extractions.jsonl（超时时）===
function writePending(sessionId, cwd, transcriptPath, reason) {
  appendAtomic(getPendingPath(), JSON.stringify({
    session_id:      sessionId,
    cwd,
    transcript_path: transcriptPath,
    failed_at:       new Date().toISOString(),
    reason
  }))
}

// === 主流程 ===
async function main() {
  const input    = await readStdin()
  const cwd      = process.argv[2] || input.cwd || ''
  const sessionId= process.argv[3] || input.session_id || `unknown_${Date.now()}`
  const transcriptPath = process.argv[4] || input.transcript_path || ''

  // Security: only allow transcripts inside Claude session directory
  const sessionDir = process.env.CLAUDE_SESSION_DIR
    || path.join(process.env.APPDATA || process.env.HOME || '', '.claude', 'sessions')
  if (!transcriptPath.startsWith(sessionDir) && !transcriptPath.includes(path.join('.claude', 'sessions'))) {
    process.exit(0)
  }

  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0)

  const jsonlPath = getProjectJsonlPath(cwd)

  if (await isSessionProcessed(jsonlPath, sessionId)) process.exit(0)

  const slice = await smartSlice(transcriptPath)
  if (!slice?.content?.trim()) process.exit(0)

  try {
    const result = await extractFacts(slice.content)
    writeToProjectJsonl(jsonlPath, sessionId, cwd, result)
  } catch (e) {
    writePending(sessionId, cwd, transcriptPath, e.message || 'timeout')
    writeToProjectJsonl(jsonlPath, sessionId, cwd, {
      summary: '[提取失败，等待补提取]', facts: [], decisions: [], entities: [],
      confidence: 0, session_type: 'unknown'
    }, true)
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
