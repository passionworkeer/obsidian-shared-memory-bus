// Claude Code Stop Hook: extract structured session facts into the local store.

import { existsSync, mkdirSync, readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStoreRoot, getProjectsRoot } from '../../bus/store-root.js';
import { appendJsonlRecord } from './src/jsonl-queue.mjs';
import { parseExtraction } from './src/parser.mjs';
import { validateTranscriptPath } from './src/transcript-path.mjs';

const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:15721';
const MODEL = process.env.AI_MEMORY_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 8000;

function getProjectJsonlPath(cwd, storeRoot = resolveStoreRoot()) {
  const name = path.basename(cwd || 'default') || 'default';
  const root = getProjectsRoot(storeRoot);
  mkdirSync(root, { recursive: true });
  return path.join(root, `${name}.jsonl`);
}

function getPendingPath(storeRoot = resolveStoreRoot()) {
  return path.join(storeRoot, 'pending-extractions.jsonl');
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(chunks.join('') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function isSessionProcessed(jsonlPath, sessionId) {
  if (!existsSync(jsonlPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let found = false;
    const reader = createInterface(createReadStream(jsonlPath, { encoding: 'utf8' }));
    reader.on('line', (line) => {
      if (found) return;
      try {
        if (JSON.parse(line).session_id === sessionId) {
          found = true;
          reader.close();
        }
      } catch {
      }
    });
    reader.on('close', () => resolve(found));
    reader.on('error', () => resolve(false));
  });
}

async function smartSlice(transcriptPath, cwd) {
  const { SmartSlice } = await import('./src/transcript-slicer.mjs');
  return SmartSlice(readFileSync(transcriptPath, 'utf8'), cwd || '');
}

async function extractFacts(content, fetchImpl = globalThis.fetch) {
  const allowedBase = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  if (!allowedBase.test(API_BASE)) {
    throw new Error('ANTHROPIC_BASE_URL must be a localhost/loopback origin');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const systemPrompt = `你是记忆工程师。从会话记录中提取结构化事实。
规则：只提取客观事实，session_type 枚举：bugfix|feature|refactor|discovery|docs|chore
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

async function writeToProjectJsonl(jsonlPath, sessionId, cwd, result, failed = false) {
  const now = new Date().toISOString();
  await appendJsonlRecord(jsonlPath, {
    id: `rec_${Date.now()}_${process.pid}`,
    session_id: sessionId,
    project: path.basename(cwd || 'default'),
    scope: 'project',
    content: result.summary || result.facts?.[0] || '',
    confidence: result.confidence,
    facts: result.facts || [],
    decisions: result.decisions || [],
    entities: result.entities || [],
    session_type: result.session_type,
    extraction_failed: failed,
    t: now,
  });
}

async function writePending(sessionId, cwd, transcriptPath, reason, storeRoot) {
  await appendJsonlRecord(getPendingPath(storeRoot), {
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    failed_at: new Date().toISOString(),
    reason,
  });
}

export async function main(inputOverride = null) {
  const input = inputOverride ?? await readStdin();
  const cwd = process.argv[2] || input.cwd || '';
  const sessionId = process.argv[3] || input.session_id || `unknown_${Date.now()}`;
  const transcriptPath = validateTranscriptPath(
    process.argv[4] || input.transcript_path || '',
  );
  if (!transcriptPath) return 0;

  const storeRoot = resolveStoreRoot();
  const jsonlPath = getProjectJsonlPath(cwd, storeRoot);
  if (await isSessionProcessed(jsonlPath, sessionId)) return 0;

  const slice = await smartSlice(transcriptPath, cwd);
  if (!slice?.content?.trim()) return 0;

  try {
    const result = await extractFacts(slice.content);
    await writeToProjectJsonl(jsonlPath, sessionId, cwd, result);
    return 1;
  } catch (error) {
    await writePending(sessionId, cwd, transcriptPath, error.message || 'timeout', storeRoot);
    await writeToProjectJsonl(jsonlPath, sessionId, cwd, {
      summary: '[提取失败，等待补提取]',
      facts: [],
      decisions: [],
      entities: [],
      confidence: 0,
      session_type: 'discovery',
    }, true);
    return 0;
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`[stop-extract] ${error.message}\n`);
      process.exit(0);
    });
}
