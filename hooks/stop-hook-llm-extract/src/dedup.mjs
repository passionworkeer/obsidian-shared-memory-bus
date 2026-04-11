// dedup.mjs
import { existsSync, createReadStream } from 'fs'
import { createInterface } from 'readline'

/**
 * 检查 session_id 是否已存在于 shared-inbox.jsonl
 * 流式读取，不全量加载文件
 * @param {string} jsonlPath - shared-inbox.jsonl 路径
 * @param {string} sessionId - 要检查的 session_id
 * @returns {Promise<boolean>}
 */
export async function isSessionProcessed(jsonlPath, sessionId) {
  if (!existsSync(jsonlPath)) return false

  return new Promise(resolve => {
    const rl = createInterface(createReadStream(jsonlPath, { encoding: 'utf-8' }))
    let found = false

    rl.on('line', line => {
      if (found) return
      try {
        const record = JSON.parse(line)
        if (record.session_id === sessionId) {
          found = true
          rl.close()
          resolve(true)
        }
      } catch {
        // 跳过无效 JSON 行
      }
    })

    rl.on('close', () => {
      if (!found) resolve(false)
    })

    rl.on('error', () => resolve(false))
  })
}

/**
 * 从 pending-extractions.jsonl 中移除已补提取的记录
 * @param {string} pendingPath
 * @param {string} sessionId
 */
export async function removePending(pendingPath, sessionId) {
  if (!existsSync(pendingPath)) return

  const lines = []
  const rl = createInterface(createReadStream(pendingPath, { encoding: 'utf-8' }))
  for await (const line of rl) {
    try {
      if (JSON.parse(line).session_id !== sessionId) {
        lines.push(line)
      }
    } catch {
      // 跳过
    }
  }
  // 重写文件
  const { writeFileSync } = await import('fs')
  writeFileSync(pendingPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
}
