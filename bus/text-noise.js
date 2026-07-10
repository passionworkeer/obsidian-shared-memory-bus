/**
 * bus/text-noise.js
 * -----------------
 * Q-HIGH-1 第一步: 抽出 NOISE_PATTERNS 与 isNoise() 到独立模块。
 * 这两个 truly independent of embedding pipeline,不依赖 STRUCTURED_DIR 或
 * collectDocuments 复杂状态,可被将来其他 text-pipeline (export-md, dedup 等)
 * 复用,而 generate-embeddings.js 整体仍 800 行。
 *
 * API: `isNoise(text, normalizeSpaces)` - 调用方注入 normalizeSpaces 以避免循环依赖。
 */

const NOISE_PATTERNS = [
  /^Sender\s*\(/i,
  /^System:/i,
  /^Subagent Context/i,
  /^\[Subagent Context\]/i,
  /^Exec completed/i,
  /^Exec failed/i,
  /^A new session was started/i,
  /^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i,
  /^Run your Session Startup/i,
];

/**
 * Returns true if the text looks like a system-noise line that should not be
 * embedded. Strict — 5-char minimum + heuristic pattern match.
 *
 * @param {string} text
 * @param {(value: any) => string} normalizeSpaces normalization helper (injected)
 * @returns {boolean}
 */
function isNoise(text, normalizeSpaces) {
  if (!normalizeSpaces) {
    // Defensive default: fall back to local trivial normalizer if caller
    // doesn't inject one. Avoids a hard fail for legacy callers.
    normalizeSpaces = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  }
  const normalized = normalizeSpaces(text);
  if (!normalized || normalized.length < 5) {
    return true;
  }
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export { NOISE_PATTERNS, isNoise };
