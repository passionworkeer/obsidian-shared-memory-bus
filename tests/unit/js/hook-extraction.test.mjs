import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExtraction } from '../../../hooks/stop-hook-llm-extract/src/parser.mjs';
import {
  appendJsonlRecord,
  readJsonlRecords,
  removeJsonlRecords,
} from '../../../hooks/stop-hook-llm-extract/src/jsonl-queue.mjs';
import {
  buildReplayRecord,
  resolveReplayPaths,
} from '../../../hooks/stop-hook-llm-extract/src/session-start-replay.mjs';
import { validateTranscriptPath } from '../../../hooks/stop-hook-llm-extract/src/transcript-path.mjs';
import { validateStructuredRecord } from '../../../ops/memory/memory-contract.js';

const temporaryDirectories = [];
afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yt-hook-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('extraction parser', () => {
  test('parses Anthropic text blocks containing XML', () => {
    const result = parseExtraction({
      content: [{
        type: 'text',
        text: '<result><session_type>bugfix</session_type><confidence>0.9</confidence><facts><fact>Fixed the queue</fact></facts><summary>Queue fixed</summary></result>',
      }],
    });
    assert.equal(result.session_type, 'bugfix');
    assert.equal(result.confidence, 0.9);
    assert.deepEqual(result.facts, ['Fixed the queue']);
    assert.equal(result.summary, 'Queue fixed');
  });

  test('parses fenced JSON and clamps confidence', () => {
    const result = parseExtraction('```json\n{"session_type":"feature","confidence":3,"facts":["A"]}\n```');
    assert.equal(result.session_type, 'feature');
    assert.equal(result.confidence, 1);
    assert.deepEqual(result.facts, ['A']);
  });

  test('returns a stable fallback for malformed output', () => {
    const result = parseExtraction('not structured');
    assert.equal(result.session_type, 'discovery');
    assert.equal(result.confidence, 0.3);
    assert.equal(result.summary, 'not structured');
    assert.deepEqual(result.facts, []);
  });
});

describe('replay path resolution', () => {
  test('uses the canonical store root and the same pending path as Stop Hook', () => {
    const root = path.join('tmp', 'memory-store');
    const paths = resolveReplayPaths(root);
    assert.equal(paths.pendingPath, path.join(root, 'pending-extractions.jsonl'));
    assert.equal(paths.sharedInboxPath, path.join(root, 'structured', 'shared-inbox.jsonl'));
    assert.equal(paths.markdownInboxPath, path.join(root, 'inbox', 'claude-code.md'));
  });
});

describe('replay memory contract', () => {
  test('emits a schema-valid structured memory record', () => {
    const record = buildReplayRecord(
      {
        session_id: 'session-1',
        cwd: path.join('workspaces', 'memory-bus'),
      },
      {
        session_type: 'bugfix',
        confidence: 0.9,
        summary: 'Fixed extraction replay',
        facts: ['Replay uses one queue'],
        decisions: ['Validate transcript paths'],
        entities: [{ name: 'replay', type: 'module' }],
      },
      new Date('2026-07-31T00:00:00.000Z'),
    );

    const validation = validateStructuredRecord(record);
    assert.equal(validation.ok, true, validation.errors.join(', '));
    assert.equal(record.source_kind, 'hook');
    assert.equal(record.memory_level, 'session');
    assert.equal(record.session_id, 'session-1');
    assert.equal(record.metadata.session_id, 'session-1');
  });
});

describe('Claude transcript path validation', () => {
  test('accepts project transcripts below the configured Claude home', () => {
    const homeDir = temporaryDirectory();
    const transcript = path.join(
      homeDir,
      '.claude',
      'projects',
      'encoded-project',
      'session.jsonl',
    );
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n', 'utf8');

    assert.equal(
      validateTranscriptPath(transcript, { homeDir, env: {} }),
      path.resolve(transcript),
    );
  });

  test('accepts an explicit CLAUDE_SESSION_DIR', () => {
    const root = temporaryDirectory();
    const transcript = path.join(root, 'session.jsonl');
    writeFileSync(transcript, '{}\n', 'utf8');

    assert.equal(
      validateTranscriptPath(transcript, {
        homeDir: temporaryDirectory(),
        env: { CLAUDE_SESSION_DIR: root },
      }),
      path.resolve(transcript),
    );
  });

  test('rejects files outside Claude transcript roots and non-JSONL files', () => {
    const homeDir = temporaryDirectory();
    const outside = path.join(temporaryDirectory(), 'session.jsonl');
    const wrongExtension = path.join(homeDir, '.claude', 'projects', 'session.txt');
    mkdirSync(path.dirname(wrongExtension), { recursive: true });
    writeFileSync(outside, '{}\n', 'utf8');
    writeFileSync(wrongExtension, '{}\n', 'utf8');

    assert.equal(validateTranscriptPath(outside, { homeDir, env: {} }), null);
    assert.equal(validateTranscriptPath(wrongExtension, { homeDir, env: {} }), null);
  });
});

describe('lock-coordinated JSONL queue', () => {
  test('appends and removes records without corrupting retained lines', async () => {
    const queuePath = path.join(temporaryDirectory(), 'pending.jsonl');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendJsonlRecord(queuePath, { session_id: `session-${index}`, index }),
      ),
    );

    const before = await readJsonlRecords(queuePath);
    assert.equal(before.length, 20);

    const removed = await removeJsonlRecords(
      queuePath,
      (record) => record.index % 2 === 0,
    );
    assert.equal(removed, 10);

    const after = await readJsonlRecords(queuePath);
    assert.equal(after.length, 10);
    assert.ok(after.every((record) => record.index % 2 === 1));
    assert.equal(readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).length, 10);
  });
});
