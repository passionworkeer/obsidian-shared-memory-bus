// src/transcript-slicer.mjs — SmartSlice 实现
// 策略：开头意图 + decision/error 类工具调用上下文 + 结尾结果
// 不依赖任何第三方包，只用 Node.js 内置模块

/**
 * 估算字符串的 token 数（粗略：中文 ~2 chars/token，英文 ~4 chars/token）
 */
function estimateTokens(text) {
  if (!text) return 0
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const rest = text.length - chinese
  return Math.ceil(chinese * 2 + rest * 0.25)
}

/**
 * 从文本头部取指定 token 数，尽量在句号或换行处截断
 */
function takeHeadTokens(text, maxTokens) {
  let count = 0
  let result = ''
  let lastGoodCut = 0
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    const isChinese = /[\u4e00-\u9fff]/.test(char)
    result += char
    count += isChinese ? 2 : 0.25
    // 记录最后一个安全的断点（句号或换行）
    if (char === '.' || char === '\n') lastGoodCut = result.length
    if (count > maxTokens) break
  }
  // 回切到上一个安全断点
  if (lastGoodCut > 0 && count > maxTokens) {
    return result.slice(0, lastGoodCut).trim()
  }
  return result.trim()
}

/**
 * 从文本尾部取指定 token 数
 */
function takeTailTokens(text, maxTokens) {
  const lines = text.split('\n')
  const result = []
  let count = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineTokens = estimateTokens(lines[i])
    if (count + lineTokens > maxTokens && result.length > 0) break
    result.unshift(lines[i])
    count += lineTokens
  }
  return result.join('\n').trim()
}

/**
 * 从行内容中提取工具名
 */
function extractToolName(line) {
  const m = line.match(/"(?:tool|tool_name)"\s*:\s*"([^"]+)"/)
  return m ? m[1] : 'unknown'
}

/**
 * SmartSlice：保留开头意图 + 决策节点 + 结尾结果
 *
 * @param {string} transcript - 完整对话文本
 * @param {string} cwd - 当前工作目录（预留，暂未使用）
 * @returns {{ content: string, tokenCount: number, source: string[], strategy: string }}
 */
export function SmartSlice(transcript, cwd = '') {
  if (!transcript || typeof transcript !== 'string') {
    return { content: '', tokenCount: 0, source: [], strategy: 'empty-input' }
  }

  const lines = transcript.split('\n')
  const DECISION_TOOLS = ['Bash', 'Write', 'Edit', 'Task', 'Agent', 'WebSearch', 'WebFetch']
  const ERROR_KEYWORDS = [
    'error', 'Error', 'ERROR',
    'failed', 'Failed', 'FAILED',
    'exception', 'Exception',
    'warn', 'Warn',
    'cannot', 'Cannot',
    'refused'
  ]

  const chunks = []

  // 1. 开头 500 tokens（用户原始意图）
  const headText = takeHeadTokens(lines.join('\n'), 500)
  chunks.push({ text: headText, source: 'head' })

  // 2. 所有 decision/error/warn 类工具调用及其上下文
  const addedRanges = new Set()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isDecisionTool = DECISION_TOOLS.some(t =>
      line.includes(`"tool":"${t}"`) || line.includes(`"tool_name":"${t}"`)
    )
    const isErrorLine = ERROR_KEYWORDS.some(k => line.includes(k))

    if (!isDecisionTool && !isErrorLine) continue

    // 按 5 行分组去重，避免同一工具调用的多行被重复添加
    const rangeKey = Math.floor(i / 5)
    if (addedRanges.has(rangeKey)) continue
    addedRanges.add(rangeKey)

    // 收集上下文：前后各 3 行
    const start = Math.max(0, i - 3)
    const end = Math.min(lines.length, i + 4)
    const context = lines.slice(start, end).join('\n')
    const toolName = extractToolName(line)
    chunks.push({ text: context, source: `tool:${toolName}` })
  }

  // 3. 结尾 500 tokens（最终结果）
  const tailText = takeTailTokens(lines.join('\n'), 500)
  chunks.push({ text: tailText, source: 'tail' })

  // 超限处理：优先保留 head + tail，减少中间工具结果
  const totalTokens = chunks.reduce((s, c) => s + estimateTokens(c.text), 0)
  if (totalTokens > 3000) {
    const filtered = chunks.filter(c => c.source === 'head' || c.source === 'tail')
    const deduped = deduplicateChunks(filtered)
    return {
      content: deduped.map(c => c.text).join('\n').trim(),
      tokenCount: deduped.reduce((s, c) => s + estimateTokens(c.text), 0),
      source: deduped.map(c => c.source),
      strategy: 'head+tail-only'
    }
  }

  // 短输入去重：过滤掉已被前序 chunks 包含的内容（防止 head/tail 重叠）
  const deduped = deduplicateChunks(chunks)
  return {
    content: deduped.map(c => c.text).join('\n').trim(),
    tokenCount: deduped.reduce((s, c) => s + estimateTokens(c.text), 0),
    source: deduped.map(c => c.source),
    strategy: 'full'
  }
}

/**
 * 去除已被前序 chunk 包含的重复内容块
 * @param {{ text: string, source: string }[]} chunks
 * @returns {{ text: string, source: string }[]}
 */
function deduplicateChunks(chunks) {
  const result = []
  for (const chunk of chunks) {
    const isDuplicate = result.some(prev => prev.text.includes(chunk.text) || chunk.text.includes(prev.text))
    if (!isDuplicate) {
      result.push(chunk)
    }
  }
  return result
}
