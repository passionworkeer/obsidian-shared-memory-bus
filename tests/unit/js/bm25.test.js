/**
 * tests/unit/js/bm25.test.js
 * ===========================
 * Unit tests for bus/bm25.js — pure JS BM25 search.
 * Covers tokenize (Latin + CJK + mixed) and search (ranking, topK, empty).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenize, search } from "../../../bus/bm25.js";

describe("bm25 — tokenize", () => {
  test("returns empty array for falsy input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });

  test("lowercases Latin words and filters length < 2", () => {
    const out = tokenize("Hello World a I");
    assert.ok(out.includes("hello"));
    assert.ok(out.includes("world"));
    // single-char tokens are dropped
    assert.ok(!out.includes("a"));
    assert.ok(!out.includes("i"));
  });

  test("emits CJK unigrams and bigrams", () => {
    const out = tokenize("用户偏好");
    assert.ok(out.includes("用"));
    assert.ok(out.includes("户"));
    assert.ok(out.includes("偏好"));
    // bigrams overlap; "用户" should appear as a bigram
    assert.ok(out.includes("用户"));
  });

  test("handles mixed CJK + Latin", () => {
    const out = tokenize("MemPalace中文 优先");
    assert.ok(out.includes("mempalace"));
    // CJK chars preserved separately
    assert.ok(out.includes("中"));
    assert.ok(out.includes("文"));
  });

  test("strips punctuation as a separator", () => {
    const out = tokenize("hello, world; foo.bar");
    assert.ok(out.includes("hello"));
    assert.ok(out.includes("world"));
    assert.ok(out.includes("foo"));
    assert.ok(out.includes("bar"));
  });
});

describe("bm25 — search", () => {
  const docs = [
    { id: "d1", text: "The quick brown fox jumps over the lazy dog" },
    { id: "d2", text: "A fox and a dog became friends" },
    { id: "d3", text: "Nothing to see here, completely unrelated content" },
    { id: "d4", text: "用户偏好中文回复 简洁 直接" },
    { id: "d5", text: "中文用户应当使用中文进行交流" },
  ];

  test("returns empty for empty docs or empty query", () => {
    assert.deepEqual(search([], "anything"), []);
    assert.deepEqual(search(docs, ""), []);
    assert.deepEqual(search(docs, null), []);
  });

  test("ranks doc with query terms highest", () => {
    const out = search(docs, "fox dog", { topK: 3 });
    assert.ok(out.length >= 2);
    // d1 has both "fox" AND "dog"; should be in the top 1-2.
    const topIds = out.slice(0, 2).map((r) => r.id);
    assert.ok(topIds.includes("d1"), `expected d1 in top 2, got ${topIds.join(",")}`);
    assert.ok(out[0].score > 0);
  });

  test("d3 (no matching terms) is excluded", () => {
    const out = search(docs, "fox dog", { topK: 10 });
    const ids = out.map((r) => r.id);
    assert.ok(!ids.includes("d3"));
  });

  test("CJK query matches CJK docs", () => {
    const out = search(docs, "用户偏好", { topK: 5 });
    assert.ok(out.length >= 1);
    const ids = out.map((r) => r.id);
    assert.ok(ids.includes("d4"));
  });

  test("topK limits result count", () => {
    // "the" appears in d1 (twice). With 5 docs and the query "the",
    // the IDF pulls d1 to the top but d2/d3/d4/d5 don't contain "the"
    // (case-folded). Verify topK is honored.
    const out = search(docs, "the", { topK: 2 });
    assert.ok(out.length <= 2);
  });

  test("results are sorted by score descending", () => {
    const out = search(docs, "fox dog", { topK: 10 });
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score);
    }
  });

  test("all scores are positive", () => {
    const out = search(docs, "fox", { topK: 10 });
    for (const r of out) {
      assert.ok(r.score > 0, `expected positive score, got ${r.score}`);
    }
  });
});
