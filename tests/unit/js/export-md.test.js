/**
 * tests/unit/js/export-md.test.js
 *
 * Unit tests for ops/export/export-md.js — Markdown truth-derivation layer.
 *
 * Pure-function tests only (no filesystem); the side-effect-driven main() is
 * exercised separately by an integration smoke test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRecordMarkdown } from "../../../ops/export/export-md.js";

test("renderRecordMarkdown: includes all 8 required frontmatter fields", () => {
  const md = renderRecordMarkdown({
    schemaVersion: 2,
    id: "rec-001",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: "Hello",
    tool: "claude",
    source: "claude-code",
  });
  for (const f of [
    "schemaVersion: 2",
    'id: "rec-001"',
    'type: "note"',
    'scope: "user"',
    'memory_level: "durable"',
    'title: "Hello"',
    'tool: "claude"',
    'source: "claude-code"',
  ]) {
    assert.ok(md.includes(f), `expected frontmatter to contain ${f}`);
  }
});

test("renderRecordMarkdown: optional t and tags appear when provided", () => {
  const md = renderRecordMarkdown({
    schemaVersion: 2,
    id: "rec-002",
    type: "fact",
    scope: "project",
    memory_level: "session",
    title: "Project Fact",
    tool: "codex",
    source: "codex-cli",
    t: "2026-06-25T10:00:00.000Z",
    tags: ["architecture", "auth"],
  });
  assert.ok(md.includes('t: "2026-06-25T10:00:00.000Z"'));
  assert.ok(md.includes('tags: ["architecture", "auth"]'));
  // Obsidian tag syntax appears in body
  assert.ok(md.includes("#architecture"));
  assert.ok(md.includes("#auth"));
});

test("renderRecordMarkdown: missing optional t and tags are omitted", () => {
  const md = renderRecordMarkdown({
    schemaVersion: 2,
    id: "rec-003",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: "T",
    tool: "claude",
    source: "src",
  });
  assert.ok(!md.includes("\nt: "), "t should be omitted when missing");
  assert.ok(!md.includes("tags: ["), "tags should be omitted when missing");
});

test("renderRecordMarkdown: default values fill missing required fields", () => {
  const md = renderRecordMarkdown({ id: "rec-004" });
  assert.ok(md.includes('type: "unknown"'));
  assert.ok(md.includes('scope: "unknown"'));
  assert.ok(md.includes('memory_level: "durable"'));
  assert.ok(md.includes('title: "(untitled)"'));
});

test("renderRecordMarkdown: YAML-special chars in title are escaped", () => {
  const md = renderRecordMarkdown({
    id: "rec-005",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: 'He said "hi": ok',
    tool: "claude",
    source: "src",
  });
  // Double-quoted YAML: inner " must be backslash-escaped
  assert.ok(md.includes('title: "He said \\"hi\\": ok"'));
});

test("renderRecordMarkdown: content body is included", () => {
  const md = renderRecordMarkdown({
    id: "rec-006",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: "T",
    tool: "claude",
    source: "src",
    content: "Body text here\nwith newlines\n",
  });
  assert.ok(md.includes("## Content"));
  assert.ok(md.includes("Body text here"));
  assert.ok(md.includes("with newlines"));
});

test("renderRecordMarkdown: empty content shows placeholder", () => {
  const md = renderRecordMarkdown({
    id: "rec-007",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: "T",
    tool: "claude",
    source: "src",
  });
  assert.ok(md.includes("_(no content)_"));
});

test("renderRecordMarkdown: deterministic output for same input", () => {
  const record = {
    id: "rec-008",
    type: "note",
    scope: "user",
    memory_level: "durable",
    title: "T",
    tool: "claude",
    source: "src",
  };
  // generated_at is in the index page only, not in record markdown;
  // record markdown must be byte-identical across calls.
  const a = renderRecordMarkdown(record);
  const b = renderRecordMarkdown(record);
  assert.equal(a, b);
});