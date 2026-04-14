// ops/extract-transcript.test.mjs
// TDD RED phase — tests first, implementation later

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildExtractionTranscript,
  loadTranscript,
} from './extract-transcript.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('buildExtractionTranscript', () => {

  it('returns empty string for empty lines array', () => {
    const result = buildExtractionTranscript([]);
    assert.equal(result, '');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(buildExtractionTranscript(null), '');
    assert.equal(buildExtractionTranscript(undefined), '');
  });

  it('includes head section marker', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = buildExtractionTranscript(lines);
    assert.ok(result.includes('=== 会话开头'), 'should include head section marker');
  });

  it('includes tool results section marker', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = buildExtractionTranscript(lines);
    assert.ok(result.includes('=== 工具交互'), 'should include tool results section marker');
  });

  it('includes tail section marker', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = buildExtractionTranscript(lines);
    assert.ok(result.includes('=== 会话结尾'), 'should include tail section marker');
  });

  it('truncates long lines with marker', () => {
    const longLine = 'x'.repeat(2500);
    const lines = [longLine];
    const result = buildExtractionTranscript(lines);
    assert.ok(result.includes('已截断'), 'should include truncation marker for long lines');
  });

  it('includes middle section content', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result = buildExtractionTranscript(lines);
    // Middle section should contain some of the middle lines
    assert.ok(result.includes('line 30'), 'middle lines should appear');
  });

  it('respects maxHeadTokens option', () => {
    // 100 lines of ~10 chars each ≈ 250 tokens
    // With maxHeadTokens=50, output should be shorter
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result50 = buildExtractionTranscript(lines, { maxHeadTokens: 50 });
    const result200 = buildExtractionTranscript(lines, { maxHeadTokens: 200 });
    assert.ok(result50.length <= result200.length, 'smaller token budget should produce shorter output');
  });

  it('respects maxTailTokens option', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result50 = buildExtractionTranscript(lines, { maxTailTokens: 50 });
    const result200 = buildExtractionTranscript(lines, { maxTailTokens: 200 });
    assert.ok(result50.length <= result200.length, 'smaller token budget should produce shorter output');
  });
});

describe('loadTranscript', () => {
  const tmpDir = os.tmpdir();

  it('throws transcript-not-found for missing file', () => {
    assert.throws(
      () => loadTranscript('/nonexistent/path/to/transcript.txt'),
      (err) => {
        return err.message.includes('transcript-not-found');
      }
    );
  });

  it('throws transcript-empty for empty file', () => {
    const emptyFile = path.join(tmpDir, `empty-${Date.now()}.txt`);
    fs.writeFileSync(emptyFile, '', 'utf-8');
    try {
      assert.throws(
        () => loadTranscript(emptyFile),
        (err) => {
          return err.message.includes('transcript-empty');
        }
      );
    } finally {
      fs.unlinkSync(emptyFile);
    }
  });

  it('parses JSONL format correctly', () => {
    const jsonlFile = path.join(tmpDir, `jsonl-${Date.now()}.txt`);
    const content = [
      '{"text":"hello world"}',
      '{"content":"second line"}',
      '{"text":"third"}',
    ].join('\n');
    fs.writeFileSync(jsonlFile, content, 'utf-8');
    try {
      const { lines } = loadTranscript(jsonlFile);
      assert.equal(lines.length, 3);
      assert.equal(lines[0], 'hello world');
      assert.equal(lines[1], 'second line');
      assert.equal(lines[2], 'third');
    } finally {
      fs.unlinkSync(jsonlFile);
    }
  });

  it('treats plain text as lines', () => {
    const txtFile = path.join(tmpDir, `plain-${Date.now()}.txt`);
    const content = 'line one\nline two\nline three';
    fs.writeFileSync(txtFile, content, 'utf-8');
    try {
      const { lines } = loadTranscript(txtFile);
      assert.equal(lines.length, 3);
      assert.equal(lines[0], 'line one');
      assert.equal(lines[1], 'line two');
      assert.equal(lines[2], 'line three');
    } finally {
      fs.unlinkSync(txtFile);
    }
  });

  it('returns raw content alongside lines', () => {
    const txtFile = path.join(tmpDir, `raw-${Date.now()}.txt`);
    const content = 'raw content here';
    fs.writeFileSync(txtFile, content, 'utf-8');
    try {
      const { lines, raw } = loadTranscript(txtFile);
      assert.ok(raw.length > 0);
      assert.ok(lines.length > 0);
    } finally {
      fs.unlinkSync(txtFile);
    }
  });

  it('skips empty JSONL lines', () => {
    const jsonlFile = path.join(tmpDir, `skipped-${Date.now()}.txt`);
    const content = [
      '{"text":"valid line"}',
      '',
      '{"text":"another"}',
    ].join('\n');
    fs.writeFileSync(jsonlFile, content, 'utf-8');
    try {
      const { lines } = loadTranscript(jsonlFile);
      assert.equal(lines.length, 2);
      assert.equal(lines[0], 'valid line');
      assert.equal(lines[1], 'another');
    } finally {
      fs.unlinkSync(jsonlFile);
    }
  });
});
