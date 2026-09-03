/**
 * tests/unit/js/user-portrait-sources.test.js
 * --------------------------------------------
 * Unit tests for the user-portrait skill's source adapters:
 *   - skills/user-portrait/lib/sources/chat-import.js
 *   - skills/user-portrait/lib/sources/{claude-code,codex,cursor,
 *     copilot-cli,gemini-cli,opencode,zcode,codebuddy}.js
 *
 * Run with: node --test tests/unit/js/user-portrait-sources.test.js
 *
 * Each adapter is exercised against a freshly-built fake $HOME so we never
 * touch the user's real ~/.claude / ~/.cursor / etc. The assertions cover
 * happy-path extraction, the per-source filter (e.g. claude-code skips
 * isMeta records), and silent skip on missing root.
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

const SOURCE_FILES = {
  "claude-code": "skills/user-portrait/lib/sources/claude-code.js",
  codex: "skills/user-portrait/lib/sources/codex.js",
  cursor: "skills/user-portrait/lib/sources/cursor.js",
  "copilot-cli": "skills/user-portrait/lib/sources/copilot-cli.js",
  "gemini-cli": "skills/user-portrait/lib/sources/gemini-cli.js",
  opencode: "skills/user-portrait/lib/sources/opencode.js",
  zcode: "skills/user-portrait/lib/sources/zcode.js",
  codebuddy: "skills/user-portrait/lib/sources/codebuddy.js",
  "chat-import": "skills/user-portrait/lib/sources/chat-import.js",
};

const sources = {};
for (const [id, file] of Object.entries(SOURCE_FILES)) {
  sources[id] = await import(pathToFileURL(path.join(_projectRoot, file)));
}

// mkdir -p a/b/c under root, returns final path
function mkdirp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function writeJsonl(filePath, records) {
  mkdirp(filePath);
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function writeText(filePath, body) {
  mkdirp(filePath);
  fs.writeFileSync(filePath, body, "utf8");
}

async function runAdapter(adapter, home) {
  const report = { files: 0, yielded: 0, errors: [] };
  const out = [];
  for await (const m of adapter.collect({ home, report })) out.push(m);
  return { out, report };
}

// ---------------- chat-import ----------------

describe("chat-import.parseChatFile", () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir("up-chat-"); });
  afterEach(() => { cleanupTempDir(tmp); });

  test("CSV: parses MemoTrace-style with IsSend", () => {
    const f = path.join(tmp, "wechat.csv");
    writeText(
      f,
      "strTime,IsSend,StrContent,Username\n" +
        "2026-01-01 12:00:00,1,hello,张三\n" +
        "2026-01-01 12:01:00,0,hi back,张三\n"
    );
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.format, "csv");
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].text, "hello");
    assert.strictEqual(r.messages[0].from_user, true);
    assert.strictEqual(r.messages[1].from_user, false);
    assert.strictEqual(r.messages[0].peer, "张三");
  });

  test("CSV: missing time column → error", () => {
    const f = path.join(tmp, "bad.csv");
    writeText(f, "foo,bar\n1,2\n");
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.messages.length, 0);
    assert.ok(r.errors[0].includes("no time/content"));
  });

  test("TXT: parses 'timestamp name' blocks", () => {
    const f = path.join(tmp, "qq.txt");
    writeText(
      f,
      "2026-01-01 12:00:00 我\n你好,这是我发的消息\n2026-01-01 12:01:00 张三\n我收到了\n"
    );
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.format, "txt");
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].text, "你好,这是我发的消息");
    assert.strictEqual(r.messages[0].from_user, true);
    assert.strictEqual(r.messages[1].from_user, undefined);
  });

  test("JSON: top-level array shape", () => {
    const f = path.join(tmp, "export.json");
    writeText(
      f,
      JSON.stringify([
        { time: 1735689600, content: "msg-1", isSend: 1 },
        { time: 1735689601, content: "msg-2", isSend: 0 },
      ])
    );
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].ts, 1735689600 * 1000);
    assert.strictEqual(r.messages[0].from_user, true);
  });

  test("JSON: accepts {messages:[]} envelope", () => {
    const f = path.join(tmp, "env.json");
    writeText(
      f,
      JSON.stringify({
        messages: [{ time: "2026-01-01T12:00:00Z", content: "body" }],
      })
    );
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.messages.length, 1);
    assert.strictEqual(r.messages[0].text, "body");
  });

  test("HTML: strips tags then parses", () => {
    const f = path.join(tmp, "export.html");
    // No leading <p> on first line — parseTxtBlocks anchors HEADER_TS_NAME at
    // line start, so we need to keep lines from beginning tag-free.
    writeText(
      f,
      "2026-01-01 12:00:00 我<br>你好世界</p>\n2026-01-01 12:01:00 张三<br>回复</p>\n"
    );
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.format, "html");
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].text, "你好世界");
  });

  test("unsupported extension returns error", () => {
    const f = path.join(tmp, "x.xyz");
    writeText(f, "whatever");
    const r = sources["chat-import"].parseChatFile(f);
    assert.strictEqual(r.messages.length, 0);
    assert.match(r.errors[0], /unsupported extension/);
  });

  test("parseChatPath: directory scans every supported file", () => {
    writeText(path.join(tmp, "a.csv"), "strTime,IsSend,content\n2026-01-01 12:00:00,1,hi\n");
    writeText(path.join(tmp, "b.txt"), "2026-01-01 12:00:00 我\nhola\n");
    writeText(path.join(tmp, "ignore.png"), "binary");
    const r = sources["chat-import"].parseChatPath(tmp);
    assert.strictEqual(r.messages.length, 2);
    assert.ok(r.messages.every((m) => typeof m._file === "string"));
  });
});

// ---------------- claude-code ----------------

describe("source: claude-code", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-cc-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts from history.jsonl + projects/*.jsonl", async () => {
    writeJsonl(path.join(home, ".claude/history.jsonl"), [
      { display: "first prompt", timestamp: 1723766400000, project: "/r/repo", sessionId: "s1" },
      { display: "second prompt", timestamp: 1723766500000, project: "/r/repo", sessionId: "s1" },
    ]);
    writeJsonl(path.join(home, ".claude/projects/munged/abc.jsonl"), [
      { type: "user", timestamp: 1723766600000, message: { content: "session user msg" }, sessionId: "s1", cwd: "/r/repo" },
      { type: "user", isMeta: true, timestamp: 1723766700000, message: { content: "meta skipped" }, sessionId: "s1" },
      { type: "assistant", timestamp: 1723766800000, message: { content: "model reply, ignored" }, sessionId: "s1" },
    ]);
    const { out, report } = await runAdapter(sources["claude-code"], home);
    assert.strictEqual(out.length, 3); // 2 history + 1 user session (meta skipped)
    assert.strictEqual(out.filter((m) => m.text === "first prompt").length, 1);
    assert.strictEqual(out.filter((m) => m.text === "session user msg").length, 1);
    assert.strictEqual(out.filter((m) => m.text === "meta skipped").length, 0);
    assert.strictEqual(report.files, 2);
  });

  test("silent when ~/.claude missing", async () => {
    const { out } = await runAdapter(sources["claude-code"], home);
    assert.strictEqual(out.length, 0);
  });
});

// ---------------- codex ----------------

describe("source: codex", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-codex-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts sessions + history.jsonl, drops injected context", async () => {
    writeJsonl(path.join(home, ".codex/sessions/2026/01/01/rollout-X.jsonl"), [
      { type: "session_meta", payload: { cwd: "/r/repo", session_id: "sx" } },
      {
        type: "response_item",
        timestamp: 1723766400000,
        payload: {
          type: "message",
          role: "user",
          session_id: "sx",
          content: [{ type: "input_text", text: "real user question" }],
        },
      },
      {
        type: "response_item",
        timestamp: 1723766500000,
        payload: {
          type: "message",
          role: "user",
          session_id: "sx",
          content: [{ type: "input_text", text: "<environment_context>skip me</environment_context>" }],
        },
      },
    ]);
    writeJsonl(path.join(home, ".codex/history.jsonl"), [
      { session_id: "sx", ts: 1723766600000, text: "typed prompt" },
    ]);
    const { out } = await runAdapter(sources.codex, home);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(
      out.map((m) => m.text).sort(),
      ["real user question", "typed prompt"]
    );
    assert.strictEqual(out.find((m) => m.text === "real user question").project, "repo");
  });

  test("silent when ~/.codex missing", async () => {
    const { out } = await runAdapter(sources.codex, home);
    assert.strictEqual(out.length, 0);
  });
});

// ---------------- cursor ----------------

describe("source: cursor", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-cursor-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts agent-transcripts only", async () => {
    writeJsonl(path.join(home, ".cursor/projects/myrepo/agent-transcripts/uuid/uuid.jsonl"), [
      { role: "user", message: { content: [{ type: "text", text: "<user_query>q?</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "bot reply" }] } },
    ]);
    // not under agent-transcripts → must be ignored
    writeJsonl(path.join(home, ".cursor/projects/myrepo/random/foo.jsonl"), [
      { role: "user", message: { content: "should not be picked" } },
    ]);
    const { out } = await runAdapter(sources.cursor, home);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, "<user_query>q?</user_query>"); // wrapper stripped by buildMessage, not here
    assert.strictEqual(out[0].project, "myrepo");
  });

  test("silent when ~/.cursor/projects missing", async () => {
    const { out } = await runAdapter(sources.cursor, home);
    assert.strictEqual(out.length, 0);
  });
});

// ---------------- copilot-cli ----------------

describe("source: copilot-cli", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-cop-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts user.message events only", async () => {
    writeJsonl(path.join(home, ".copilot/session-state/abc/events.jsonl"), [
      { type: "user.message", data: { content: "hello copilot", timestamp: 1723766400000 } },
      { type: "assistant.message", data: { content: "model reply" } },
      { type: "user.message", data: { content: "   " } }, // empty after trim
    ]);
    const { out } = await runAdapter(sources["copilot-cli"], home);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, "hello copilot");
    assert.strictEqual(out[0].ts, 1723766400000);
  });
});

// ---------------- gemini-cli ----------------

describe("source: gemini-cli", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-gem-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts user messages from session JSONs", async () => {
    writeText(
      path.join(home, ".gemini/tmp/proj1/chats/session-2026.json"),
      JSON.stringify({
        messages: [
          { type: "user", content: "hi" },
          { type: "model", content: "reply" },
          { type: "user", content: [{ type: "text", text: "block-form" }] },
        ],
      })
    );
    writeText(
      path.join(home, ".gemini/tmp/proj2/chats/session-2026.json"),
      JSON.stringify({ messages: [{ type: "user", content: "other" }] })
    );
    // outside chats/ directory → ignored
    writeText(
      path.join(home, ".gemini/tmp/proj3/session-stray.json"),
      JSON.stringify({ messages: [{ type: "user", content: "stray" }] })
    );
    const { out } = await runAdapter(sources["gemini-cli"], home);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(
      out.map((m) => m.text).sort(),
      ["block-form", "hi", "other"]
    );
  });
});

// ---------------- opencode ----------------

describe("source: opencode", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-oc-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("joins text parts by message id", async () => {
    mkdirp(path.join(home, ".local/share/opencode/storage/message/sess1"));
    mkdirp(path.join(home, ".local/share/opencode/storage/part"));
    writeText(
      path.join(home, ".local/share/opencode/storage/message/sess1/m1.json"),
      JSON.stringify({ id: "m1", sessionID: "sess1", role: "user", time: { created: 1723766400000 } })
    );
    writeText(
      path.join(home, ".local/share/opencode/storage/part/m1/p1.json"),
      JSON.stringify({ messageID: "m1", type: "text", text: "user prompt here" })
    );
    const { out } = await runAdapter(sources.opencode, home);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, "user prompt here");
    assert.strictEqual(out[0].ts, 1723766400000);
    assert.strictEqual(out[0].session, "sess1");
  });

  test("skips assistant messages", async () => {
    mkdirp(path.join(home, ".local/share/opencode/storage/message/sess1"));
    mkdirp(path.join(home, ".local/share/opencode/storage/part"));
    writeText(
      path.join(home, ".local/share/opencode/storage/message/sess1/m1.json"),
      JSON.stringify({ id: "m1", sessionID: "sess1", role: "assistant", time: { created: 1 } })
    );
    writeText(
      path.join(home, ".local/share/opencode/storage/part/m1/p1.json"),
      JSON.stringify({ messageID: "m1", type: "text", text: "model text" })
    );
    const { out } = await runAdapter(sources.opencode, home);
    assert.strictEqual(out.length, 0);
  });
});

// ---------------- zcode ----------------

describe("source: zcode", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-zc-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts user turns from request.body.messages", async () => {
    writeJsonl(path.join(home, ".zcode/cli/rollout/rollout-1.jsonl"), [
      {
        timestamp: 1723766400000,
        request: { body: { messages: [{ role: "user", content: "real ask" }] } },
      },
      {
        timestamp: 1723766500000,
        request: { body: { messages: [{ role: "user", content: "<some-context>inject</some-context>" }] } },
      },
    ]);
    const { out } = await runAdapter(sources.zcode, home);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, "real ask");
  });
});

// ---------------- codebuddy ----------------

describe("source: codebuddy", () => {
  let home;
  beforeEach(() => { home = createTempDir("up-cb-"); });
  afterEach(() => { cleanupTempDir(home); });

  test("extracts from history.jsonl (same shape as claude-code)", async () => {
    writeJsonl(path.join(home, ".codebuddy/history.jsonl"), [
      { display: "buddy prompt", timestamp: 1723766400000, project: "/r/repo" },
      { display: "", timestamp: 1723766500000 }, // empty after trim
    ]);
    const { out } = await runAdapter(sources.codebuddy, home);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, "buddy prompt");
    assert.strictEqual(out[0].project, "repo");
  });
});
