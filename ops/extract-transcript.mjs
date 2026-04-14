// ops/extract-transcript.mjs
// ESM module for extracting and processing transcripts

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_HEAD_TOKENS = 500;
const MAX_TAIL_TOKENS = 500;
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Estimate token count for a given text.
 * Approximation: 2 Chinese chars ≈ 1 token, 4 other chars ≈ 1 token
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 2 + otherChars / 4);
}

/**
 * Truncate text to fit within maxTokens
 */
function truncateToTokens(text, maxTokens) {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  const ratio = (maxTokens / estimated) * 0.85;
  return text.slice(0, Math.floor(text.length * ratio)) + "\n...（已截断）";
}

/**
 * Build an extraction transcript from lines array.
 * Splits content into head, tool results (middle), and tail sections.
 * Middle section lines longer than TOOL_RESULT_MAX_CHARS are truncated.
 */
export function buildExtractionTranscript(lines, opts = {}) {
  // Handle empty/null/undefined lines
  if (!lines || lines.length === 0) {
    return '';
  }

  const totalLines = lines.length;
  const headCut = Math.max(5, Math.floor(totalLines * 0.15));
  const tailCut = Math.max(5, Math.floor(totalLines * 0.15));

  // Calculate how many lines go in each section
  const middleStart = Math.min(headCut, totalLines);
  const middleEnd = Math.max(middleStart, totalLines - tailCut);

  const headLines = lines.slice(0, middleStart);
  const middleLines = lines.slice(middleStart, middleEnd);
  const tailLines = lines.slice(middleEnd);

  // Get token limits from options or defaults
  const maxHeadTokens = opts.maxHeadTokens ?? MAX_HEAD_TOKENS;
  const maxTailTokens = opts.maxTailTokens ?? MAX_TAIL_TOKENS;

  // Build head section
  let headContent = headLines.join('\n');
  headContent = truncateToTokens(headContent, maxHeadTokens);

  // Build middle section (tool results) - truncate long lines
  const truncatedMiddle = middleLines.map(line => {
    if (line.length > TOOL_RESULT_MAX_CHARS) {
      return line.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...（已截断）";
    }
    return line;
  });
  let middleContent = truncatedMiddle.join('\n');

  // Build tail section
  let tailContent = tailLines.join('\n');
  tailContent = truncateToTokens(tailContent, maxTailTokens);

  // Combine all sections with markers
  // Only add section markers if we have content in that section
  const hasHead = headLines.length > 0;
  const hasMiddle = middleLines.length > 0;
  const hasTail = tailLines.length > 0;

  let result = '';
  if (hasHead) {
    result += `=== 会话开头 ===\n${headContent}\n`;
  }
  if (hasMiddle) {
    if (result) result += '\n';
    result += `=== 工具交互 ===\n${middleContent}\n`;
  }
  if (hasTail) {
    if (result) result += '\n';
    result += `=== 会话结尾 ===\n${tailContent}`;
  }

  return result;
}

/**
 * Load transcript from a file path.
 * Supports JSONL format (each line is a JSON object with text or content field)
 * and plain text format (each line is a transcript line).
 */
export function loadTranscript(transcriptPath) {
  // Check if file exists
  if (!fs.existsSync(transcriptPath)) {
    throw new Error("transcript-not-found: " + transcriptPath);
  }

  // Read file content
  const raw = fs.readFileSync(transcriptPath, 'utf-8');

  // Check for empty file
  if (raw.trim() === '') {
    throw new Error("transcript-empty");
  }

  const lines = [];
  const rawLines = raw.split('\n');

  // Determine format: JSONL if first non-empty line starts with '{'
  const firstNonEmptyLine = rawLines.find(line => line.trim() !== '');
  const isJsonL = firstNonEmptyLine && firstNonEmptyLine.trim().startsWith('{');

  if (isJsonL) {
    // Parse as JSONL
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed === '') continue; // Skip empty lines

      try {
        const obj = JSON.parse(trimmed);
        const text = obj.text || obj.content;
        if (text) {
          lines.push(text);
        }
      } catch (e) {
        // Skip malformed lines
        continue;
      }
    }
  } else {
    // Plain text format
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed === '') continue; // Skip empty lines
      lines.push(trimmed);
    }
  }

  return { lines, raw };
}
