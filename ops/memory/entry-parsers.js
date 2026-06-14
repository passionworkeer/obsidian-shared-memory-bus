// ops/memory/entry-parsers.js
// Entry parsers that read inbox/events/session/task memory sources and
// produce structured records. Extracted from memory-layers-parse.js so the
// top-level module can stay a thin barrel.

import fs from "node:fs";
import path from "node:path";
import {
  buildRecord,
  classifyScope,
  loadStructuredRecords,
  normalizeSpaces,
  parseTimestamp,
  sha1,
  sha256,
} from "./record-coercion.js";
import {
  CLAUDE_CODE_JSONL, CLAUDE_HOME, EVENTS_ROOT, INBOX_ROOT,
  OPENCLAW_BLACKBOARD_JSONL, OPENCLAW_HOME, OPENCLAW_JOURNAL_JSONL,
  OPENCLAW_JOBS_JSONL, OPENCLAW_RUNS_JSONL, OPENCLAW_SESSIONS_JSONL,
  readText, safeRealpathWithin,
  SESSION_MEMORY_JSONL, SHARED_EVENTS_JSONL, SHARED_INBOX_JSONL,
  TASK_MEMORY_JSONL,
} from "./paths-and-io.js";

function parseInboxEntries() {
  const records = [];
  if (!fs.existsSync(INBOX_ROOT)) {
    return records;
  }

  // The \[ and \] below are intentional: outside a regex character class
  // `[]` would open/close a class, so escaping is required to match a
  // literal `[` / `]`. ESLint's no-useless-escape heuristic doesn't know
  // this and is suppressed locally.
  // eslint-disable-next-line no-useless-escape
  const linePattern = /^-\s+\[(?<timestamp>[^\]]+)\]\s+\[(?<project>[^\]]+)\]\s*(?<content>.+)$/;
  const files = fs
    .readdirSync(INBOX_ROOT)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort();

  for (const fileName of files) {
    const tool = path.basename(fileName, ".md");
    const filePath = path.join(INBOX_ROOT, fileName);
    // SECURITY: skip files whose realpath escapes INBOX_ROOT (e.g. symlink
    // planted in vault by another app on a synced filesystem).
    if (!safeRealpathWithin(filePath, INBOX_ROOT)) {
      process.stderr.write(`[parse-inbox] skipping path that escapes INBOX_ROOT: ${filePath}\n`);
      continue;
    }
    const lines = readText(filePath).split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(linePattern);
      if (!match || !match.groups) {
        continue;
      }
      const timestamp = parseTimestamp(match.groups.timestamp);
      const project = normalizeSpaces(match.groups.project);
      const content = match.groups.content.trim();
      const classification = classifyScope(content, tool);
      const id = `inbox-${sha1(`${tool}|${project}|${match.groups.timestamp}|${content}`)}`;
      const contentHash = sha256(content);
      records.push(
        buildRecord({
          id,
          t: timestamp,
          tool,
          type: classification.type,
          project,
          title: content,
          content,
          source: "shared-inbox",
          scope: classification.scope,
          visibility: classification.visibility,
          source_kind: "writeback",
          memory_level: "durable",
          workspace: project,
          confidence: classification.confidence,
          metadata: {
            origin_path: filePath,
          },
          content_hash: contentHash,
        })
      );
    }
  }

  return records.sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function parseEventEntries() {
  const records = [];
  if (!fs.existsSync(EVENTS_ROOT)) {
    return records;
  }

  const files = fs
    .readdirSync(EVENTS_ROOT)
    .filter((fileName) => fileName.endsWith(".jsonl"))
    .sort()
    .slice(-2);

  for (const fileName of files) {
    const filePath = path.join(EVENTS_ROOT, fileName);
    if (!safeRealpathWithin(filePath, EVENTS_ROOT)) {
      process.stderr.write(`[parse-event] skipping path that escapes EVENTS_ROOT: ${filePath}\n`);
      continue;
    }
    const lines = readText(filePath).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const tool = normalizeSpaces(payload.tool || "system") || "system";
      const project = normalizeSpaces(payload.project || "");
      const content = normalizeSpaces(payload.summary || "");
      if (!content) {
        continue;
      }
      const classification = classifyScope(content, tool);
      const id = `event-${sha1(`${tool}|${payload.timestamp}|${content}`)}`;
      records.push(
        buildRecord({
          id,
          t: payload.timestamp || null,
          tool,
          type: classification.type,
          project,
          title: content,
          content,
          source: "memory-bus-event",
          scope: classification.scope,
          visibility: "shared",
          source_kind: "hook",
          memory_level: "session",
          workspace: project,
          confidence: classification.confidence,
          metadata: {
            origin_path: filePath,
          },
        })
      );
    }
  }

  return records.sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

async function parseSessionMemoryEntries() {
  const records = [];

  const claudeSessionPath = path.join(CLAUDE_HOME, "session-memory", "session-memory.md");
  const claudeSessionDir = path.dirname(claudeSessionPath);
  if (fs.existsSync(claudeSessionPath) && safeRealpathWithin(claudeSessionPath, claudeSessionDir)) {
    const content = readText(claudeSessionPath).trim();
    if (content) {
      const stat = fs.statSync(claudeSessionPath);
      records.push(
        buildRecord({
          id: `session-${sha1(`claude|${stat.mtimeMs}|${content.slice(0, 256)}`)}`,
          t: stat.mtime.toISOString(),
          tool: "claude-code",
          type: "session-summary",
          project: "shared-session",
          title: "Claude session memory snapshot",
          content: content.slice(0, 6000),
          source: "claude-session-memory",
          scope: "summary",
          visibility: "shared",
          source_kind: "session",
          memory_level: "session",
          workspace: "claude-session",
          confidence: 0.78,
          metadata: {
            origin_path: claudeSessionPath,
          },
        })
      );
    }
  }

  const openclawMemoryDir = path.join(OPENCLAW_HOME, "workspace", "memory");
  if (fs.existsSync(openclawMemoryDir)) {
    const files = fs
      .readdirSync(openclawMemoryDir)
      .filter((fileName) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(fileName))
      .sort()
      .slice(-7);
    for (const fileName of files) {
      const filePath = path.join(openclawMemoryDir, fileName);
      if (!safeRealpathWithin(filePath, openclawMemoryDir)) {
        process.stderr.write(`[parse-session] skipping path that escapes openclawMemoryDir: ${filePath}\n`);
        continue;
      }
      const content = readText(filePath).trim();
      if (!content) {
        continue;
      }
      const stat = fs.statSync(filePath);
      records.push(
        buildRecord({
          id: `session-${sha1(`openclaw|${fileName}|${stat.mtimeMs}`)}`,
          t: stat.mtime.toISOString(),
          tool: "openclaw",
          type: "daily-summary",
          project: "workspace",
          title: `OpenClaw daily memory ${path.basename(fileName, ".md")}`,
          content: content.slice(0, 6000),
          source: "openclaw-daily-memory",
          scope: "summary",
          visibility: "shared",
          source_kind: "session",
          memory_level: "session",
          workspace: "openclaw-workspace",
          confidence: 0.72,
          metadata: {
            origin_path: filePath,
          },
        })
      );
    }
  }

  // Stream structured JSONL files — never load entire files into memory.
  // Uses createJsonlStream + coerceStructuredRecord (same coercion logic as
  // parseStructuredJsonl but in a memory-efficient streaming mode).
  const [claudeRecords, openclawRecords] = await Promise.all([
    loadStructuredRecords(CLAUDE_CODE_JSONL, {
      prefix: "claude-import",
      tool: "claude-code",
      source: "claude-mem",
      scope: "summary",
      visibility: "shared",
      source_kind: "session",
      memory_level: "session",
      workspace: "claude-session",
      confidence: 0.72,
    }),
    loadStructuredRecords(OPENCLAW_SESSIONS_JSONL, {
      prefix: "openclaw-session",
      tool: "openclaw",
      source: "openclaw-session",
      scope: "summary",
      visibility: "shared",
      source_kind: "session",
      memory_level: "session",
      workspace: "openclaw-workspace",
      confidence: 0.62,
    }),
  ]);

  const merged = new Map();
  for (const record of [...records, ...claudeRecords, ...openclawRecords]) {
    merged.set(record.id, record);
  }

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

/**
 * Async streaming version of parseTaskMemoryEntries.
 * Uses createJsonlStream to avoid loading large openclaw JSONL files into memory.
 * Parallel-loads all four source files for performance.
 */
async function parseTaskMemoryEntries() {
  const sources = [
    {
      filePath: OPENCLAW_BLACKBOARD_JSONL,
      defaults: {
        prefix: "task",
        source: "openclaw-blackboard",
        scope: "task",
        source_kind: "blackboard",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_RUNS_JSONL,
      defaults: {
        prefix: "run",
        source: "openclaw-run-ledger",
        scope: "run",
        source_kind: "run",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_JOBS_JSONL,
      defaults: {
        prefix: "job",
        source: "openclaw-cron-job",
        scope: "task",
        source_kind: "cron",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
    {
      filePath: OPENCLAW_JOURNAL_JSONL,
      defaults: {
        prefix: "journal",
        source: "openclaw-blackboard-journal",
        scope: "run",
        source_kind: "blackboard",
        memory_level: "task",
        workspace: "ai-shrimp",
      },
    },
  ];

  // Stream all four source files in parallel — each uses createJsonlStream
  // internally so no single file is fully buffered in memory.
  const sourceArrays = await Promise.all(
    sources.map((src) => loadStructuredRecords(src.filePath, src.defaults))
  );

  const merged = new Map();
  for (const records of sourceArrays) {
    for (const record of records) {
      merged.set(record.id, record);
    }
  }

  return [...merged.values()].sort((left, right) => String(left.t || "").localeCompare(String(right.t || "")));
}

function preserveDreamRecords(existingRecords) {
  // Preserve records written by run-memory-dream.ps1 (source_kind=writeback)
  // so they are not wiped when build-memory-layers.js overwrites shared-inbox.jsonl
  return existingRecords.filter(
    (record) =>
      record &&
      (record.source_kind === "writeback" || (record.id && String(record.id).startsWith("dream-")))
  );
}

/**
 * Get the target JSONL file path for a record based on its memory_level/scope.
 * @param {object} record
 * @returns {string|null}
 */
function getTargetJsonl(record) {
  const scope = record.scope || "";
  const level = record.memory_level || record.memoryLevel || "";
  if (scope === "session" || level === "session") return SESSION_MEMORY_JSONL;
  if (scope === "task" || level === "task" || record.type === "task-note" || record.type === "task-job")
    return TASK_MEMORY_JSONL;
  if (record.type === "event" || scope === "event") return SHARED_EVENTS_JSONL;
  return SHARED_INBOX_JSONL;
}

/**
 * Resolve @include directives in markdown content.
 * Syntax: @include filename.md
 * Resolves relative to baseDir. Absolute paths are rejected.
 * Nested @include supported up to depth 5. Visited paths are tracked
 * to prevent cycles via mutually-referencing files of depth 2.
 *
 * @param {string} content
 * @param {string} baseDir  - directory to resolve relative paths against
 * @param {number} [maxDepth=5]
 * @param {number} [currentDepth=0]
 * @param {Set<string>} [_visited] - internal: tracks realpath of visited files
 * @returns {{ content: string, includes_resolved: string[], depth: number }}
 */
function resolveIncludes(content, baseDir, maxDepth = 5, currentDepth = 0, _visited = new Set()) {
  if (currentDepth >= maxDepth) {
    process.stderr.write(`[resolve-include] max depth ${maxDepth} reached, stopping\n`);
    return { content, includes_resolved: [], depth: currentDepth };
  }

  const includePattern = /^@include\s+(.+)$/gm;
  const includes_resolved = [];
  let resolved = content;
  let match;

  // Reset lastIndex before iteration
  includePattern.lastIndex = 0;
  while ((match = includePattern.exec(content)) !== null) {
    const includePath = match[1].trim();

    // SECURITY: reject absolute paths. @include should only resolve within
    // the source file's directory tree. This blocks the path where a hostile
    // inbox entry does `@include C:\Users\victim\.ssh\id_rsa` to leak
    // host files into every agent's global context.
    if (path.isAbsolute(includePath)) {
      process.stderr.write(`[resolve-include] absolute paths not allowed: ${includePath}\n`);
      continue;
    }

    const fullPath = path.resolve(baseDir, includePath);

    // SECURITY: resolve symlinks and verify the target stays within baseDir.
    // Blocks symlink-based escapes where a path component inside baseDir
    // is a symlink to /etc/passwd, ~/.ssh, etc.
    let realPath;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch (err) {
      process.stderr.write(`[resolve-include] realpath error ${fullPath}: ${err.message}\n`);
      continue;
    }
    const realBase = fs.realpathSync(baseDir);
    if (!realPath.startsWith(realBase + path.sep) && realPath !== realBase) {
      process.stderr.write(`[resolve-include] path escapes baseDir: ${realPath}\n`);
      continue;
    }

    // Cycle detection: skip files we have already visited at this branch.
    if (_visited.has(realPath)) {
      process.stderr.write(`[resolve-include] already visited: ${realPath}\n`);
      continue;
    }
    _visited.add(realPath);

    if (!fs.existsSync(realPath)) {
      process.stderr.write(`[resolve-include] file not found: ${realPath}\n`);
      continue;
    }

    let includedContent;
    try {
      includedContent = fs.readFileSync(realPath, "utf8");
    } catch (err) {
      process.stderr.write(`[resolve-include] read error ${realPath}: ${err.message}\n`);
      continue;
    }

    includes_resolved.push(includePath);

    // Recursively resolve nested includes. Pass a copy of _visited so sibling
    // branches can independently include the same file.
    const nested = resolveIncludes(
      includedContent,
      path.dirname(realPath),
      maxDepth,
      currentDepth + 1,
      new Set(_visited)
    );

    resolved = resolved.replace(match[0], nested.content);
    includes_resolved.push(...nested.includes_resolved);
  }

  return { content: resolved, includes_resolved, depth: currentDepth };
}

export {
  parseInboxEntries, parseEventEntries, parseSessionMemoryEntries, parseTaskMemoryEntries,
  preserveDreamRecords, getTargetJsonl, resolveIncludes,
};
