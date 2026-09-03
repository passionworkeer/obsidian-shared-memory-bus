/**
 * tests/unit/js/user-portrait.test.js
 * ----------------------------------
 * Unit tests for skills/user-portrait: schema redaction/filtering, source
 * adapters against synthetic fixtures, chat-import parsers, the collect →
 * analyze → render pipeline, and the bus inbox write-back.
 *
 * All fixtures live in a throwaway temp "home" — no real user data is read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildMessage, redact } from "../../../skills/user-portrait/lib/schema.js";
import { collectMessages, appendChatImport } from "../../../skills/user-portrait/lib/collect.js";
import { analyzeMessages } from "../../../skills/user-portrait/lib/analyze.js";
import { renderAll } from "../../../skills/user-portrait/lib/render.js";
import { parseChatFile, parseChatPath } from "../../../skills/user-portrait/lib/sources/chat-import.js";
import claudeCode from "../../../skills/user-portrait/lib/sources/claude-code.js";
import codex from "../../../skills/user-portrait/lib/sources/codex.js";
import { toMs, textFromContent, normalizeForDedup, dayKey } from "../../../skills/user-portrait/lib/util.js";

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-test-"));
  return dir;
}

function write(rel, content, home) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

// ---------------------------------------------------------------- schema

test("redact strips credential shapes", () => {
  const out = redact("my key is sk-abcdef0123456789abcdef and bearer abcdef0123456789abcdef");
  assert.ok(out.includes("[REDACTED:key]"));
  assert.ok(!out.includes("sk-abcdef0123456789"));
  assert.ok(out.includes("[REDACTED:token]"));
});

test("redact strict also masks email and phone", () => {
  const out = redact("contact a@b.com or 13812345678", "strict");
  assert.ok(!out.includes("a@b.com"));
  assert.ok(!out.includes("13812345678"));
  const def = redact("contact a@b.com", "default");
  assert.equal(def, "contact a@b.com");
});

test("buildMessage drops meta/noise and unwraps user_query", () => {
  assert.equal(buildMessage({ source: "x", text: "<system-reminder>hi</system-reminder>" }), null);
  assert.equal(buildMessage({ source: "x", text: "Caveat: something" }), null);
  assert.equal(buildMessage({ source: "x", text: "   " }), null);
  const unwrapped = buildMessage({ source: "x", text: "<user_query>帮我写个脚本</user_query>" });
  assert.equal(unwrapped.text, "帮我写个脚本");
});

test("buildMessage truncates long input and keeps structure", () => {
  const msg = buildMessage({ source: "x", ts: 1723766400000, text: "a".repeat(9000), project: "p", session: "s" });
  assert.ok(msg.text.length <= 4100);
  assert.equal(msg.project, "p");
  assert.equal(msg.source, "x");
});

// ---------------------------------------------------------------- util

test("toMs handles ms/s epochs and ISO strings", () => {
  assert.equal(toMs(1723766400000), 1723766400000);
  assert.equal(toMs(1723766400), 1723766400000);
  assert.equal(toMs("2026-08-16T00:00:00Z"), Date.parse("2026-08-16T00:00:00Z"));
  assert.equal(toMs(null), null);
});

test("textFromContent handles string and block arrays", () => {
  assert.equal(textFromContent("plain"), "plain");
  assert.equal(textFromContent([{ type: "text", text: "a" }, { type: "tool_result" }]), "a");
});

// ---------------------------------------------------------------- adapters

test("claude-code adapter reads history.jsonl and project transcripts", async () => {
  const home = tmpHome();
  write(".claude/history.jsonl", JSON.stringify({ display: "帮我优化这个函数", timestamp: 1723766400000, project: "E:\\proj\\demo", sessionId: "s1" }) + "\n", home);
  write(
    ".claude/projects/E--proj-demo/s1.jsonl",
    [
      JSON.stringify({ type: "user", isMeta: false, timestamp: 1723766500000, cwd: "E:\\proj\\demo", sessionId: "s1", message: { content: [{ type: "text", text: "帮我优化这个函数" }] } }),
      JSON.stringify({ type: "user", isMeta: true, timestamp: 1723766600000, message: { content: "meta noise" } }),
      JSON.stringify({ type: "assistant", message: { content: "reply" } }),
    ].join("\n") + "\n",
    home
  );

  const report = { files: 0, yielded: 0, kept: 0, errors: [] };
  const seen = [];
  for await (const m of claudeCode.collect({ home, report })) seen.push(m);
  assert.equal(seen.length, 2); // history + non-meta user turn (dup removed later by collect)
  assert.ok(report.files >= 2);
});

test("codex adapter filters environment wrappers", async () => {
  const home = tmpHome();
  write(
    ".codex/sessions/2026/08/16/rollout-1.jsonl",
    [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/home/u/repo" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>be nice</user_instructions>" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑一下测试" }] } }),
    ].join("\n") + "\n",
    home
  );
  const report = { files: 0, yielded: 0, kept: 0, errors: [] };
  const seen = [];
  for await (const m of codex.collect({ home, report })) seen.push(m);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "跑一下测试");
  assert.equal(seen[0].project, "repo");
});

// ---------------------------------------------------------------- chat import

test("chat-import parses MemoTrace-style CSV with Chinese headers", () => {
  const home = tmpHome();
  const csv = write("chat.csv", "消息时间,IsSend,发送者,消息内容\n2026-01-02 10:30:00,1,我,今晚一起吃饭\n2026-01-02 10:31:00,0,张三,好啊\n", home);
  const r = parseChatFile(csv);
  assert.equal(r.format, "csv");
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].from_user, true);
  assert.equal(r.messages[1].from_user, false);
  assert.equal(r.messages[0].text, "今晚一起吃饭");
  assert.ok(r.messages[0].ts > 0);
});

test("chat-import parses WeChat txt block format", () => {
  const home = tmpHome();
  const txt = write(
    "chat.txt",
    "2026-01-02 10:30:00 张三\n在吗\n帮我看看这个bug\n\n2026-01-02 10:31:12 我\n在的\n",
    home
  );
  const r = parseChatFile(txt);
  assert.equal(r.messages.length, 2); // two timestamped header blocks
  assert.equal(r.messages[0].text, "在吗\n帮我看看这个bug");
  assert.equal(r.messages[1].from_user, true);
});

test("chat-import parses generic JSON export", () => {
  const home = tmpHome();
  const j = write("chat.json", JSON.stringify({ messages: [{ time: 1767000000000, content: "第一句", isSend: 1 }, { time: 1767000060000, content: "第二句", isSend: 0 }] }), home);
  const r = parseChatFile(j);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].from_user, true);
});

test("parseChatPath walks a directory", () => {
  const home = tmpHome();
  write("exp/a.csv", "消息时间,消息内容\n2026-01-02 10:30:00,hi\n", home);
  write("exp/b.txt", "2026-01-03 11:00:00 我\nok\n", home);
  const r = parseChatPath(path.join(home, "exp"));
  assert.equal(r.messages.length, 2);
});

// ---------------------------------------------------------------- pipeline

async function buildFixtureHome() {
  const home = tmpHome();
  write(".claude/history.jsonl", [
    JSON.stringify({ display: "帮我写一个 RAG 检索的单元测试", timestamp: Date.parse("2026-08-01T10:00:00"), project: "E:\\proj\\demo", sessionId: "s1" }),
    JSON.stringify({ display: "帮我写一个 RAG 检索的单元测试", timestamp: Date.parse("2026-08-01T10:00:01"), project: "E:\\proj\\demo", sessionId: "s1" }), // dup
    JSON.stringify({ display: "RAG 召回率低怎么调参", timestamp: Date.parse("2026-08-01T15:00:00"), project: "E:\\proj\\demo", sessionId: "s1" }),
    JSON.stringify({ display: "sk-test123456789012345 不要泄露", timestamp: Date.parse("2026-08-02T23:30:00"), project: "E:\\proj\\demo" }),
    JSON.stringify({ display: "python 脚本怎么批量重命名", timestamp: Date.parse("2026-08-03T08:00:00"), project: "E:\\proj\\other" }),
    JSON.stringify({ display: "用 python 处理 csv 乱码", timestamp: Date.parse("2026-08-03T09:00:00"), project: "E:\\proj\\other" }),
  ].join("\n") + "\n", home);
  write(".codex/history.jsonl", [
    JSON.stringify({ session_id: "c1", ts: Date.parse("2026-08-04T09:00:00"), text: "docker compose 起不来怎么排查" }),
    JSON.stringify({ session_id: "c2", ts: Date.parse("2026-08-04T10:00:00"), text: "docker 网络模式有什么区别" }),
  ].join("\n") + "\n", home);
  return home;
}

test("collect dedups and redacts into messages.jsonl", async () => {
  const home = await buildFixtureHome();
  const outDir = path.join(home, "portrait-out");
  const { outFile, report } = await collectMessages({ outDir, home, redactMode: "default" });

  const lines = fs.readFileSync(outFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  // history dup (same day+text) must collapse; secret must be redacted
  const texts = lines.map((l) => l.text);
  const dupText = "帮我写一个 RAG 检索的单元测试";
  assert.equal(texts.filter((t) => t === dupText).length, 1);
  assert.ok(texts.some((t) => t.includes("[REDACTED:key]")));
  assert.ok(report.total_dropped_dedup >= 1);
  assert.ok(fs.existsSync(path.join(outDir, "scan-report.json")));
});

test("analyze computes timeline/keywords/projects", async () => {
  const home = await buildFixtureHome();
  const outDir = path.join(home, "portrait-out");
  await collectMessages({ outDir, home, redactMode: "default" });
  const { stats } = await analyzeMessages(outDir);

  assert.ok(stats.total >= 7);
  assert.equal(stats.activity.active_days, 4);
  assert.equal(stats.days["2026-08-01"], 2);
  assert.ok(stats.top_latin_terms.some((e) => ["rag", "docker", "python"].includes(e.t)));
  assert.ok(stats.top_projects.some((p) => p.t === "demo"));
  assert.equal(stats.sources["claude-code"].count >= 5, true);
  assert.ok(fs.existsSync(path.join(outDir, "stats.json")));
});

test("render produces all artifacts and inbox pointer", async () => {
  const home = await buildFixtureHome();
  const outDir = path.join(home, "portrait-out");
  const storeRoot = path.join(home, "fake-store");
  const { report } = await collectMessages({ outDir, home, redactMode: "default" });
  const { stats } = await analyzeMessages(outDir);
  const arts = renderAll(outDir, { stats, scan: report, storeRoot, title: "测试用户" });

  const md = fs.readFileSync(arts.profileMd, "utf-8");
  assert.ok(md.includes("# 用户画像"));
  assert.ok(md.includes("## 6. AI 定性画像"));
  assert.ok(md.includes("P2"));
  assert.ok(md.includes("测试用户"));

  const pj = JSON.parse(fs.readFileSync(arts.profileJson, "utf-8"));
  assert.equal(pj.kind, "user-portrait");
  assert.equal(pj.coverage.total_messages, stats.total);
  assert.equal(pj.ai_sections.one_liner, null);

  const dash = fs.readFileSync(arts.dashboard, "utf-8");
  assert.ok(dash.includes("User Portrait"));
  assert.ok(!dash.includes("__PORTRAIT_DATA__"));
  assert.ok(dash.includes("用户消息"));

  assert.ok(fs.existsSync(arts.sourcesReport));
  const inbox = fs.readFileSync(arts.inbox, "utf-8");
  assert.ok(inbox.includes("## Agent: user-portrait"));
  assert.ok(inbox.includes("PROFILE.md"));
});

test("appendChatImport writes chat records with source tag", async () => {
  const home = await buildFixtureHome();
  const outDir = path.join(home, "portrait-out");
  await collectMessages({ outDir, home, redactMode: "default" });

  const csvFile = write("wx.csv", "消息时间,IsSend,消息内容\n2026-01-02 10:30:00,1,微信里的第一句\n", home);
  const parsed = parseChatFile(csvFile);
  const { kept } = await appendChatImport(outDir, parsed);
  assert.equal(kept, 1);

  const { stats } = await analyzeMessages(outDir);
  assert.equal(stats.chat.total, 1);
  assert.equal(stats.chat.from_user, 1);
});
