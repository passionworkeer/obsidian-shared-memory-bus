// SessionStart Hook: replay extraction requests that previously timed out.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveStoreRoot } from '../../../bus/store-root.js';
import { MEMORY_RECORD_SCHEMA_VERSION } from '../../../ops/memory/memory-contract.js';
import { isSessionProcessed } from './dedup.mjs';
import {
  appendJsonlRecord,
  appendTextUnderLock,
  readJsonlRecords,
  removeJsonlRecords,
} from './jsonl-queue.mjs';
import { parseExtraction } from './parser.mjs';
import { SmartSlice } from './transcript-slicer.mjs';
import { validateTranscriptPath } from './transcript-path.mjs';

const DEFAULT_MAX_REPLAY = 3;
const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721';
const MODEL = process.env.AI_MEMORY_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 5000;

export function resolveReplayPaths(storeRoot = resolveStoreRoot()) {
  return {
    storeRoot,
    pendingPath: path.join(storeRoot, 'pending-extractions.jsonl'),
    sharedInboxPath: path.join(storeRoot, 'structured', 'shared-inbox.jsonl'),
    markdownInboxPath: path.join(storeRoot, 'inbox', 'claude-code.md'),
  };
}

export async function replayPendingExtractions({
  storeRoot = resolveStoreRoot(),
  maxReplay = DEFAULT_MAX_REPLAY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const paths = resolveReplayPaths(storeRoot);
  const pending = await readJsonlRecords(paths.pendingPath);
  if (pending.length === 0) return 0;

  let replayed = 0;
  for (const record of pending) {
    if (replayed >= maxReplay) break;
    if (!record?.session_id) continue;

    if (await isSessionProcessed(paths.sharedInboxPath, record.session_id)) {
      await removeJsonlRecords(
        paths.pendingPath,
        (candidate) => candidate?.session_id === record.session_id,
      );
      continue;
    }

    const transcriptPath = validateTranscriptPath(record.transcript_path || '');
    if (!transcriptPath) {
      process.stderr.write(
        `[replay] transcript missing or outside Claude transcript roots for session ${record.session_id}; keeping request pending\n`,
      );
      continue;
    }

    try {
      const transcript = readFileSync(transcriptPath, 'utf8');
      const slice = SmartSlice(transcript, record.cwd || '');
      if (!slice?.content?.trim()) continue;

      const result = await extractWithTimeout(slice.content, fetchImpl);
      if (!result) continue;

      await writeResult(paths, record, result);
      await removeJsonlRecords(
        paths.pendingPath,
        (candidate) => candidate?.session_id === record.session_id,
      );
      replayed += 1;
    } catch (error) {
      process.stderr.write(
        `[replay] session ${record.session_id} failed again: ${error.message}\n`,
      );
    }
  }

  return replayed;
}

async function extractWithTimeout(content, fetchImpl) {
  const allowedBase = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  if (!allowedBase.test(API_BASE)) {
    throw new Error('ANTHROPIC_BASE_URL must be a localhost/loopback origin');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const systemPrompt = `你是记忆工程师。从会话记录中提取结构化事实。

规则：
- 只提取客观事实
- session_type 枚举：bugfix | feature | refactor | discovery | docs | chore
- entities 类型：module | concept | person | project | decision | bug | api
- confidence：0.0-1.0

输出格式（XML）：
<result>
  <session_type>...</session_type>
  <confidence>0.0</confidence>
  <facts><fact>...</fact></facts>
  <decisions><decision>...</decision></decisions>
  <entities><entity name="..." type="..."/></entities>
  <summary>一行话概括</summary>
</result>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || 'proxy-managed',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: `从以下会话中提取结构化信息：\n\n${content}` }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Extraction endpoint returned HTTP ${response.status}`);
    }
    return parseExtraction(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function normalizeExtraction(result) {
  return {
    session_type: result.session_type || 'discovery',
    confidence: Number.isFinite(result.confidence) ? result.confidence : 0.3,
    summary: result.summary || '',
    facts: Array.isArray(result.facts) ? result.facts : [],
    decisions: Array.isArray(result.decisions) ? result.decisions : [],
    entities: Array.isArray(result.entities) ? result.entities : [],
  };
}

export function buildReplayRecord(record, result, now = new Date()) {
  const normalized = normalizeExtraction(result);
  const createdAt = now.toISOString();
  const content = normalized.summary || normalized.facts.join(' ') || 'Claude Code session extraction';
  const project = path.basename(record.cwd || '') || 'default';

  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: `rec_${randomUUID()}`,
    session_id: record.session_id,
    t: createdAt,
    tool: 'claude-code',
    type: 'session-summary',
    project,
    title: content.slice(0, 140),
    content,
    source: 'claude-code-stop-hook-replay',
    scope: 'project',
    visibility: 'shared',
    source_kind: 'hook',
    memory_level: 'session',
    workspace: record.cwd || project,
    confidence: normalized.confidence,
    tier: 2,
    facts: normalized.facts,
    concepts: normalized.decisions,
    entities: normalized.entities,
    metadata: {
      session_id: record.session_id,
      session_type: normalized.session_type,
      cwd: record.cwd || '',
      replayed: true,
    },
    lifecycle: {
      tier: 2,
      expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      access_count: 0,
      promotion_count: 0,
      archived: false,
    },
    created_at: createdAt,
    updated_at: createdAt,
    extraction_failed: false,
  };
}

async function writeResult(paths, record, result) {
  const now = new Date();
  const normalized = normalizeExtraction(result);
  const date = now.toISOString().slice(0, 10);

  await appendJsonlRecord(paths.sharedInboxPath, buildReplayRecord(record, normalized, now));

  const lines = [
    `## [session] ${normalized.session_type} | ${date} [补提取]`,
    normalized.summary ? `> ${normalized.summary}` : '',
    normalized.facts.length
      ? `**事实：**\n${normalized.facts.map((fact) => `- ${fact}`).join('\n')}`
      : '',
    normalized.decisions.length
      ? `**决策：**\n${normalized.decisions.map((decision) => `- ${decision}`).join('\n')}`
      : '',
    normalized.entities.length
      ? `**实体：**\n${normalized.entities.map((entity) => `- [[${entity.name}]] (${entity.type})`).join('\n')}`
      : '',
    '---',
    `来源：session_${record.session_id} [补提取] | cwd: ${record.cwd || ''}`,
  ].filter(Boolean);
  await appendTextUnderLock(paths.markdownInboxPath, `\n${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  replayPendingExtractions()
    .then((count) => {
      console.log(`补提取完成: ${count} 条`);
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`[replay] ${error.message}\n`);
      process.exit(0);
    });
}
