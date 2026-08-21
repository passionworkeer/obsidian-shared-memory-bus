/**
 * tests/unit/js/user-portrait-core.test.js
 * -----------------------------------------
 * Unit tests for the user-portrait skill's core helpers:
 *   - skills/user-portrait/lib/util.js
 *   - skills/user-portrait/lib/schema.js
 *
 * Run with: npm run test:portrait
 *   (or:   node --test tests/unit/js/user-portrait-core.test.js)
 *
 * These cover the building blocks every source adapter and pipeline step
 * relies on: file walking, JSONL streaming, text normalization, day keys,
 * timestamp parsing, CJK ratio, and privacy redaction.
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

const util = await import(
  pathToFileURL(path.join(_projectRoot, "skills/user-portrait/lib/util.js"))
);
const schema = await import(
  pathToFileURL(path.join(_projectRoot, "skills/user-portrait/lib/schema.js"))
);

// ---------------- util.js ----------------

describe("util.walkFiles", () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir("up-walk-"); });
  afterEach(() => { cleanupTempDir(tmp); });

  test("yields matching files recursively", async () => {
    fs.writeFileSync(path.join(tmp, "a.jsonl"), "");
    fs.mkdirSync(path.join(tmp, "sub"));
    fs.writeFileSync(path.join(tmp, "sub", "b.jsonl"), "");
    fs.writeFileSync(path.join(tmp, "sub", "c.txt"), "");
    const got = [];
    for await (const f of util.walkFiles(tmp, /\.jsonl$/i)) got.push(path.basename(f));
    assert.deepStrictEqual(got.sort(), ["a.jsonl", "b.jsonl"]);
  });

  test("respects maxDepth", async () => {
    fs.mkdirSync(path.join(tmp, "d1", "d2", "d3"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "d1", "d2", "d3", "deep.jsonl"), "");
    const got = [];
    for await (const f of util.walkFiles(tmp, /\.jsonl$/i, { maxDepth: 1 })) got.push(f);
    assert.strictEqual(got.length, 0);
  });

  test("returns nothing when root is missing", async () => {
    const got = [];
    for await (const f of util.walkFiles(path.join(tmp, "nope"), /.*/)) got.push(f);
    assert.strictEqual(got.length, 0);
  });
});

describe("util.streamJsonl", () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir("up-jsonl-"); });
  afterEach(() => { cleanupTempDir(tmp); });

  test("yields valid records, skips blanks and malformed", async () => {
    const f = path.join(tmp, "m.jsonl");
    fs.writeFileSync(
      f,
      JSON.stringify({ a: 1 }) + "\n\n" + "{ broken" + "\n" + JSON.stringify({ a: 2 }) + "\n",
      "utf8"
    );
    const got = [];
    for await (const r of util.streamJsonl(f)) got.push(r);
    assert.deepStrictEqual(got, [{ a: 1 }, { a: 2 }]);
  });

  test("yields nothing for missing file", async () => {
    const got = [];
    for await (const r of util.streamJsonl(path.join(tmp, "absent.jsonl"))) got.push(r);
    assert.strictEqual(got.length, 0);
  });
});

describe("util.readJsonSafe", () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir("up-rjs-"); });
  afterEach(() => { cleanupTempDir(tmp); });

  test("returns parsed value", () => {
    const f = path.join(tmp, "ok.json");
    fs.writeFileSync(f, JSON.stringify({ x: 1 }), "utf8");
    assert.deepStrictEqual(util.readJsonSafe(f), { x: 1 });
  });
  test("returns null on missing / malformed", () => {
    assert.strictEqual(util.readJsonSafe(path.join(tmp, "nope.json")), null);
    const f = path.join(tmp, "bad.json");
    fs.writeFileSync(f, "{not json", "utf8");
    assert.strictEqual(util.readJsonSafe(f), null);
  });
});

describe("util.exists", () => {
  test("true for existing path, false otherwise", () => {
    const tmp = createTempDir("up-exists-");
    fs.writeFileSync(path.join(tmp, "f"), "x");
    assert.strictEqual(util.exists(path.join(tmp, "f")), true);
    assert.strictEqual(util.exists(path.join(tmp, "missing")), false);
    cleanupTempDir(tmp);
  });
});

describe("util.fmtBytes", () => {
  test("formats B / KB / MB / GB", () => {
    assert.strictEqual(util.fmtBytes(0), "0 B");
    assert.strictEqual(util.fmtBytes(512), "512 B");
    assert.strictEqual(util.fmtBytes(2048), "2.0 KB");
    assert.strictEqual(util.fmtBytes(5 * 1024 * 1024), "5.0 MB");
    assert.strictEqual(util.fmtBytes(2 * 1024 * 1024 * 1024), "2.00 GB");
  });
  test("returns ? for non-numeric", () => {
    assert.strictEqual(util.fmtBytes(NaN), "?");
    assert.strictEqual(util.fmtBytes("x"), "?");
  });
});

describe("util.normalizeForDedup", () => {
  test("collapses whitespace, lowercases, truncates 200", () => {
    assert.strictEqual(util.normalizeForDedup("  Hello   WORLD  "), "hello world");
    assert.strictEqual(util.normalizeForDedup("A".repeat(300)).length, 200);
  });
  test("handles null / empty", () => {
    assert.strictEqual(util.normalizeForDedup(null), "");
    assert.strictEqual(util.normalizeForDedup(undefined), "");
  });
});

describe("util.textFromContent", () => {
  test("string passthrough", () => {
    assert.strictEqual(util.textFromContent("hi"), "hi");
  });
  test("joins text blocks from content array", () => {
    assert.strictEqual(
      util.textFromContent([
        { type: "text", text: "a" },
        { type: "tool_result", content: "ignored" },
        { type: "text", text: "b" },
      ]),
      "a\nb"
    );
  });
  test("returns empty for null / non-string non-array", () => {
    assert.strictEqual(util.textFromContent(null), "");
    assert.strictEqual(util.textFromContent({ type: "text", text: "x" }), "");
  });
});

describe("util.cjkRatio", () => {
  test("all-cjk = 1", () => {
    assert.strictEqual(util.cjkRatio("你好世界"), 1);
  });
  test("all-latin = 0", () => {
    assert.strictEqual(util.cjkRatio("hello world"), 0);
  });
  test("mixed", () => {
    const r = util.cjkRatio("hello 你好 world 世界");
    assert.ok(r > 0 && r < 1);
  });
  test("zero on empty / null", () => {
    assert.strictEqual(util.cjkRatio(""), 0);
    assert.strictEqual(util.cjkRatio(null), 0);
  });
});

describe("util.dayKey", () => {
  test("formats ms epoch to yyyy-mm-dd", () => {
    const d = new Date(2026, 0, 5); // 2026-01-05 local
    assert.strictEqual(util.dayKey(d.getTime()), "2026-01-05");
  });
  test("returns null on invalid", () => {
    assert.strictEqual(util.dayKey("not-a-date"), null);
    assert.strictEqual(util.dayKey(NaN), null);
  });
});

describe("util.toMs", () => {
  test("ms epoch (large number)", () => {
    assert.strictEqual(util.toMs(1723766400000), 1723766400000);
  });
  test("seconds epoch (scaled × 1000)", () => {
    assert.strictEqual(util.toMs(1723766400), 1723766400000);
  });
  test("ISO string", () => {
    const ms = util.toMs("2026-01-05T12:00:00Z");
    assert.ok(Number.isFinite(ms) && ms > 1e12);
  });
  test("null / invalid", () => {
    assert.strictEqual(util.toMs(null), null);
    assert.strictEqual(util.toMs("not a date"), null);
    assert.strictEqual(util.toMs(100), null); // too small to be epoch
  });
});

// ---------------- schema.js ----------------

describe("schema.redact", () => {
  test("default mode strips OpenAI / GitHub / Slack / Anthropic keys", () => {
    assert.match(schema.redact("here is sk-abcdef1234567890abcdef12 ok"), /\[REDACTED:key\]/);
    assert.match(schema.redact("token ghp_abcdefghijklmnopqrstuv"), /\[REDACTED:key\]/);
    assert.match(schema.redact("Bearer xoxb-1234567890-abcdefghij"), /Bearer \[REDACTED:key\]/);
  });

  test("default mode strips AWS keys, bearer strings, private key blocks, long hex", () => {
    assert.match(schema.redact("AKIAABCDEFGHIJKLMNOP"), /\[REDACTED:awskey\]/);
    assert.match(schema.redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"), /\[REDACTED:token\]/);
    assert.match(
      schema.redact("-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----"),
      /\[REDACTED:pem\]/
    );
    const hex = "a".repeat(80);
    assert.match(schema.redact(`hash ${hex}`), /\[REDACTED:hex\]/);
  });

  test("default mode strips connection strings with credentials", () => {
    assert.match(schema.redact("postgres://user:pass@host:5432/db"), /\[REDACTED:userpass\]@/);
  });

  test("strict mode redacts emails and phones", () => {
    assert.match(schema.redact("mail me at alice@example.com", "strict"), /\[REDACTED:email\]/);
    assert.match(schema.redact("call +86 13800000000", "strict"), /\[REDACTED:phone\]/);
  });

  test("off mode returns text untouched", () => {
    const raw = "sk-abcdef1234567890abcdef22 alice@example.com";
    assert.strictEqual(schema.redact(raw, "off"), raw);
  });

  test("null / empty inputs", () => {
    assert.strictEqual(schema.redact(null), null);
    assert.strictEqual(schema.redact(""), "");
  });
});

describe("schema.buildMessage", () => {
  test("returns a normalized v1 record", () => {
    const m = schema.buildMessage({
      source: "claude-code",
      ts: 1723766400000,
      text: "hello world",
      project: "repo",
      session: "abc",
    });
    assert.strictEqual(m.v, 1);
    assert.strictEqual(m.source, "claude-code");
    assert.strictEqual(m.text, "hello world");
    assert.strictEqual(m.project, "repo");
    assert.strictEqual(m.session, "abc");
  });

  test("returns null for empty text", () => {
    assert.strictEqual(schema.buildMessage({ source: "x", text: "   " }), null);
  });

  test("drops system-reminder / command-name / caveat noise", () => {
    assert.strictEqual(schema.buildMessage({ source: "x", text: "<system-reminder>foo" }), null);
    assert.strictEqual(schema.buildMessage({ source: "x", text: "Caveat: nothing" }), null);
    assert.strictEqual(schema.buildMessage({ source: "x", text: "<command-name>foo" }), null);
  });

  test("strips <user_query>...</user_query> wrapper but keeps inner text", () => {
    const m = schema.buildMessage({ source: "x", text: "<user_query>real question</user_query>" });
    assert.strictEqual(m.text, "real question");
  });

  test("truncates text longer than maxChars", () => {
    const long = "x".repeat(5000);
    const m = schema.buildMessage({ source: "x", text: long }, { maxChars: 100 });
    assert.ok(m.text.length <= 102); // 100 + "…"
    assert.match(m.text, /…$/);
  });

  test("applies redact (default vs strict vs off)", () => {
    // "token=…" matches the bearer/token rule (note: `API_TOKEN=` triggers
    // word-boundary issues — use bare `token=value` to exercise the rule).
    const raw = "token=abcdefghijklmnop0123456789abcdef mail=test@example.com";
    const def = schema.buildMessage({ source: "x", text: raw });
    const strict = schema.buildMessage({ source: "x", text: raw }, { redactMode: "strict" });
    const off = schema.buildMessage({ source: "x", text: raw }, { redactMode: "off" });
    assert.match(def.text, /\[REDACTED:token\]/);
    assert.doesNotMatch(def.text, /\[REDACTED:email\]/);
    assert.match(strict.text, /\[REDACTED:email\]/);
    assert.strictEqual(off.text, raw);
  });

  test("clamps project / session / peer to documented lengths", () => {
    const m = schema.buildMessage({
      source: "x",
      text: "hi",
      project: "p".repeat(500),
      session: "s".repeat(500),
      peer: "u".repeat(500),
    });
    assert.strictEqual(m.project.length, 120);
    assert.strictEqual(m.session.length, 64);
    assert.strictEqual(m.peer.length, 64);
  });

  test("ts must be finite; missing → null", () => {
    const a = schema.buildMessage({ source: "x", text: "hi", ts: 1723766400000 });
    const b = schema.buildMessage({ source: "x", text: "hi" });
    assert.strictEqual(a.ts, 1723766400000);
    assert.strictEqual(b.ts, null);
  });

  test("from_user toggle preserved only when boolean", () => {
    const a = schema.buildMessage({ source: "x", text: "hi", from_user: true });
    const b = schema.buildMessage({ source: "x", text: "hi", from_user: "yes" });
    assert.strictEqual(a.from_user, true);
    assert.ok(!("from_user" in b));
  });
});
