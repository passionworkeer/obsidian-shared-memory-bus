/**
 * bus/generate-embeddings-load.js
 * --------------------------------
 * Q-HIGH-1 step 3: 抽出原 bus/generate-embeddings.js 的"加载现有 index.jsonl"职责。
 * 仅 50 行 IO 函数,与主 entrypoint 的 batch 嵌入循环 + writeIndexSnapshot
 * 解耦;主文件 import loadExistingIndex 后仍负责写入。
 *
 * 用法:
 *   const existing = await loadExistingIndex(INDEX_FILE);
 *   // Map keyed by entryId (sub-entry id), value 是 indexed record + 复用的
 *   // `fieldTexts` 字典 (fieldName → hash) 用于 incremental rebuild reuse check.
 *
 * v2 records (含 record_id/field) 优先; legacy v1 records (无 record_id/field,
 * 一条 entry 一个 record_id) 也支持,视为 field="content"。
 */

import fs from "node:fs";
import { createJsonlStream } from "../ops/util/jsonl-stream.js";

/**
 * Load the existing index.jsonl (v1 or v2 format) using streaming.
 * Never loads the entire file into memory — iterates one record at a time.
 *
 * @param {string} indexFile - absolute path to index.jsonl
 * @returns {Promise<Map<string, object>>}
 */
async function loadExistingIndex(indexFile) {
  const existing = new Map();
  if (!indexFile || !fs.existsSync(indexFile)) {
    return existing;
  }

  for await (const record of createJsonlStream(indexFile)) {
    if (!record || !record.id) {
      continue;
    }
    try {
      const entryId = String(record.id).trim();

      // Reconstruct fieldTexts from the stored record:
      // v2: record has { record_id, field, text, contentHash: { fieldName -> hash } }
      // v1 (legacy): no record_id/field — treat as { field: "content", text: record.text || record.search_text }
      if (record.record_id !== undefined && record.field !== undefined) {
        const fieldTexts = {};
        if (record.contentHash && typeof record.contentHash === "object" && !Array.isArray(record.contentHash)) {
          for (const [fname, h] of Object.entries(record.contentHash)) {
            fieldTexts[fname] = String(h || "");
          }
        } else if (typeof record.contentHash === "string") {
          fieldTexts.content = String(record.contentHash);
        }
        existing.set(entryId, { ...record, fieldTexts });
      } else {
        const recordId = entryId;
        const fieldTexts = {};
        if (record.contentHash && typeof record.contentHash === "string") {
          fieldTexts.content = String(record.contentHash);
        }
        existing.set(entryId, { ...record, fieldTexts, record_id: recordId, field: "content" });
      }
    } catch (err) {
      console.error(`[generate-embeddings] JSON parse error in index load (skipping line): ${err.message}`);
    }
  }

  return existing;
}

export { loadExistingIndex };
