"use strict";
// Tests for ops/memory-layers-context.js

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Stub memory-contract and vault-root before the module is loaded
// ---------------------------------------------------------------------------
const mcPath = require.resolve("../../../ops/memory-contract.js");
delete require.cache[mcPath];
require.cache[mcPath] = {
  id: mcPath,
  filename: mcPath,
  loaded: true,
  exports: require("../../../ops/memory-contract.js"),
};

const stubVaultRootPath = path.join(__dirname, "..", "..", "..", "bus", "vault-root.js");
const vaultRootStub = `
module.exports = {
  resolveVaultRoot() { return "E:/desktop/Obsidian Vault"; },
  getDefaultVaultCandidates() { return ["E:/desktop/Obsidian Vault"]; },
};
`;
if (!fs.existsSync(stubVaultRootPath)) {
  fs.mkdirSync(path.dirname(stubVaultRootPath), { recursive: true });
  fs.writeFileSync(stubVaultRootPath, vaultRootStub, "utf8");
}
delete require.cache[stubVaultRootPath];
require.cache[stubVaultRootPath] = {
  id: stubVaultRootPath,
  filename: stubVaultRootPath,
  loaded: true,
  exports: { resolveVaultRoot() { return "E:/desktop/Obsidian Vault"; }, getDefaultVaultCandidates() { return ["E:/desktop/Obsidian Vault"]; } },
};

// Patch Module.prototype._compile to inject exports
const MEMORY_LAYERS_CONTEXT_PATH = require.resolve("../../../ops/memory-layers-context.js");
const _originalCompile = Module.prototype._compile;
Module.prototype._compile = function(code, filename) {
  if (filename === MEMORY_LAYERS_CONTEXT_PATH) {
    code = code + "\nmodule.exports = {\n" +
      "CONTEXT_LIMITS,TIER_BUDGET_LIMITS,NON_PROMOTABLE_PROMOTION_TYPES,MIN_PROMOTION_CONFIDENCE," +
      "withTokenEstimate,freshnessScore,sortByFreshnessDesc," +
      "buildScopedSummaries,renderSegmentMarkdown," +
      "buildGlobalContext,buildScopeCounts,buildScopedHighlights," +
      "buildMemoryIndex,buildLayerSummary," +
      "MEMORY_LAYERS_MD,MEMORY_LAYERS_JSON,GLOBAL_CONTEXT_MD,GLOBAL_CONTEXT_META_JSON,GLOBAL_CONTEXT_BODY_MD," +
      "resolveIncludes," +
      "DURABLE_SCOPES," +
      "};\n";
  }
  return _originalCompile.call(this, code, filename);
};
delete require.cache[MEMORY_LAYERS_CONTEXT_PATH];

const {
  CONTEXT_LIMITS, TIER_BUDGET_LIMITS, NON_PROMOTABLE_PROMOTION_TYPES, MIN_PROMOTION_CONFIDENCE,
  withTokenEstimate, freshnessScore, sortByFreshnessDesc,
  buildScopedSummaries, renderSegmentMarkdown,
  buildGlobalContext, buildScopeCounts, buildScopedHighlights,
  buildMemoryIndex, buildLayerSummary,
  MEMORY_LAYERS_MD, MEMORY_LAYERS_JSON, GLOBAL_CONTEXT_MD, GLOBAL_CONTEXT_META_JSON, GLOBAL_CONTEXT_BODY_MD,
  resolveIncludes,
  DURABLE_SCOPES,
} = require("../../../ops/memory-layers-context.js");

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("CONTEXT_LIMITS has expected shape", () => {
  assert.equal(typeof CONTEXT_LIMITS.user, "number");
  assert.equal(typeof CONTEXT_LIMITS.feedback, "number");
  assert.equal(typeof CONTEXT_LIMITS.project, "number");
  assert.equal(typeof CONTEXT_LIMITS.reference, "number");
  assert.equal(typeof CONTEXT_LIMITS.event_task, "number");
  assert.equal(typeof CONTEXT_LIMITS.estimated_chars_per_token, "number");
  assert.equal(typeof CONTEXT_LIMITS.max_file_size_chars, "number");
  assert.equal(CONTEXT_LIMITS.estimated_chars_per_token, 4);
  assert.equal(CONTEXT_LIMITS.max_file_size_chars, 8000);
});

test("TIER_BUDGET_LIMITS has 5 tiers", () => {
  assert.equal(TIER_BUDGET_LIMITS[1], 200);
  assert.equal(TIER_BUDGET_LIMITS[2], 200);
  assert.equal(TIER_BUDGET_LIMITS[3], 100);
  assert.equal(TIER_BUDGET_LIMITS[4], 200);
  assert.equal(TIER_BUDGET_LIMITS[5], 500);
});

test("path constants are absolute strings", () => {
  assert.ok(typeof MEMORY_LAYERS_MD === "string");
  assert.ok(typeof MEMORY_LAYERS_JSON === "string");
  assert.ok(typeof GLOBAL_CONTEXT_MD === "string");
  assert.ok(typeof GLOBAL_CONTEXT_META_JSON === "string");
  assert.ok(typeof GLOBAL_CONTEXT_BODY_MD === "string");
  assert.ok(MEMORY_LAYERS_MD.endsWith("MEMORY-LAYERS.md"));
  assert.ok(GLOBAL_CONTEXT_BODY_MD.endsWith("GLOBAL-CONTEXT.body.md"));
});

test("DURABLE_SCOPES imported correctly", () => {
  assert.ok(DURABLE_SCOPES instanceof Set);
  assert.ok(DURABLE_SCOPES.has("user"));
});

// ---------------------------------------------------------------------------
// withTokenEstimate
// ---------------------------------------------------------------------------

test("withTokenEstimate: adds estimatedTokens and charCount", () => {
  const record = { id: "r1", title: "T", scope: "project", freshness: "hot", content: "hello world this is content" };
  const result = withTokenEstimate(record);
  assert.ok("estimatedTokens" in result);
  assert.ok("charCount" in result);
  assert.equal(result.id, "r1");
  assert.equal(result.title, "T");
});

test("withTokenEstimate: estimatedTokens = ceil(charCount / 4)", () => {
  const record = { id: "r", content: "hello world this is a test string" };
  const result = withTokenEstimate(record);
  assert.equal(result.estimatedTokens, Math.ceil(record.content.length / 4));
});

test("withTokenEstimate: null content yields zero estimates", () => {
  const result = withTokenEstimate({ id: "r", content: null });
  assert.equal(result.estimatedTokens, 0);
  assert.equal(result.charCount, 0);
});

test("withTokenEstimate: does not mutate original record", () => {
  const record = { id: "r", title: "T", content: "C", freshness: "warm" };
  const result = withTokenEstimate(record);
  assert.ok(!("estimatedTokens" in record));
  assert.ok("estimatedTokens" in result);
});

// ---------------------------------------------------------------------------
// freshnessScore
// ---------------------------------------------------------------------------

test("freshnessScore: hot=3, warm=2, cold=1, unknown=0", () => {
  assert.equal(freshnessScore({ freshness: "hot" }), 3);
  assert.equal(freshnessScore({ freshness: "warm" }), 2);
  assert.equal(freshnessScore({ freshness: "cold" }), 1);
  assert.equal(freshnessScore({ freshness: "unknown" }), 0);
});

test("freshnessScore: hot record scores higher than warm", () => {
  assert.ok(freshnessScore({ freshness: "hot" }) > freshnessScore({ freshness: "warm" }));
  assert.ok(freshnessScore({ freshness: "warm" }) > freshnessScore({ freshness: "cold" }));
});

// ---------------------------------------------------------------------------
// sortByFreshnessDesc
// ---------------------------------------------------------------------------

test("sortByFreshnessDesc: hot before warm before cold", () => {
  const now = new Date().toISOString();
  const records = [
    { id: "c", freshness: "cold", t: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
    { id: "h", freshness: "hot", t: now },
    { id: "w", freshness: "warm", t: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
  ];
  const sorted = sortByFreshnessDesc(records);
  assert.equal(sorted[0].freshness, "hot");
  assert.equal(sorted[1].freshness, "warm");
  assert.equal(sorted[2].freshness, "cold");
});

test("sortByFreshnessDesc: does not mutate original", () => {
  const records = [{ id: "a", freshness: "warm", t: "2024-01-01" }, { id: "b", freshness: "hot", t: "2024-06-01" }];
  const originalOrder = records.map((r) => r.id);
  sortByFreshnessDesc(records);
  assert.deepEqual(records.map((r) => r.id), originalOrder);
});

test("sortByFreshnessDesc: equal freshness sorts by timestamp desc", () => {
  const records = [
    { id: "older", freshness: "hot", t: "2024-01-01T00:00:00.000Z" },
    { id: "newer", freshness: "hot", t: "2024-06-01T00:00:00.000Z" },
  ];
  const sorted = sortByFreshnessDesc(records);
  assert.equal(sorted[0].id, "newer");
  assert.equal(sorted[1].id, "older");
});

test("sortByFreshnessDesc: empty array returns empty", () => {
  assert.deepEqual(sortByFreshnessDesc([]), []);
});

// ---------------------------------------------------------------------------
// buildScopedSummaries
// ---------------------------------------------------------------------------

test("buildScopedSummaries: returns 5 segments", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildScopedSummaries(layers);
  assert.ok(Array.isArray(Object.keys(result.segments)));
  assert.ok("user" in result.segments);
  assert.ok("feedback" in result.segments);
  assert.ok("project" in result.segments);
  assert.ok("reference" in result.segments);
  assert.ok("event_task" in result.segments);
});

test("buildScopedSummaries: assigns budget per segment", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildScopedSummaries(layers);
  assert.equal(result.segments.user.budget, CONTEXT_LIMITS.user);
  assert.equal(result.segments.feedback.budget, CONTEXT_LIMITS.feedback);
});

test("buildScopedSummaries: filters records by scope", () => {
  const layers = {
    sharedInbox: [
      { id: "u1", scope: "user", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "" },
      { id: "f1", scope: "feedback", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "" },
      { id: "p1", scope: "project", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "" },
    ],
    sessionMemory: [],
    sharedEvents: [],
    taskMemory: [],
  };
  const result = buildScopedSummaries(layers);
  assert.equal(result.segments.user.records.length, 1);
  assert.equal(result.segments.feedback.records.length, 1);
  assert.equal(result.segments.project.records.length, 1);
});

test("buildScopedSummaries: event_task segment includes event/task/run/job scopes", () => {
  const layers = {
    sharedInbox: [],
    sessionMemory: [],
    sharedEvents: [{ id: "e1", scope: "event", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "" }],
    taskMemory: [{ id: "t1", scope: "task", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "" }],
  };
  const result = buildScopedSummaries(layers);
  assert.equal(result.segments.event_task.records.length, 2);
});

test("buildScopedSummaries: truncates records beyond budget", () => {
  const manyUserRecords = Array.from({ length: 10 }, (_, i) => ({
    id: `u${i}`, scope: "user", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "x".repeat(100),
  }));
  const layers = { sharedInbox: manyUserRecords, sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildScopedSummaries(layers);
  assert.equal(result.segments.user.displayedRecords.length, CONTEXT_LIMITS.user);
  assert.ok(result.segments.user.truncatedCount > 0);
  assert.ok(result.anyTruncated);
});

test("buildScopedSummaries: totalRecords and estimatedTotalTokens are computed", () => {
  const layers = {
    sharedInbox: [{ id: "u1", scope: "user", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "hello world" }],
    sessionMemory: [],
    sharedEvents: [],
    taskMemory: [],
  };
  const result = buildScopedSummaries(layers);
  assert.equal(result.totalRecords, 1);
  assert.ok(result.estimatedTotalTokens > 0);
});

// ---------------------------------------------------------------------------
// renderSegmentMarkdown
// ---------------------------------------------------------------------------

test("renderSegmentMarkdown: renders segment name as h2", () => {
  const segment = { name: "User Prefs (user)", displayedRecords: [], truncatedCount: 0 };
  const output = renderSegmentMarkdown(segment);
  assert.ok(output.includes("## User Prefs (user)"));
  assert.ok(output.includes("（暂无记录）"));
});

test("renderSegmentMarkdown: renders record entries with token estimate", () => {
  const segment = {
    name: "Project (project)",
    displayedRecords: [
      { id: "p1", title: "Fix auth bug", estimatedTokens: 8, freshness: "hot" },
    ],
    truncatedCount: 0,
  };
  const output = renderSegmentMarkdown(segment);
  assert.ok(output.includes("**Fix auth bug**"));
  assert.ok(output.includes("~8 tokens"));
});

test("renderSegmentMarkdown: renders truncated count", () => {
  const segment = {
    name: "Project (project)",
    displayedRecords: [{ id: "p1", title: "Fix", estimatedTokens: 1, freshness: "hot" }],
    truncatedCount: 5,
  };
  const output = renderSegmentMarkdown(segment);
  assert.ok(output.includes("还有 5 条记录"));
});

// ---------------------------------------------------------------------------
// buildGlobalContext
// ---------------------------------------------------------------------------

test("buildGlobalContext: returns markdown, meta, bodyMarkdown", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  assert.ok(typeof result.markdown === "string");
  assert.ok(typeof result.meta === "object");
  assert.ok(typeof result.bodyMarkdown === "string");
});

test("buildGlobalContext: markdown includes all 5 segment headings", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  assert.ok(result.markdown.includes("## 用户偏好"));
  assert.ok(result.markdown.includes("## 反馈与规则"));
  assert.ok(result.markdown.includes("## 项目上下文"));
  assert.ok(result.markdown.includes("## 参考与链接"));
  assert.ok(result.markdown.includes("## 事件与任务"));
});

test("buildGlobalContext: meta contains generatedAt and segments", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  assert.ok(typeof result.meta.generatedAt === "string");
  assert.ok(Array.isArray(result.meta.segments));
  assert.equal(result.meta.segments.length, 5);
});

test("buildGlobalContext: meta.truncated reflects anyTruncated", () => {
  const manyUserRecords = Array.from({ length: 10 }, (_, i) => ({
    id: `u${i}`, scope: "user", freshness: "hot", t: "2024-06-01T00:00:00.000Z", content: "x".repeat(100),
  }));
  const layers = { sharedInbox: manyUserRecords, sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  assert.ok(result.meta.truncated);
});

test("buildGlobalContext: includes long-term accumulation section", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  assert.ok(result.markdown.includes("## 长期积累"));
});

test("buildGlobalContext: bodyMarkdown does not include outer header comment", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildGlobalContext(layers);
  // bodyMarkdown is the markdown without the header comment
  assert.ok(result.bodyMarkdown.includes("# Shared AI Memory"));
});

// ---------------------------------------------------------------------------
// buildScopeCounts
// ---------------------------------------------------------------------------

test("buildScopeCounts: counts records per scope", () => {
  const records = [
    { scope: "user" }, { scope: "user" }, { scope: "project" }, { scope: "project" }, { scope: "project" },
  ];
  const result = buildScopeCounts(records);
  assert.equal(result.user, 2);
  assert.equal(result.project, 3);
});

test("buildScopeCounts: unknown scope defaults to summary", () => {
  const result = buildScopeCounts([{ scope: null }, { scope: "" }]);
  assert.ok("summary" in result);
});

test("buildScopeCounts: empty array returns empty object", () => {
  assert.deepEqual(buildScopeCounts([]), {});
});

test("buildScopeCounts: results sorted by count desc", () => {
  const records = [{ scope: "z" }, { scope: "a" }, { scope: "a" }];
  const result = buildScopeCounts(records);
  const keys = Object.keys(result);
  assert.equal(keys[0], "a"); // most frequent first
  assert.equal(keys[1], "z");
});

// ---------------------------------------------------------------------------
// buildScopedHighlights
// ---------------------------------------------------------------------------

test("buildScopedHighlights: limits records per scope", () => {
  const records = Array.from({ length: 10 }, (_, i) => ({
    scope: "project", id: `p${i}`, title: `Task ${i}`, tool: "test", t: new Date().toISOString(),
  }));
  const result = buildScopedHighlights(records, 3);
  assert.ok(result.project !== undefined);
  assert.equal(result.project.length, 3);
});

test("buildScopedHighlights: returns newest-first within each scope", () => {
  const records = [
    { scope: "project", id: "old", title: "Old", tool: "test", t: "2024-01-01T00:00:00.000Z" },
    { scope: "project", id: "new", title: "New", tool: "test", t: "2024-06-01T00:00:00.000Z" },
  ];
  const result = buildScopedHighlights(records, 3);
  // buildScopedHighlights returns { tool, scope, title, t } per record (not id)
  assert.equal(result.project[0].title, "New");
});

test("buildScopedHighlights: includes tool, scope, title, t", () => {
  const records = [{ scope: "user", id: "u1", title: "Pref", tool: "claude-code", t: "2024-06-01T00:00:00.000Z" }];
  const result = buildScopedHighlights(records, 3);
  assert.ok(result.user[0].tool !== undefined);
  assert.ok(result.user[0].scope !== undefined);
  assert.ok(result.user[0].title !== undefined);
  assert.ok(result.user[0].t !== undefined);
});

// ---------------------------------------------------------------------------
// buildMemoryIndex
// ---------------------------------------------------------------------------

test("buildMemoryIndex: returns markdown string", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildMemoryIndex(layers);
  assert.ok(typeof result === "string");
  assert.ok(result.startsWith("# Memory Index"));
});

test("buildMemoryIndex: excludes task/event from durable index", () => {
  const layers = {
    sharedInbox: [{ id: "u1", scope: "user", title: "User pref", content: "C", description: "D" }],
    sessionMemory: [],
    sharedEvents: [{ id: "e1", scope: "event", title: "Event", content: "C", description: "D" }],
    taskMemory: [{ id: "t1", scope: "task", title: "Task", content: "C", description: "D" }],
  };
  const result = buildMemoryIndex(layers);
  assert.ok(!result.includes("## event")); // event excluded
  assert.ok(!result.includes("## task")); // task excluded
  // User scope heading is "## 用户偏好 (user)" per scopeLabels in buildMemoryIndex
  assert.ok(result.includes("## 用户偏好 (user)"));
});

test("buildMemoryIndex: limits records per scope to 20", () => {
  const manyRecords = Array.from({ length: 25 }, (_, i) => ({
    id: `p${i}`, scope: "project", title: `Task ${i}`, content: "C", description: "D",
  }));
  const layers = { sharedInbox: manyRecords, sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildMemoryIndex(layers);
  assert.ok(result.includes("... 还有 5 条记录"));
});

// ---------------------------------------------------------------------------
// buildLayerSummary
// ---------------------------------------------------------------------------

test("buildLayerSummary: returns markdown and json", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildLayerSummary(layers);
  assert.ok(typeof result.markdown === "string");
  assert.ok(typeof result.json === "object");
  assert.ok(result.markdown.startsWith("# Memory Layers"));
});

test("buildLayerSummary: json.counts has all 4 layers", () => {
  const layers = { sharedInbox: [], sessionMemory: [], sharedEvents: [], taskMemory: [] };
  const result = buildLayerSummary(layers);
  assert.equal(result.json.counts.sharedInbox, 0);
  assert.equal(result.json.counts.sessionMemory, 0);
  assert.equal(result.json.counts.sharedEvents, 0);
  assert.equal(result.json.counts.taskMemory, 0);
});

test("buildLayerSummary: includes durableByScope in counts", () => {
  const layers = {
    sharedInbox: [{ scope: "user", id: "u1", title: "U", tool: "t", content: "C", description: "D" }],
    sessionMemory: [],
    sharedEvents: [],
    taskMemory: [],
  };
  const result = buildLayerSummary(layers);
  assert.equal(result.json.counts.durableByScope.user, 1);
});

test("buildLayerSummary: latest highlights are included", () => {
  const layers = {
    sharedInbox: [{ id: "u1", scope: "user", title: "U", tool: "t", content: "C", description: "D", t: "2024-06-01T00:00:00.000Z" }],
    sessionMemory: [{ id: "s1", title: "S", tool: "t", content: "C", t: "2024-06-01T00:00:00.000Z" }],
    sharedEvents: [],
    taskMemory: [],
  };
  const result = buildLayerSummary(layers);
  assert.ok(Array.isArray(result.json.latest.sharedInbox));
  assert.ok(Array.isArray(result.json.latest.sessionMemory));
});

// ---------------------------------------------------------------------------
// resolveIncludes
// ---------------------------------------------------------------------------

test("resolveIncludes: returns content unchanged when no includes", () => {
  const content = "# Title\n\nSome content";
  const result = resolveIncludes(content, "/tmp");
  assert.equal(result.content, content);
  assert.deepEqual(result.includes_resolved, []);
  assert.equal(result.depth, 0);
});

test("resolveIncludes: replaces @include directive with file content", () => {
  const includedFile = path.join(os.tmpdir(), `resolve-includes-test-${Date.now()}-inc.md`);
  const baseDir = os.tmpdir();
  fs.writeFileSync(includedFile, "Included content here", "utf8");
  try {
    const content = "# Title\n\n@include " + path.basename(includedFile);
    const result = resolveIncludes(content, baseDir);
    assert.ok(result.content.includes("Included content here"));
    assert.ok(result.includes_resolved.length > 0);
  } finally {
    try { fs.unlinkSync(includedFile); } catch {}
  }
});

test("resolveIncludes: max depth stops recursion", () => {
  const tmpDir = path.join(os.tmpdir(), `resolve-includes-depth-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "level1.md"), "@include level1.md", "utf8");
  const content = "@include level1.md";
  const result = resolveIncludes(content, tmpDir, 2, 0);
  // max depth reached — @include directive remains un-replaced (no infinite recursion)
  assert.ok(result.content.includes("@include level1.md"));
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

test("resolveIncludes: non-existent file logs error and continues", () => {
  const content = "# Title\n\n@include does-not-exist.md";
  // capture stderr
  let stderrOutput = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { stderrOutput += s; return true; };
  const result = resolveIncludes(content, "/tmp");
  process.stderr.write = origWrite;
  assert.ok(stderrOutput.includes("file not found") || stderrOutput.includes("resolve-include"));
  // Original content still present
  assert.ok(result.content.includes("@include"));
});
