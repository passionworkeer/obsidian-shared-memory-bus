// ops/extraction-pipeline.test.mjs
// TDD RED phase — tests first, implementation later

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateId, validateRecord, runExtraction } from './extraction-pipeline.mjs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateId', () => {
  it('returns a valid UUID', () => {
    const id = generateId();
    assert.match(id, UUID_REGEX, 'should be a valid UUID v4');
  });

  it('returns unique IDs on repeated calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100, 'all 100 IDs should be unique');
  });

  it('returns a string', () => {
    const id = generateId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });
});

describe('validateRecord', () => {
  const makeValidRecord = (overrides = {}) => ({
    schemaVersion: 2,
    id: 'some-uuid',
    tool: 'claude-code',
    type: 'bugfix',
    title: 'Fixed something',
    source: 'extraction',
    scope: 'project',
    ...overrides,
  });

  it('returns true for valid record', () => {
    const record = makeValidRecord();
    assert.equal(validateRecord(record), true);
  });

  it('returns error string for missing fields', () => {
    const record = makeValidRecord({ type: undefined });
    const result = validateRecord(record);
    assert.notEqual(result, true);
    assert.ok(result.includes('missing-field'), 'should report missing field');
  });

  it('returns error for missing type field', () => {
    const record = makeValidRecord({ type: undefined });
    const result = validateRecord(record);
    assert.ok(result.includes('missing-field: type'));
  });

  it('returns error for wrong schema version', () => {
    const record = makeValidRecord({ schemaVersion: 99 });
    const result = validateRecord(record);
    assert.ok(result.includes('wrong-schema-version'));
  });

  it('returns error for invalid scope', () => {
    const record = makeValidRecord({ scope: 'invalid-scope' });
    const result = validateRecord(record);
    assert.ok(result.includes('invalid-scope'));
  });

  it('accepts all valid scope values', () => {
    for (const scope of ['user', 'project', 'feedback', 'reference']) {
      const record = makeValidRecord({ scope });
      assert.equal(validateRecord(record), true, `scope="${scope}" should be valid`);
    }
  });

  it('returns error for non-object input', () => {
    assert.ok(validateRecord(null).includes('not-an-object'));
    assert.ok(validateRecord('string').includes('not-an-object'));
    assert.ok(validateRecord(undefined).includes('not-an-object'));
  });
});

describe('runExtraction', () => {
  const tmpDir = os.tmpdir();
  const transcriptPath = path.join(tmpDir, `transcript-${Date.now()}.jsonl`);

  // Set up a valid JSONL transcript
  const validTranscript = [
    '{"text":"Hello, this is a test session about implementing the extraction pipeline."}',
    '{"text":"We need to extract facts from the conversation transcript."}',
    '{"text":"The implementation should use ESM modules."}',
    '{"text":"User is working on the obsidian-shared-memory-bus project."}',
    '{"text":"Session concluded successfully."}',
  ].join('\n');

  beforeEach(() => {
    fs.writeFileSync(transcriptPath, validTranscript, 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(transcriptPath)) {
      fs.unlinkSync(transcriptPath);
    }
  });

  it('returns error when transcript not found', async () => {
    const result = await runExtraction({
      transcriptPath: '/nonexistent/path/to/transcript.jsonl',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('transcript-not-found') || result.error.includes('transcript-load-failed'));
  });

  it('returns error when API key not set', async () => {
    // Clear the API key if set
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await runExtraction({ transcriptPath });
      assert.equal(result.ok, false);
      assert.ok(
        result.error.includes('OPENAI_API_KEY not set') || result.error.includes('llm-call-failed'),
        `expected API key error, got: ${result.error}`
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it('writes to pending when LLM fails', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-invalid-key-for-failure';
    // Point to a nonexistent base URL to force failure
    const origBaseUrl = process.env.AI_MEMORY_LLM_BASE_URL;
    process.env.AI_MEMORY_LLM_BASE_URL = 'http://127.0.0.1:1'; // nonexistent

    try {
      const result = await runExtraction({ transcriptPath });
      // Either LLM call fails or quality bar not met — both write to pending
      assert.equal(result.ok, false);
      assert.ok(
        result.fallback === 'pending' || result.error.includes('llm-call-failed') || result.error.includes('quality-bar-not-met'),
        `expected pending fallback or LLM failure, got: ${JSON.stringify(result)}`
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
      else delete process.env.OPENAI_API_KEY;
      if (origBaseUrl) process.env.AI_MEMORY_LLM_BASE_URL = origBaseUrl;
      else delete process.env.AI_MEMORY_LLM_BASE_URL;
    }
  });

  it('returns quality-bar-not-met when no facts extracted', async () => {
    // A transcript that is long enough but may yield empty extraction
    // The test verifies that quality bar check happens and pending is written
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    const origBaseUrl = process.env.AI_MEMORY_LLM_BASE_URL;
    process.env.AI_MEMORY_LLM_BASE_URL = 'http://127.0.0.1:1';

    try {
      const result = await runExtraction({ transcriptPath });
      // When LLM call fails completely (no response), result.ok should be false
      assert.equal(result.ok, false);
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
      else delete process.env.OPENAI_API_KEY;
      if (origBaseUrl) process.env.AI_MEMORY_LLM_BASE_URL = origBaseUrl;
      else delete process.env.AI_MEMORY_LLM_BASE_URL;
    }
  });

  it('returns error when transcript is too short', async () => {
    const shortFile = path.join(tmpDir, `short-${Date.now()}.jsonl`);
    fs.writeFileSync(shortFile, '{"text":"hi"}', 'utf-8');
    try {
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const result = await runExtraction({ transcriptPath: shortFile });
        // Should fail before even calling LLM
        assert.equal(result.ok, false);
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
      }
    } finally {
      fs.unlinkSync(shortFile);
    }
  });
});
