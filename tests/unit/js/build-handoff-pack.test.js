"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Patch Module.prototype._compile BEFORE any require calls.
// This lets us inject module.exports into build-handoff-pack.js so its
// top-level functions become accessible without modifying production code.
// ---------------------------------------------------------------------------

const Module = require("module");
const path = require("path");

const HANDOFF_MODULE_PATH = require.resolve("../../../ops/build/build-handoff-pack.js");

// Map of filename -> exports-injection string
const _compilePatches = new Map();
_compilePatches.set(HANDOFF_MODULE_PATH, `
module.exports = {
  normalizeSpaces,
  toTimestamp,
  trimText,
  isInteresting,
  formatRecordLine,
  selectUnique,
  matchesAny,
  buildPack,
  renderMarkdown,
};
`);

const _originalCompile = Module.prototype._compile;
Module.prototype._compile = function _patchedCompile(code, filename) {
  const patch = _compilePatches.get(filename);
  if (patch) {
    _compilePatches.delete(filename);
    code = code + "\n" + patch;
  }
  return _originalCompile.call(this, code, filename);
};

// ---------------------------------------------------------------------------
// Remove any stale cached module (from a prior test run or parallel suite)
// so our _compile patch fires on THIS run.
// ---------------------------------------------------------------------------

delete require.cache[HANDOFF_MODULE_PATH];

// ---------------------------------------------------------------------------
// Stub memory-contract
// ---------------------------------------------------------------------------

const mcPath = require.resolve("../../../ops/memory/memory-contract.js");
delete require.cache[mcPath];
require.cache[mcPath] = {
  id: mcPath,
  filename: mcPath,
  loaded: true,
  exports: require("../../../ops/memory/memory-contract.js"),
};

// ---------------------------------------------------------------------------
// Stub vault-root at the path build-handoff-pack.js will find
// ---------------------------------------------------------------------------

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
delete require.cache[stubVaultRootPath];
require.cache[stubVaultRootPath] = {
  id: stubVaultRootPath,
  filename: stubVaultRootPath,
  loaded: true,
  exports: {
    resolveVaultRoot() {
      return "E:/desktop/Obsidian Vault";
    },
    getDefaultVaultCandidates() {
      return ["E:/desktop/Obsidian Vault"];
    },
  },
};

// ---------------------------------------------------------------------------
// Load the source under test
// ---------------------------------------------------------------------------

const {
  normalizeSpaces,
  toTimestamp,
  trimText,
  isInteresting,
  formatRecordLine,
  selectUnique,
  matchesAny,
  buildPack,
  renderMarkdown,
} = require("../../../ops/build/build-handoff-pack.js");

// ---------------------------------------------------------------------------
// normalizeSpaces
// ---------------------------------------------------------------------------

test("normalizeSpaces: null becomes empty string", () => {
  assert.equal(normalizeSpaces(null), "");
});

test("normalizeSpaces: undefined becomes empty string", () => {
  assert.equal(normalizeSpaces(undefined), "");
});

test("normalizeSpaces: collapses multiple spaces", () => {
  assert.equal(normalizeSpaces("hello    world"), "hello world");
});

test("normalizeSpaces: trims leading/trailing whitespace", () => {
  assert.equal(normalizeSpaces("  hello  "), "hello");
});

test("normalizeSpaces: newlines become spaces", () => {
  assert.equal(normalizeSpaces("hello\nworld"), "hello world");
});

// ---------------------------------------------------------------------------
// toTimestamp
// ---------------------------------------------------------------------------

test("toTimestamp: converts ISO string to milliseconds", () => {
  const ts = toTimestamp("2024-06-15T10:30:00.000Z");
  assert.equal(typeof ts, "number");
  assert.ok(ts > 0);
});

test("toTimestamp: converts Date object to milliseconds", () => {
  const date = new Date("2024-06-15T10:30:00.000Z");
  const ts = toTimestamp(date);
  assert.equal(ts, date.getTime());
});

test("toTimestamp: null returns 0", () => {
  assert.equal(toTimestamp(null), 0);
});

test("toTimestamp: invalid string returns 0", () => {
  assert.equal(toTimestamp("not-a-date"), 0);
});

// ---------------------------------------------------------------------------
// trimText
// ---------------------------------------------------------------------------

test("trimText: short text returned unchanged", () => {
  assert.equal(trimText("hello world", 220), "hello world");
});

test("trimText: long text truncated with ellipsis", () => {
  const long = "a".repeat(300);
  const result = trimText(long, 220);
  assert.ok(result.length < long.length);
  assert.ok(result.endsWith("..."));
});

test("trimText: default maxLength is 220", () => {
  const long = "b".repeat(300);
  const result = trimText(long);
  assert.ok(result.length <= 220);
});

test("trimText: null returns empty string", () => {
  assert.equal(trimText(null), "");
});

test("trimText: collapses whitespace but does not truncate if under limit", () => {
  const result = trimText("hello     world  more", 30);
  assert.equal(result, "hello world more");
});

// ---------------------------------------------------------------------------
// isInteresting
// ---------------------------------------------------------------------------

test("isInteresting: record with title returns true", () => {
  assert.equal(isInteresting({ title: "Fix the bug" }), true);
});

test("isInteresting: record with content but no title returns true", () => {
  assert.equal(isInteresting({ content: "Some observations" }), true);
});

test("isInteresting: record with both title and content returns true", () => {
  assert.equal(isInteresting({ title: "Fix", content: "More detail" }), true);
});

test("isInteresting: empty title and content returns false", () => {
  assert.equal(isInteresting({ title: "", content: "" }), false);
});

test("isInteresting: null/undefined title and content returns false", () => {
  assert.equal(isInteresting({ title: null, content: undefined }), false);
});

test("isInteresting: whitespace-only title returns false", () => {
  assert.equal(isInteresting({ title: "   ", content: "" }), false);
});

// ---------------------------------------------------------------------------
// formatRecordLine
// ---------------------------------------------------------------------------

test("formatRecordLine: '[tool] title' format", () => {
  const record = { tool: "claude-code", title: "Refactor auth module" };
  assert.equal(formatRecordLine(record), "[claude-code] Refactor auth module");
});

test("formatRecordLine: missing tool defaults to '[unknown]'", () => {
  const record = { title: "No tool here" };
  assert.equal(formatRecordLine(record), "[unknown] No tool here");
});

test("formatRecordLine: falls back to content when title is empty", () => {
  const record = { tool: "claude-code", title: "", content: "Fallback content" };
  assert.equal(formatRecordLine(record), "[claude-code] Fallback content");
});

test("formatRecordLine: falls back to id when title and content are empty", () => {
  const record = { tool: "claude-code", title: "", content: "", id: "record-42" };
  assert.equal(formatRecordLine(record), "[claude-code] record-42");
});

test("formatRecordLine: long title truncated to 180 chars", () => {
  const record = { tool: "claude-code", title: "x".repeat(250) };
  const result = formatRecordLine(record);
  const bracketPart = result.split("] ")[1] || "";
  assert.ok(bracketPart.length <= 180);
  assert.ok(bracketPart.endsWith("..."));
});

// ---------------------------------------------------------------------------
// selectUnique
// ---------------------------------------------------------------------------

test("selectUnique: deduplicates by id/key and keeps first occurrence", () => {
  const records = [
    { tool: "claude-code", title: "Fix bug A", id: "1" },
    { tool: "claude-code", title: "Fix bug A", id: "1" }, // duplicate
    { tool: "claude-code", title: "Fix bug B", id: "2" },
  ];
  const result = selectUnique(records, () => true, 10);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "1");
  assert.equal(result[1].id, "2");
});

test("selectUnique: respects limit", () => {
  const records = [
    { tool: "a", title: "one", id: "1" },
    { tool: "b", title: "two", id: "2" },
    { tool: "c", title: "three", id: "3" },
    { tool: "d", title: "four", id: "4" },
  ];
  const result = selectUnique(records, () => true, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "1");
  assert.equal(result[1].id, "2");
});

test("selectUnique: predicate filters records", () => {
  const records = [
    { tool: "claude-code", title: "Keep", id: "1" },
    { tool: "openclaw", title: "Skip", id: "2" },
  ];
  const result = selectUnique(
    records,
    (r) => r.tool === "claude-code",
    10
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "1");
});

test("selectUnique: case-insensitive deduplication key", () => {
  const records = [
    { tool: "claude-code", title: "Fix bug", id: "1" },
    { tool: "Claude-Code", title: "FIX BUG", id: "2" }, // same key (case-insensitive)
  ];
  const result = selectUnique(records, () => true, 10);
  assert.equal(result.length, 1);
});

// ---------------------------------------------------------------------------
// matchesAny
// ---------------------------------------------------------------------------

test("matchesAny: regex matches title", () => {
  const record = { title: "Fix the authentication bug", content: "" };
  assert.equal(matchesAny(record, [/authentication/, /bug/]), true);
});

test("matchesAny: regex matches content", () => {
  const record = { title: "Refactor", content: "Handle authentication errors" };
  assert.equal(matchesAny(record, [/authentication/]), true);
});

test("matchesAny: no match returns false", () => {
  const record = { title: "Fix the bug", content: "" };
  assert.equal(matchesAny(record, [/authentication/]), false);
});

test("matchesAny: multiple patterns, one matches", () => {
  const record = { title: "Fix the bug", content: "" };
  assert.equal(matchesAny(record, [/foo/, /bug/, /bar/]), true);
});

test("matchesAny: null title and content returns false", () => {
  const record = { title: null, content: undefined };
  assert.equal(matchesAny(record, [/anything/]), false);
});

// ---------------------------------------------------------------------------
// buildPack
// ---------------------------------------------------------------------------

test("buildPack: returns object with correct top-level shape", () => {
  const pack = buildPack([]);
  assert.equal(typeof pack, "object");
  assert.ok(Array.isArray(pack.done));
  assert.ok(Array.isArray(pack.next));
  assert.ok(Array.isArray(pack.blocked));
  assert.ok(Array.isArray(pack.files));
  assert.ok(Array.isArray(pack.open_threads));
  assert.ok(Array.isArray(pack.tool_invariants));
  assert.ok(typeof pack.goal === "string");
});

test("buildPack: goal comes from record with summary/project/reference scope", () => {
  const records = [
    {
      id: "goal-1",
      tool: "claude-code",
      title: "Implement new feature",
      content: "",
      scope: "project",
      type: "note",
      t: "2024-06-15T10:00:00.000Z",
    },
  ];
  const pack = buildPack(records);
  assert.ok(pack.goal.includes("Implement new feature"));
});

test("buildPack: done comes from records with completion signals", () => {
  const records = [
    {
      id: "done-1",
      tool: "claude-code",
      title: "Task completed",
      content: "",
      task_state: "completed",
      scope: "task",
      type: "task-note",
      t: "2024-06-15T10:00:00.000Z",
    },
    {
      id: "done-2",
      tool: "claude-code",
      title: "Bug validated",
      content: "",
      task_state: "validated",
      scope: "task",
      type: "task-note",
      t: "2024-06-15T09:00:00.000Z",
    },
  ];
  const pack = buildPack(records);
  assert.ok(pack.done.length >= 1);
  assert.ok(pack.done.some((line) => line.includes("Task completed") || line.includes("Bug validated")));
});

test("buildPack: records grouped into correct sections", () => {
  const records = [
    {
      id: "blocked-1",
      tool: "claude-code",
      title: "Feature blocked",
      content: "",
      task_state: "blocked",
      scope: "task",
      type: "task-note",
      t: "2024-06-15T10:00:00.000Z",
    },
  ];
  const pack = buildPack(records);
  assert.ok(pack.blocked.length >= 1);
});

test("buildPack: next comes from pending/processing records", () => {
  const records = [
    {
      id: "next-1",
      tool: "claude-code",
      title: "Next up: refactor",
      content: "",
      task_state: "pending",
      scope: "task",
      type: "task-note",
      t: "2024-06-15T10:00:00.000Z",
    },
  ];
  const pack = buildPack(records);
  assert.ok(pack.next.length >= 1);
});

test("buildPack: files_modified and files_read populate files list", () => {
  const records = [
    {
      id: "file-1",
      tool: "claude-code",
      title: "Changed auth.js",
      content: "",
      files_modified: ["src/auth.js", "tests/auth.test.js"],
      files_read: ["src/logger.js"],
      scope: "task",
      type: "task-note",
      t: "2024-06-15T10:00:00.000Z",
    },
  ];
  const pack = buildPack(records);
  assert.ok(pack.files.length > 0);
  assert.ok(pack.files.includes("src/auth.js") || pack.files.includes("tests/auth.test.js") || pack.files.includes("src/logger.js"));
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

test("renderMarkdown: outputs a markdown string", () => {
  const pack = {
    generatedAt: "2024-06-15T10:00:00.000Z",
    goal: "Implement feature",
    done: ["[claude-code] Done task"],
    next: ["[claude-code] Next task"],
    blocked: [],
    files: [],
    open_threads: [],
    tool_invariants: [],
  };
  const md = renderMarkdown(pack);
  assert.equal(typeof md, "string");
  assert.ok(md.startsWith("# Handoff Pack"));
});

test("renderMarkdown: includes goal section when present", () => {
  const pack = {
    generatedAt: "2024-06-15T10:00:00.000Z",
    goal: "My important goal",
    done: [],
    next: [],
    blocked: [],
    files: [],
    open_threads: [],
    tool_invariants: [],
  };
  const md = renderMarkdown(pack);
  assert.ok(md.includes("## Goal"));
  assert.ok(md.includes("My important goal"));
});

test("renderMarkdown: uses '-' when done/next/blocked are empty", () => {
  const pack = {
    generatedAt: "2024-06-15T10:00:00.000Z",
    goal: "",
    done: [],
    next: [],
    blocked: [],
    files: [],
    open_threads: [],
    tool_invariants: [],
  };
  const md = renderMarkdown(pack);
  assert.ok(md.includes("## Done"));
  assert.ok(md.includes("-"));
});
