/**
 * tests/unit/js/user-portrait-pipeline.test.js
 * ---------------------------------------------
 * Pipeline integration tests for the user-portrait skill:
 *   - lib/collect.js  (collectMessages + appendChatImport)
 *   - lib/analyze.js  (analyzeMessages)
 *   - lib/render.js   (renderAll)
 *
 * Run with: node --test tests/unit/js/user-portrait-pipeline.test.js
 *
 * These tests stitch the modules together end-to-end against a fake $HOME
 * (one source = Claude Code, one source = Codex) so we exercise the same
 * code path that run.js uses, without touching the user's real data.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _projectRoot = path.resolve(__dirname, "../../../");

const { createTempDir, cleanupTempDir } = await import(
  pathToFileURL(path.join(_projectRoot, "tests/helpers/setup.js"))
);

const collect = await import(
  pathToFileURL(path.join(_projectRoot, "skills/user-portrait/lib/collect.js"))
);
const analyze = await import(
  pathToFileURL(path.join(_projectRoot, "skills/user-portrait/lib/analyze.js"))
);
const render = await import(
  pathToFileURL(path.join(_projectRoot, "skills/user-portrait/lib/render.js"))
);

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Seed a fake $HOME with one Claude Code history.jsonl and one Codex
 * sessions file. Prompt A is shared between sources (dedup target).
 */
function seedTwoSources(home) {
  const A = "shared prompt across sources";
  const B = "claude-only line";
  const C = "codex-only line";
  writeJsonl(path.join(home, ".claude/history.jsonl"), [
    { display: A, timestamp: 1723766400000, project: "/r/repo", sessionId: "s1" },
    { display: B, timestamp: 1723766500000, project: "/r/repo", sessionId: "s1" },
  ]);
  writeJsonl(path.join(home, ".codex/sessions/2026/01/01/rollout-X.jsonl"), [
    { type: "session_meta", payload: { cwd: "/r/repo", session_id: "sx" } },
    {
      type: "response_item",
      timestamp: 1723766400000,
      payload: {
        type: "message",
        role: "user",
        session_id: "sx",
        content: [{ type: "input_text", text: A }],
      },
    },
    {
      type: "response_item",
      timestamp: 1723766600000,
      payload: {
        type: "message",
        role: "user",
        session_id: "sx",
        content: [{ type: "input_text", text: C }],
      },
    },
  ]);
}

// ---------------- collectMessages ----------------

describe("collect.collectMessages", () => {
  let home;
  let outDir;
  beforeEach(() => {
    home = createTempDir("up-pipe-home-");
    outDir = createTempDir("up-pipe-out-");
  });
  afterEach(() => {
    cleanupTempDir(home);
    cleanupTempDir(outDir);
  });

  test("writes messages.jsonl + scan-report.json and reports per-source counts", async () => {
    seedTwoSources(home);
    const { outFile, report } = await collect.collectMessages({ outDir, home });
    assert.ok(fs.existsSync(outFile));
    const records = readJsonl(outFile);
    // 4 candidates across sources (A in claude + A in codex, B, C) → A dedup → 3 unique
    assert.strictEqual(records.length, 3);
    assert.strictEqual(report.total_kept, 3);
    assert.strictEqual(report.total_dropped_dedup, 1);
    assert.strictEqual(report.per_source["claude-code"].kept, 2);
    assert.strictEqual(report.per_source.codex.kept, 1);
    assert.ok(fs.existsSync(path.join(outDir, "scan-report.json")));
  });

  test("dedup key is (day + normalized text)", async () => {
    seedTwoSources(home);
    // Same text different day should NOT dedup
    fs.appendFileSync(
      path.join(home, ".claude/history.jsonl"),
      JSON.stringify({ display: "shared prompt across sources", timestamp: 1723852800000 }) + "\n"
    );
    const { outFile, report } = await collect.collectMessages({ outDir, home });
    const records = readJsonl(outFile);
    // Original 3 unique (A day1, B, C) + the new A on day2 (different day) = 4 unique
    assert.strictEqual(records.length, 4);
    assert.strictEqual(report.total_dropped_dedup, 1);
  });

  test("--limit caps per-source kept count", async () => {
    seedTwoSources(home);
    const { report } = await collect.collectMessages({ outDir, home, limit: 1 });
    assert.strictEqual(report.per_source["claude-code"].kept, 1);
    assert.ok(report.total_dropped_limit >= 1);
  });

  test("--sources filter visits only listed adapters", async () => {
    seedTwoSources(home);
    const { report } = await collect.collectMessages({ outDir, home, sources: ["claude-code"] });
    assert.strictEqual(report.per_source["claude-code"].kept, 2);
    // skipped adapters never enter per_source — verify by absence
    assert.strictEqual(report.per_source.codex, undefined);
  });

  test("run with no sources yields empty file + report", async () => {
    const { outFile, report } = await collect.collectMessages({ outDir, home });
    assert.strictEqual(readJsonl(outFile).length, 0);
    assert.strictEqual(report.total_kept, 0);
    assert.ok(report.started_at && report.finished_at);
  });

  test("detectNotes surfaces known SQLite stores when present", async () => {
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const { report } = await collect.collectMessages({ outDir, home });
    assert.ok(report.notes.some((n) => n.includes("Cursor")));
  });
});

describe("collect.appendChatImport", () => {
  let outDir;
  beforeEach(() => { outDir = createTempDir("up-chat-imp-"); });
  afterEach(() => { cleanupTempDir(outDir); });

  test("appends to messages.jsonl and tracks per-file counts", async () => {
    const baseline = [
      { v: 1, source: "claude-code", ts: 1723766400000, text: "existing" },
    ];
    fs.writeFileSync(path.join(outDir, "messages.jsonl"), baseline.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const parsed = {
      format: "csv",
      messages: [
        { ts: 1723766500000, text: "chat-1", from_user: true, peer: "张三", _file: "a.csv" },
        { ts: 1723766600000, text: "chat-2", from_user: false, peer: "张三", _file: "a.csv" },
        { ts: 1723766700000, text: "chat-3", from_user: true, peer: "李四", _file: "b.csv" },
      ],
      errors: [],
    };
    const result = await collect.appendChatImport(outDir, parsed);
    assert.strictEqual(result.kept, 3);
    assert.strictEqual(result.perFile["a.csv"], 2);
    assert.strictEqual(result.perFile["b.csv"], 1);

    const all = readJsonl(path.join(outDir, "messages.jsonl"));
    assert.strictEqual(all.length, 4);
    assert.strictEqual(all[1].source, "chat-import");
    assert.strictEqual(all[1].from_user, true);
    assert.strictEqual(all[1].peer, "张三");
  });
});

// ---------------- analyzeMessages ----------------

describe("analyze.analyzeMessages", () => {
  let home;
  let outDir;
  beforeEach(() => {
    home = createTempDir("up-an-home-");
    outDir = createTempDir("up-an-out-");
  });
  afterEach(() => {
    cleanupTempDir(home);
    cleanupTempDir(outDir);
  });

  test("writes stats.json with documented fields", async () => {
    seedTwoSources(home);
    await collect.collectMessages({ outDir, home });
    const { stats, statsFile } = await analyze.analyzeMessages(outDir);
    assert.ok(fs.existsSync(statsFile));
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.activity.active_days, 1);
    assert.ok(stats.first_ts && stats.last_ts);
    assert.deepStrictEqual(Object.keys(stats.sources).sort(), ["claude-code", "codex"]);
    assert.ok(stats.top_latin_terms.length >= 0);
    assert.ok(stats.top_projects.length >= 1);
    assert.strictEqual(stats.top_projects[0].t, "repo");
  });

  test("throws when messages.jsonl is missing", async () => {
    await assert.rejects(
      analyze.analyzeMessages(outDir),
      /messages\.jsonl not found/
    );
  });

  test("captures recent ring (≤ 12 samples)", async () => {
    seedTwoSources(home);
    await collect.collectMessages({ outDir, home });
    const { stats } = await analyze.analyzeMessages(outDir);
    assert.ok(stats.samples.recent.length <= 12);
    assert.ok(stats.samples.recent.length > 0);
  });
});

// ---------------- renderAll ----------------

describe("render.renderAll", () => {
  let home;
  let outDir;
  let storeRoot;
  beforeEach(() => {
    home = createTempDir("up-rn-home-");
    outDir = createTempDir("up-rn-out-");
    storeRoot = createTempDir("up-rn-store-");
  });
  afterEach(() => {
    cleanupTempDir(home);
    cleanupTempDir(outDir);
    cleanupTempDir(storeRoot);
  });

  test("produces profile.json + PROFILE.md + dashboard.html + sources-report + inbox", async () => {
    seedTwoSources(home);
    await collect.collectMessages({ outDir, home });
    const { stats } = await analyze.analyzeMessages(outDir);
    const scan = JSON.parse(fs.readFileSync(path.join(outDir, "scan-report.json"), "utf8"));
    const arts = render.renderAll(outDir, { stats, scan, storeRoot, title: "tester" });

    // All artifact paths returned
    assert.ok(arts.profileJson && fs.existsSync(arts.profileJson));
    assert.ok(arts.profileMd && fs.existsSync(arts.profileMd));
    assert.ok(arts.dashboard && fs.existsSync(arts.dashboard));
    assert.ok(arts.sourcesReport && fs.existsSync(arts.sourcesReport));
    assert.ok(arts.inbox && fs.existsSync(arts.inbox));

    // profile.json is valid + P2 + kind correct
    const profile = JSON.parse(fs.readFileSync(arts.profileJson, "utf8"));
    assert.strictEqual(profile.v, 1);
    assert.strictEqual(profile.kind, "user-portrait");
    assert.strictEqual(profile.privacy.level, "P2");
    assert.strictEqual(profile.subject, "tester");
    assert.strictEqual(profile.coverage.total_messages, 3);
    assert.ok(profile.ai_sections.one_liner === null);

    // PROFILE.md has the 7 sections
    const md = fs.readFileSync(arts.profileMd, "utf8");
    for (const heading of [
      "## 1. 数据概览",
      "## 2. 活跃规律",
      "## 3. 关注技术",
      "## 4. 项目足迹",
      "## 5. 表达与语言",
      "## 6. AI 定性画像",
      "## 7. 隐私与使用规则",
    ]) {
      assert.ok(md.includes(heading), `missing section: ${heading}`);
    }
    assert.ok(md.includes("画像主体: tester"));

    // dashboard.html is valid HTML with embedded JSON.
    // The template closes its client-side <script> block, so we only check
    // that the injected data payload (preserved as var DATA = ...) is
    // properly escaped — no raw '<' or '</script>' can appear inside it.
    const html = fs.readFileSync(arts.dashboard, "utf8");
    assert.match(html, /<title>用户画像/);
    assert.ok(!html.includes("__PORTRAIT_DATA__"));
    assert.ok(html.includes("total"));
    assert.ok(html.includes("</script>"), "template closing </script> missing");
    const m = html.match(/var DATA = (\{[\s\S]*?\});\s*\n/);
    assert.ok(m, "no `var DATA = {…}` payload in dashboard");
    assert.ok(!m[1].includes("<"), "data payload contains raw '<' — script breakout risk");
    assert.ok(!m[1].includes("</script>"), "data payload contains '</script>' — breakout risk");

    // inbox pointer is appended (or replaces stale prior one)
    const inbox = fs.readFileSync(arts.inbox, "utf8");
    assert.match(inbox, /## Agent: user-portrait/);
    assert.match(inbox, /用户画像已生成/);
  });

  test("renderAll with no storeRoot skips inbox write", async () => {
    seedTwoSources(home);
    await collect.collectMessages({ outDir, home });
    const { stats } = await analyze.analyzeMessages(outDir);
    const scan = JSON.parse(fs.readFileSync(path.join(outDir, "scan-report.json"), "utf8"));
    const arts = render.renderAll(outDir, { stats, scan, storeRoot: null });
    assert.strictEqual(arts.inbox, null);
  });

  test("inbox pointer is idempotent on second render", async () => {
    seedTwoSources(home);
    await collect.collectMessages({ outDir, home });
    const { stats } = await analyze.analyzeMessages(outDir);
    const scan = JSON.parse(fs.readFileSync(path.join(outDir, "scan-report.json"), "utf8"));
    const a1 = render.renderAll(outDir, { stats, scan, storeRoot });
    const a2 = render.renderAll(outDir, { stats, scan, storeRoot });
    // Second render replaces stale pointer instead of doubling
    const inbox = fs.readFileSync(a1.inbox, "utf8");
    const occ = (inbox.match(/用户画像已生成/g) || []).length;
    assert.strictEqual(occ, 1);
  });
});
