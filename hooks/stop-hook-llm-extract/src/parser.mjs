// parser.mjs
// LLM 输出可能是 XML（优先）或纯 JSON，降级容错

/**
 * 从 LLM 原始响应中提取结构化数据
 * @param {object|string} raw - API 响应（可能是 text 或 { content: [...] }）
 * @returns {object} 标准化提取结果
 */
export function parseExtraction(raw) {
  let text = ''

  // 处理不同的 API 响应格式
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw?.content)) {
    // Anthropic messages API: content 是 blocks 数组
    text = raw.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  } else if (typeof raw?.text === 'string') {
    text = raw.text
  } else if (typeof raw?.content === 'string') {
    text = raw.content
  } else {
    // 降级：把整个对象转字符串
    text = JSON.stringify(raw)
  }

  // 尝试 XML 解析
  const xmlResult = tryXmlParse(text)
  if (xmlResult) return xmlResult

  // 降级：JSON 解析
  const jsonResult = tryJsonParse(text)
  if (!jsonResult || typeof jsonResult !== 'object') {
    return {
      session_type: 'discovery',
      confidence: 0.3,
      facts: [],
      decisions: [],
      entities: [],
      summary: text.slice(0, 200)  // 截取前200字作为 summary
    }
  }
  return jsonResult

  // 最终降级：返回空结构（不抛出异常）
  return {
    session_type: 'discovery',
    confidence: 0.3,
    facts: [],
    decisions: [],
    entities: [],
    summary: text.slice(0, 200)  // 截取前200字作为 summary
  }
}

function tryXmlParse(text) {
  try {
    const get = (tag) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
      return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''
    }
    const getAll = (tag) => {
      const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
      return matches.map(m => m[1].trim()).filter(Boolean)
    }
    const getEntities = () => {
      return [...text.matchAll(/<entity\s+name="([^"]+)"\s+type="([^"]+)"/g)]
        .map(m => ({ name: m[1].trim(), type: m[2].trim() }))
    }

    const sessionType = get('session_type')
    if (!sessionType && !getAll('fact').length) return null  // 无有效内容

    return {
      session_type: normalizeSessionType(sessionType),
      confidence: parseFloat(get('confidence')) || 0.5,
      facts: getAll('fact'),
      decisions: getAll('decision'),
      entities: getEntities(),
      summary: get('summary')
    }
  } catch {
    return null
  }
}

function tryJsonParse(text) {
  try {
    // 尝试提取 ```json ... ``` 块
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ||
                      text.match(/```\s*([\s\S]*?)\s*```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text
    const parsed = JSON.parse(jsonStr.trim())
    return {
      session_type: normalizeSessionType(parsed.session_type || ''),
      confidence: parseFloat(parsed.confidence) || 0.5,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      summary: parsed.summary || ''
    }
  } catch {
    return null
  }
}

function normalizeSessionType(type) {
  const VALID = ['bugfix', 'feature', 'refactor', 'discovery', 'docs', 'chore']
  const lower = (type || '').toLowerCase().trim()
  return VALID.includes(lower) ? lower : 'discovery'
}
