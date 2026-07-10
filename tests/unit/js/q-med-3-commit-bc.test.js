/**
 * Q-MED-3 Commit B + C — 守护:
 *   Commit B: shared-mcp/{memory-bridge,memory-embeddings,memory-generation,
 *     memory-retrieval}.js 中 9 处 user-facing throw 站点已迁移到
 *     DomainError,带稳定 MCP_CODES code。
 *   Commit C: omni-handlers.js:registerMcpRequestHandlers 的 catch 块
 *     把 throw 出去的 error 通过 mcpErrorResult 翻译为带 code 的 MCP
 *     wire shape。
 *
 * 任何一处回退,后续 catch 块会把 DomainError 当 Error 兜底为 INTERNAL,
 * user-facing code 字段丢失 ——— 因此守护要锁死 import + catch 形式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SHARED_MCP_DIR = path.resolve(path.dirname(__filename), "../../../shared-mcp");

function readSource(file) {
  return fs.readFileSync(path.join(SHARED_MCP_DIR, file), "utf8");
}

/**
 * 找到所有 `throw new Error(...)` 调用位置(行号 + 整行内容)。
 * 用于守护"用户面向 throw 站点不应再出现裸 Error"。
 */
function findRawErrorThrows(source) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释里的 throw new Error 关键词
    const stripped = line.replace(/\/\/.*$/, "");
    if (/\bthrow new Error\b/.test(stripped)) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

test("memory-bridge.js: 3 处 throw 全部走 DomainError + BRIDGE_UNREACHABLE/INVALID_INPUT", () => {
  const source = readSource("memory-bridge.js");
  const raw = findRawErrorThrows(source);
  assert.deepEqual(
    raw,
    [],
    `memory-bridge.js still has raw throw new Error() sites: ${JSON.stringify(raw, null, 2)}`,
  );
  // 4 throw site 都是 DomainError (3 处原 throw site + 1 处 import 自身的文案)
  // 这里锁数量 ≥ 3
  const domainErrorThrows = source.match(/throw new DomainError\(/g) || [];
  assert.ok(
    domainErrorThrows.length >= 3,
    `expected ≥3 DomainError throws in memory-bridge.js, got ${domainErrorThrows.length}`,
  );
});

test("memory-embeddings.js: SCRIPT_MISSING + SUBPROCESS_FAILED 已升级到 DomainError", () => {
  const source = readSource("memory-embeddings.js");
  const raw = findRawErrorThrows(source);
  assert.deepEqual(raw, [], "memory-embeddings.js still has raw throw new Error() sites");
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.SCRIPT_MISSING/);
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.SUBPROCESS_FAILED/);
});

test("memory-generation.js: SCRIPT_MISSING + SUBPROCESS_FAILED 已升级到 DomainError", () => {
  const source = readSource("memory-generation.js");
  const raw = findRawErrorThrows(source);
  assert.deepEqual(raw, [], "memory-generation.js still has raw throw new Error() sites");
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.SCRIPT_MISSING/);
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.SUBPROCESS_FAILED/);
});

test("memory-retrieval.js: SUBPROCESS_FAILED + EXTERNAL_SERVICE 已升级到 DomainError", () => {
  const source = readSource("memory-retrieval.js");
  const raw = findRawErrorThrows(source);
  assert.deepEqual(raw, [], "memory-retrieval.js still has raw throw new Error() sites");
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.SUBPROCESS_FAILED/);
  assert.match(source, /throw new DomainError\(\s*MCP_CODES\.EXTERNAL_SERVICE/);
});

test("targeted files import DomainError + MCP_CODES from mcp-domain-error.js", () => {
  for (const file of [
    "memory-bridge.js",
    "memory-embeddings.js",
    "memory-generation.js",
    "memory-retrieval.js",
  ]) {
    const source = readSource(file);
    assert.match(
      source,
      /import\s*\{[^}]*\bDomainError\b[^}]*\}\s*from\s*["']\.\/mcp-domain-error\.js["']/,
      `${file} must import DomainError from ./mcp-domain-error.js`,
    );
    assert.match(
      source,
      /import\s*\{[^}]*\bMCP_CODES\b[^}]*\}\s*from\s*["']\.\/mcp-domain-error\.js["']/,
      `${file} must import MCP_CODES from ./mcp-domain-error.js`,
    );
  }
});

// ---------------------------------------------------------------------------
// Commit C — omni-handlers.js catch 块升级守护
// ---------------------------------------------------------------------------

test("omni-handlers.js: imports mcpErrorResult from ./mcp-domain-error.js", () => {
  const source = readSource("omni-handlers.js");
  assert.match(
    source,
    /import\s*\{[^}]*\bmcpErrorResult\b[^}]*\}\s*from\s*["']\.\/mcp-domain-error\.js["']/,
    "omni-handlers.js must import mcpErrorResult from ./mcp-domain-error.js",
  );
});

test("omni-handlers.js: CallTool catch 用 mcpErrorResult(error) 而非裸 errorResult(message)", () => {
  const source = readSource("omni-handlers.js");
  assert.match(
    source,
    /mcpErrorResult\(\s*error\s*\)/,
    "catch block must call mcpErrorResult(error) to translate thrown error to wire payload",
  );
  assert.doesNotMatch(
    source,
    /return\s+errorResult\(error\s+instanceof\s+Error\s+\?[^)]+\)\s*;/,
    "legacy single-arg errorResult(error.message) form must be removed",
  );
});
