# Week 2 实施计划：提取层（Extraction Layer）

> 核心目标：实现基于 Stop Hook 的会话提取管道，替代 watchdog 驱动的被动同步
>
> **已知问题修正版（v2）**：修正了模块系统混用、函数调用语法、Stop Hook stdin 读取、Node 路径、`generateId` 不存在的问题

---

## 一、现有代码确认

| 现有模块 | 确认结果 |
|---------|---------|
| `bus/store-root.js` | `getProjectsRoot`、`resolveStoreRoot` 均已通过 `module.exports` 导出 ✅ |
| `bus/store-root.js` | 全 CJS（`require`），但 `extraction-pipeline.js` 改用 ESM 即可 ✅ |
| `ops/entity-extractor.js` | 全 CJS，可独立使用不改动，pipeline 不直接依赖 ✅ |
| `ops/memory-contract.js` | 无 `generateId`，需在 pipeline 内自行实现 ✅ |
| `ops/generate-context.js` | 全 CJS，pipeline 不直接 import，但可参考 JSONL 写入模式 ✅ |
| `shared-mcp/memory-retrieval.js` | 有 `spawnProcess()` 工具函数，pipeline 内联一份避免循环依赖 ✅ |

---

## 二、新增文件清单

```
ops/
  extraction-pipeline.mjs     ← 核心提取引擎（新建，ESM）
  extract-transcript.mjs      ← transcript 构建工具（新建，ESM）
  extraction-prompt.mjs       ← LLM 提取 prompt 模板（新建，ESM）
  extraction-validate.mjs     ← 输出 XML 解析 + schema 验证（新建，ESM）
scripts/
  extraction-stop-hook.ps1    ← Claude Code Stop Hook 入口（新建）
  extraction-session-start.ps1← Claude Code SessionStart Hook 入口（新建）
```

**注意**：扩展名用 `.mjs` 明确标识 ESM 模块，避免与项目其他 `.js` CJS 文件混淆。

---

## 三、详细实现规格

### 3.1 `ops/extraction-prompt.mjs` — Prompt 模板

```javascript
// ops/extraction-prompt.mjs
// -------------------------
// LLM extraction prompt + XML output schema（ESM）

/**
 * 用户身份上下文（从 user-identity.md 注入）
 * @type {string}
 */
let USER_IDENTITY_CONTEXT = "";

export function setUserIdentityContext(ctx) {
  USER_IDENTITY_CONTEXT = ctx;
}

export function buildExtractionPrompt(transcript, projectContext = "") {
  return `你是一个会话记忆提取专家。从以下会话记录中提取结构化事实。

<user_identity>
${USER_IDENTITY_CONTEXT || "(未提供用户身份)"}
</user_identity>

<project_context>
${projectContext || "(无项目上下文)"}
</project_context>

<transcript>
${transcript}
</transcript>

请提取以下内容并以 XML 格式输出（只输出 XML，不要其他文字）：

<extraction>
  <session_type>bugfix|feature|refactor|discovery|docs|chore</session_type>
  <confidence>0.0-1.0</confidence>
  <facts>
    <fact type="user|project">
      <content>事实描述（中文，30-200字）</content>
      <scope>user|project</scope>
    </fact>
    ...
  </facts>
  <decisions>
    <decision>关键决策及其原因</decision>
    ...
  </decisions>
  <entities>
    <entity type="person|project|concept">
      <name>实体名称</name>
      <context>上下文说明</context>
    </entity>
    ...
  </entities>
</extraction>

提取规则：
- facts 最多 10 条，每条必须是有意义的长期记忆
- decisions 只记录架构/方向/方案级别的决策
- entities 只提取有明确上下文的实体
- 不要提取敏感信息（密码、API key、token）
- 优先提取关于用户偏好、项目决策、技术方案的事实`;
}

export const SESSION_TYPE_VALUES = new Set([
  "bugfix", "feature", "refactor", "discovery", "docs", "chore"
]);
```

---

### 3.2 `ops/extraction-validate.mjs` — XML 解析 + 验证

```javascript
// ops/extraction-validate.mjs
// ----------------------------
// Parse LLM XML output → structured extraction result（ESM）

import { SESSION_TYPE_VALUES } from "./extraction-prompt.mjs";

/**
 * @typedef {Object} ExtractionResult
 * @property {string} session_type
 * @property {number} confidence
 * @property {Array<{type:string, content:string, scope:string}>} facts
 * @property {string[]} decisions
 * @property {Array<{type:string, name:string, context:string}>} entities
 * @property {boolean} valid
 * @property {string[]} errors
 */

/**
 * Parse XML string into ExtractionResult
 * @param {string} xml
 * @returns {ExtractionResult}
 */
export function parseExtractionXml(xml) {
  const result = {
    session_type: "discovery",
    confidence: 0.5,
    facts: [],
    decisions: [],
    entities: [],
    valid: true,
    errors: [],
  };

  const trimmed = (xml || "").trim();
  if (!trimmed) {
    result.valid = false;
    result.errors.push("empty-xml-response");
    return result;
  }

  // session_type
  const typeMatch = trimmed.match(/<session_type>([\s\S]*?)<\/session_type>/i);
  if (typeMatch) {
    const t = typeMatch[1].trim().toLowerCase();
    if (SESSION_TYPE_VALUES.has(t)) {
      result.session_type = t;
    } else {
      result.errors.push(`unknown session_type: ${t}`);
    }
  }

  // confidence
  const confMatch = trimmed.match(/<confidence>([\s\S]*?)<\/confidence>/i);
  if (confMatch) {
    const c = parseFloat(confMatch[1].trim());
    if (!isNaN(c) && c >= 0 && c <= 1) {
      result.confidence = c;
    } else {
      result.errors.push("confidence must be 0.0-1.0");
    }
  }

  // facts — extract all <fact> blocks
  const factsSection = trimmed.match(/<facts>([\s\S]*?)<\/facts>/i);
  if (factsSection) {
    // Match each <fact> block (may have type attribute)
    const factBlockRegex = /<fact(?:\s[^>]*)?>([\s\S]*?)<\/fact>/gi;
    let match;
    while ((match = factBlockRegex.exec(factsSection[1])) !== null) {
      const block = match[1];
      const typeAttrMatch = match[0].match(/\btype=["']([^"']+)["']/);
      const scopeMatch = block.match(/<scope>([\s\S]*?)<\/scope>/i);
      const contentMatch = block.match(/<content>([\s\S]*?)<\/content>/i);
      const content = contentMatch ? contentMatch[1].trim() : "";
      if (content) {
        result.facts.push({
          type: typeAttrMatch ? typeAttrMatch[1] : "project",
          content: content.slice(0, 500),
          scope: scopeMatch ? scopeMatch[1].trim() : "project",
        });
      }
    }
  }

  // decisions
  const decisionsSection = trimmed.match(/<decisions>([\s\S]*?)<\/decisions>/i);
  if (decisionsSection) {
    const decisionBlockRegex = /<decision(?:\s[^>]*)?>([\s\S]*?)<\/decision>/gi;
    let match;
    while ((match = decisionBlockRegex.exec(decisionsSection[1])) !== null) {
      const d = match[1].trim();
      if (d) result.decisions.push(d.slice(0, 300));
    }
  }

  // entities
  const entitiesSection = trimmed.match(/<entities>([\s\S]*?)<\/entities>/i);
  if (entitiesSection) {
    const entityBlockRegex = /<entity(?:\s[^>]*)?>([\s\S]*?)<\/entity>/gi;
    let match;
    while ((match = entityBlockRegex.exec(entitiesSection[1])) !== null) {
      const block = match[1];
      const typeAttrMatch = match[0].match(/\btype=["']([^"']+)["']/);
      const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
      const ctxMatch = block.match(/<context>([\s\S]*?)<\/context>/i);
      if (nameMatch) {
        result.entities.push({
          type: typeAttrMatch ? typeAttrMatch[1] : "concept",
          name: nameMatch[1].trim(),
          context: ctxMatch ? ctxMatch[1].trim().slice(0, 200) : "",
        });
      }
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

/**
 * Check if extraction meets minimum quality bar
 * @param {ExtractionResult} result
 * @param {number} minFacts
 * @returns {boolean}
 */
export function meetsQualityBar(result, minFacts = 1) {
  return result.valid && result.facts.length >= minFacts;
}
```

---

### 3.3 `ops/extract-transcript.mjs` — Transcript 构建器

```javascript
// ops/extract-transcript.mjs
// ---------------------------
// Build LLM-extractable transcript from Claude Code transcript（ESM）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_HEAD_TOKENS = 500;
const MAX_TAIL_TOKENS = 500;
const TOOL_RESULT_MAX_CHARS = 2000; // truncate long tool results

/**
 * Rough token estimate: Chinese ≈ 2 chars/token, English ≈ 4 chars/token
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 2 + otherChars / 4);
}

/**
 * Truncate text to approximately maxTokens
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
function truncateToTokens(text, maxTokens) {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;
  // Linear approximation with safety margin
  const ratio = (maxTokens / estimated) * 0.85;
  return text.slice(0, Math.floor(text.length * ratio)) + "\n...（已截断）";
}

/**
 * Build extraction transcript
 * Strategy: head(500t) + all tool-results + tail(500t)
 *
 * @param {string[]} lines
 * @param {Object} opts
 * @param {number} opts.maxHeadTokens
 * @param {number} opts.maxTailTokens
 * @returns {string}
 */
export function buildExtractionTranscript(lines, opts = {}) {
  const {
    maxHeadTokens = MAX_HEAD_TOKENS,
    maxTailTokens = MAX_TAIL_TOKENS,
  } = opts;

  if (!lines || lines.length === 0) return "";

  const totalLines = lines.length;
  // Head: first 15% of lines (user intent / session goal)
  const headCut = Math.max(5, Math.floor(totalLines * 0.15));
  // Tail: last 15% of lines (recent context / next steps)
  const tailCut = Math.max(5, Math.floor(totalLines * 0.15));
  // Middle: all lines between head and tail
  const middleStart = headCut;
  const middleEnd = totalLines - tailCut;

  const headLines = lines.slice(0, headCut);
  const middleLines = lines.slice(middleStart, Math.max(middleStart, middleEnd));
  const tailLines = lines.slice(Math.max(headCut, totalLines - tailCut));

  /** Truncate lines that exceed max char limit (tool outputs) */
  const truncateLine = (line) =>
    line.length > TOOL_RESULT_MAX_CHARS
      ? line.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...（输出已截断）"
      : line;

  return [
    "=== 会话开头（用户意图）===",
    truncateToTokens(headLines.join("\n"), maxHeadTokens),
    "\n=== 工具交互 ===",
    middleLines.map(truncateLine).join("\n"),
    "\n=== 会话结尾（最近上下文）===",
    truncateToTokens(tailLines.join("\n"), maxTailTokens),
  ].join("\n");
}

/**
 * Load Claude Code transcript file
 * Claude Code transcript format: plain text or JSONL (each line is a JSON object)
 *
 * @param {string} transcriptPath
 * @returns {{lines: string[], raw: string}}
 */
export function loadTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`transcript-not-found: ${transcriptPath}`);
  }

  const raw = fs.readFileSync(transcriptPath, "utf-8");
  if (!raw.trim()) {
    throw new Error("transcript-empty");
  }

  let lines;
  const firstLine = raw.split("\n")[0].trim();

  // Try JSONL format first (Claude Code 1.0+)
  if (firstLine.startsWith("{")) {
    lines = raw
      .split("\n")
      .map((l) => {
        l = l.trim();
        if (!l) return "";
        try {
          const obj = JSON.parse(l);
          // Claude Code transcript JSON: { type, text, ... }
          return obj.text || obj.content || "";
        } catch {
          return l;
        }
      })
      .filter(Boolean);
  } else {
    // Plain text format
    lines = raw.split("\n");
  }

  return { lines, raw };
}
```

---

### 3.4 `ops/extraction-pipeline.mjs` — 核心提取引擎

**关键修正**：
- 全部 ESM（无 `require`）
- `generateId` 内联实现（`crypto.randomUUID()`）
- `getProjectsRoot` / `resolveStoreRoot` 改用 `createRequire` 动态加载 CJS 模块

```javascript
// ops/extraction-pipeline.mjs
// ===========================
// Core extraction pipeline: transcript → LLM → structured facts → JSONL
//
// 全部 ESM，不混用 require。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 动态加载 CJS 模块（避免 ESM/CJS 混用）
const { resolveStoreRoot, getProjectsRoot } = require("../bus/store-root.js");

import { buildExtractionPrompt, setUserIdentityContext } from "./extraction-prompt.mjs";
import { parseExtractionXml, meetsQualityBar } from "./extraction-validate.mjs";
import { buildExtractionTranscript, loadTranscript } from "./extract-transcript.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_RECORD_SCHEMA_VERSION = 2;
const PENDING_FILE = "extraction-pending.jsonl";
const LLM_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LLM_PROVIDER = process.env.AI_MEMORY_LLM_PROVIDER || "openai";
const LLM_MODEL = process.env.AI_MEMORY_LLM_MODEL || "gpt-4o";
const LLM_API_KEY = process.env.OPENAI_API_KEY || "";
const LLM_BASE_URL =
  process.env.AI_MEMORY_LLM_BASE_URL || "https://api.openai.com/v1";

// ---------------------------------------------------------------------------
// ID generation (inline — memory-contract.js 无此函数)
// ---------------------------------------------------------------------------

/**
 * Generate a unique record ID
 * @returns {string}
 */
export function generateId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Memory record validation (inline subset of memory-contract.js logic)
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set(["user", "project", "feedback", "reference"]);

/**
 * Basic record validation — returns true if valid, string error if not
 * @param {Object} record
 * @returns {true | string}
 */
function validateRecord(record) {
  if (!record || typeof record !== "object") return "not-an-object";
  const required = ["schemaVersion", "id", "tool", "type", "title", "source", "scope"];
  for (const field of required) {
    if (!record[field]) return `missing-field: ${field}`;
  }
  if (record.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
    return `wrong-schema-version: ${record.schemaVersion}`;
  }
  if (!VALID_SCOPES.has(record.scope)) {
    return `invalid-scope: ${record.scope}`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// LLM API
// ---------------------------------------------------------------------------

/**
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callLLM(prompt) {
  if (!LLM_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`llm-api-error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/** Append one line to a JSONL file */
function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj);
  fs.appendFileSync(filePath, line + "\n", "utf-8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

/** Load user-identity.md for prompt injection */
function loadUserIdentityContext(storeRoot) {
  const identityPath = path.join(storeRoot, "user-identity.md");
  if (!fs.existsSync(identityPath)) return "";
  return fs.readFileSync(identityPath, "utf-8");
}

/** Load last 5 facts from project.jsonl for prompt injection */
function loadProjectContext(projectJsonlPath) {
  if (!fs.existsSync(projectJsonlPath)) return "";
  const lines = fs
    .readFileSync(projectJsonlPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-5) // last 5 entries
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);

  if (lines.length === 0) return "";
  return (
    "最近项目事实：\n" +
    lines
      .map((r) => `- [${r.type || "?"}] ${(r.content || r.title || "").slice(0, 150)}`)
      .join("\n")
  );
}

// ---------------------------------------------------------------------------
// Record building
// ---------------------------------------------------------------------------

/**
 * Convert parsed extraction into memory record objects
 * @param {Object} parsed
 * @param {{project: string, tool: string, sessionId: string}} meta
 * @returns {Object[]}
 */
function buildRecords(parsed, { project, tool, sessionId }) {
  const base = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: generateId(),
    tool,
    session: sessionId,
    project,
    source: "extraction",
    memory_level: "session", // Week 2: all session-durable; Week 3 adds tiering
    confidence: parsed.confidence,
  };

  const records = [];

  // Summary record (optional — only if there are facts or decisions)
  if (parsed.facts.length > 0 || parsed.decisions.length > 0) {
    records.push({
      ...base,
      type: parsed.session_type,
      title: `会话提取：${parsed.session_type}`,
      content: parsed.decisions.length > 0
        ? "decisions: " + parsed.decisions.join(" | ")
        : parsed.facts[0]?.content || "",
      facts: parsed.facts.map((f) => f.content),
      scope: "project",
      concepts: parsed.entities.map((e) => e.name),
    });
  }

  // Individual fact records (top 5 — avoid noise)
  for (const fact of parsed.facts.slice(0, 5)) {
    records.push({
      ...base,
      id: generateId(),
      type: fact.type,
      title: fact.content.slice(0, 80),
      content: fact.content,
      scope: VALID_SCOPES.has(fact.scope) ? fact.scope : "project",
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {string} opts.transcriptPath
 * @param {string} [opts.project]
 * @param {string} [opts.tool]
 * @param {string} [opts.sessionId]
 * @returns {Promise<{ok: boolean, [key: string]: any}>}
 */
export async function runExtraction(opts) {
  const {
    transcriptPath,
    project = path.basename(process.cwd()),
    tool = "claude-code",
    sessionId = "",
  } = opts;

  const storeRoot = resolveStoreRoot();
  const projectsRoot = getProjectsRoot(storeRoot);
  const projectJsonlPath = path.join(projectsRoot, `${project}.jsonl`);
  const pendingPath = path.join(storeRoot, PENDING_FILE);

  ensureDir(projectsRoot);

  // Step 1: Build transcript
  let transcript;
  try {
    const { lines } = loadTranscript(transcriptPath);
    transcript = buildExtractionTranscript(lines);
  } catch (err) {
    return { ok: false, error: `transcript-load-failed: ${err.message}` };
  }

  if (!transcript || transcript.length < 100) {
    return { ok: false, error: "transcript-too-short" };
  }

  // Step 2: Inject context into prompt
  setUserIdentityContext(loadUserIdentityContext(storeRoot));
  const projectContext = loadProjectContext(projectJsonlPath);
  const prompt = buildExtractionPrompt(transcript, projectContext);

  // Step 3: Call LLM
  let llmResponse;
  try {
    llmResponse = await callLLM(prompt);
  } catch (err) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath,
      project,
      tool,
      session_id: sessionId,
      failed_reason: err.message,
    });
    return { ok: false, error: `llm-call-failed: ${err.message}`, fallback: "pending" };
  }

  // Step 4: Parse XML
  const parsed = parseExtractionXml(llmResponse);

  // 修正：minFacts=1 是命名实参语法错误，直接传数字
  if (!meetsQualityBar(parsed, 1)) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath,
      project,
      tool,
      session_id: sessionId,
      llm_response: llmResponse.slice(0, 500),
      parse_errors: parsed.errors,
      facts_count: parsed.facts.length,
    });
    return {
      ok: false,
      error: "quality-bar-not-met",
      parse_errors: parsed.errors,
      facts_extracted: parsed.facts.length,
      fallback: "pending",
    };
  }

  // Step 5: Build + validate records
  const records = buildRecords(parsed, { project, tool, sessionId });
  const validRecords = records.filter((r) => validateRecord(r) === true);

  if (validRecords.length === 0) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath,
      project,
      tool,
      session_id: sessionId,
      llm_response: llmResponse.slice(0, 500),
      failed_reason: "no-valid-records",
    });
    return { ok: false, error: "no-valid-records", fallback: "pending" };
  }

  // Step 6: Write to project.jsonl
  for (const record of validRecords) {
    appendJsonl(projectJsonlPath, record);
  }

  return {
    ok: true,
    records_written: validRecords.length,
    session_type: parsed.session_type,
    confidence: parsed.confidence,
    decisions: parsed.decisions,
    entities: parsed.entities,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, transcriptPath, project = ""] = process.argv;
  if (!transcriptPath) {
    console.error("Usage: node extraction-pipeline.mjs <transcript-path> [project]");
    process.exit(1);
  }
  runExtraction({ transcriptPath, project })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

---

### 3.5 `scripts/extraction-session-start.mjs` — SessionStart Hook（注入逻辑）

**这是原计划的缺失部分**，Stop Hook 写入了，SessionStart 读取注入才能形成闭环：

```javascript
// scripts/extraction-session-start.mjs
// ===================================
// Claude Code SessionStart Hook: 读取 global.md + project.jsonl → 打印到 stdout
// Claude Code 会把 stdout 内容注入到会话上下文
//
// 修正：Claude Code SessionStart Hook 通过 stdin JSON 接收启动信息，
//       但本脚本主要通过文件读取获取上下文，不依赖 hook 传入的数据。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { resolveStoreRoot, getProjectsRoot } = require("../bus/store-root.js");

const MAX_INJECT_TOKENS = 800; // Claude Code 上下文预算

/**
 * Rough token count (same logic as extract-transcript.mjs)
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil((text.length - chineseChars) / 4 + chineseChars / 2);
}

/**
 * Truncate text to fit within token budget
 */
function fitTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const ratio = (maxTokens / estimateTokens(text)) * 0.85;
  return text.slice(0, Math.floor(text.length * ratio)) + "\n…";
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8").trim();
}

async function main() {
  // Read Claude Code SessionStart stdin (discard — not needed for context)
  // Claude Code SessionStart passes: { session_id, cwd, ... }
  // We derive project from cwd, not from stdin.
  for await (const _line of createInterface({ input: process.stdin })) {
    // Drain stdin
  }

  const storeRoot = resolveStoreRoot();
  const projectsRoot = getProjectsRoot(storeRoot);

  // Detect project from cwd
  const cwd = process.cwd();
  const project = path.basename(cwd) || "default";

  const lines = [];

  lines.push("=" .repeat(60));
  lines.push(`[Memory] Session started — project: ${project}`);
  lines.push("=" .repeat(60));

  // L0: user-identity.md
  const identityPath = path.join(storeRoot, "user-identity.md");
  const identity = readText(identityPath);
  if (identity) {
    lines.push("\n## 用户身份（必读）");
    lines.push(fitTokens(identity, 200));
  }

  // L1: recent facts from project.jsonl (last 10)
  const projectJsonlPath = path.join(projectsRoot, `${project}.jsonl`);
  if (fs.existsSync(projectJsonlPath)) {
    const rawLines = fs
      .readFileSync(projectJsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-10)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .reverse();

    if (rawLines.length > 0) {
      lines.push(`\n## 最近项目记忆（${project}）`);
      for (const r of rawLines) {
        const date = (r.t || "").slice(0, 10);
        const tag = r.type || "?";

        // Build compact line: "[date] [type] content..."
        let line = `[${date}] [${tag}] `;
        if (r.content) {
          line += r.content.slice(0, 120);
        } else if (r.title) {
          line += r.title.slice(0, 120);
        } else if (r.facts && r.facts[0]) {
          line += r.facts[0].slice(0, 120);
        }
        lines.push(fitTokens(line, 150));
      }
    }
  }

  lines.push("\n" + "=".repeat(60));
  lines.push("[Memory] End of injected context");

  console.log(lines.join("\n"));
}

main().catch((err) => {
  // Never fail silently — print warning to stderr so Claude Code notices
  console.error("[Memory SessionStart] Warning: failed to load context —", err.message);
  process.exit(0); // Hook must exit 0, never crash
});
```

**PowerShell 包装器（SessionStart Hook 配置用）**：

```powershell
# scripts/extraction-session-start.ps1
# ================================
# Claude Code SessionStart Hook wrapper

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptRoot/..").Path

# 修正：直接调用 node，不走 .bin 路径
node "$ProjectRoot\scripts\extraction-session-start.mjs"
```

---

### 3.6 `scripts/extraction-stop-hook.ps1` — Stop Hook 入口（修正版）

```powershell
# scripts/extraction-stop-hook.ps1
# ================================
# Claude Code Stop Hook: 触发提取管道
#
# Claude Code Stop Hook 通过 stdin JSON 传入数据：
# {
#   "transcript_path": "C:/.../.claude/transcripts/xxx.jsonl",
#   "session_id": "...",
#   "cwd": "C:/.../project",
#   ...
# }

param(
    [switch]$DryRun
)

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptRoot/..").Path

# 修正：从 stdin 读取 JSON，而非环境变量
$hookData = $input | ConvertFrom-Json

$TranscriptPath = $hookData.transcript_path
$SessionId = $hookData.session_id
$Cwd = $hookData.cwd

# Project 从 cwd 推断
$Project = Split-Path -Leaf $Cwd
if (-not $Project) { $Project = "default" }

if ($DryRun) {
    Write-Host "[extraction-stop-hook] Dry run: transcript=$TranscriptPath project=$Project session=$SessionId"
    exit 0
}

if (-not $TranscriptPath) {
    Write-Error "[extraction-stop-hook] Error: transcript_path not provided in hook data"
    exit 1
}

if (-not (Test-Path -LiteralPath $TranscriptPath)) {
    Write-Error "[extraction-stop-hook] Error: transcript not found at $TranscriptPath"
    exit 1
}

# 修正：直接用 node 命令，不拼接 .bin 路径
node "$ProjectRoot\ops\extraction-pipeline.mjs" $TranscriptPath $Project $SessionId

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Error "[extraction-stop-hook] Pipeline failed with exit code $exitCode"
} else {
    Write-Host "[extraction-stop-hook] Extraction complete"
}

exit $exitCode
```

---

## 四、Claude Code 配置

### Stop Hook（`~/.claude/settings.json`）

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "pwsh ABSOLUTE/PATH/TO/extraction-stop-hook.ps1",
        "timeout": 90
      }]
    }]
  }
}
```

### SessionStart Hook（`~/.claude/settings.json`）

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "pwsh ABSOLUTE/PATH/TO/extraction-session-start.ps1",
        "timeout": 30
      }]
    }]
  }
}
```

### 环境变量（`~/.claude/settings.local.json`，不提交到 git）

```json
{
  "env": {
    "AI_MEMORY_LLM_PROVIDER": "openai",
    "AI_MEMORY_LLM_MODEL": "gpt-4o",
    "AI_MEMORY_LLM_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

---

## 五、测试计划

| 测试用例 | 操作 | 预期 |
|---------|------|------|
| `extraction-validate.mjs` | 完整 XML → `parseExtractionXml()` | `valid=true`，所有字段正确解析 |
| `extraction-validate.mjs` | 缺失 `confidence` | `errors=["confidence must be 0.0-1.0"]` |
| `extraction-validate.mjs` | `session_type="unknown"` | `errors=["unknown session_type: unknown"]` |
| `extraction-validate.mjs` | `facts=[]` → `meetsQualityBar(r, 1)` | `false`（触发 pending） |
| `extract-transcript.mjs` | 100 行 transcript | head 约 500t + tool results + tail 约 500t |
| `extract-transcript.mjs` | 空文件 | 抛出 `transcript-empty` |
| `extraction-pipeline.mjs` | 无 API Key | 抛出 `OPENAI_API_KEY not set` |
| `extraction-pipeline.mjs` | LLM 返回 500 | pending.jsonl 写入，返回 `fallback: "pending"` |
| E2E（mock LLM） | transcript + mock response | project.jsonl 写入 N 条有效记录 |

---

## 六、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| LLM API 超时/失败 | 记忆丢失 | pending.jsonl 降级，cron job 重试 |
| XML 解析失败（LLM 乱输出） | 静默丢弃 | 解析失败也写入 pending.jsonl |
| API Key 未配置 | 完全不工作 | 启动时 `if (!LLM_API_KEY) throw` 明确报错 |
| Stop Hook 超时（90s 不够） | Hook 被 kill | prompt 设计控制在 600ms 内返回；超时加大 timeout |
| 空会话（只问了一个问题） | 提取质量差 | `transcript.length < 100` 短路直接跳过 |
| 模块路径问题（ESM/CJS 混用） | runtime 报错 | 全部 `.mjs` 扩展名 + `createRequire` 动态加载 CJS |

---

## 七、里程碑

```
Day 1: extraction-prompt.mjs + extraction-validate.mjs
       → 用 node --test 写 XML 解析单元测试

Day 2: extract-transcript.mjs
       → 准备测试用 transcript fixture 文件

Day 3: extraction-pipeline.mjs（核心编排）
       → 集成 Day 1-2 模块，测试 LLM 调用（含 mock）

Day 4: extraction-stop-hook.ps1 + extraction-session-start.mjs + Claude Code 配置
       → 配置 Hook + 验证 stdout 注入

Day 5: 集成测试 + pending.jsonl 重试机制（cron）+ 提交
```

---

## 八、现有代码改动汇总

| 文件 | 改动 |
|------|------|
| `bus/store-root.js` | **无需改动**，`getProjectsRoot` 已导出 ✅ |
| `ops/memory-contract.js` | **无需改动**，`generateId` 改为内联实现 ✅ |
| `ops/generate-context.js` | **无需改动**，pipeline 不直接依赖 ✅ |
| `ops/entity-extractor.js` | **无需改动**，pipeline 可独立运行 ✅ |
| `shared-mcp/omni-memory-server.js` | **Day 5 可选**：注册 `manual_extract` MCP 工具，本周不做 |
