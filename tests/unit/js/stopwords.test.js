import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STOPWORDS,
  ENGLISH_STOPWORDS,
  PROGRAMMING_STOPWORDS,
  PROSE_STOPWORDS,
  CHINESE_STOPWORDS,
} from "../../../ops/entity/stopwords/index.js";

describe("entity-extractor/stopwords", () => {
  test("STOPWORDS is a non-empty Set", () => {
    assert.ok(STOPWORDS instanceof Set);
    assert.ok(STOPWORDS.size > 100, "expected > 100 stopwords");
  });

  test("per-category arrays are non-empty", () => {
    assert.ok(ENGLISH_STOPWORDS.length > 0);
    assert.ok(PROGRAMMING_STOPWORDS.length > 0);
    assert.ok(PROSE_STOPWORDS.length > 0);
    assert.ok(CHINESE_STOPWORDS.length > 0);
  });

  test("STOPWORDS contains common English articles and pronouns", () => {
    for (const w of ["the", "a", "an", "and", "or", "but", "i", "you", "we", "they"]) {
      assert.ok(STOPWORDS.has(w), `STOPWORDS should contain "${w}"`);
    }
  });

  test("STOPWORDS contains common programming keywords", () => {
    for (const w of ["return", "function", "const", "let", "var", "class", "import"]) {
      assert.ok(STOPWORDS.has(w), `STOPWORDS should contain "${w}"`);
    }
  });

  test("STOPWORDS contains common Chinese function words", () => {
    for (const w of ["的", "是", "在", "有", "我", "你", "他"]) {
      assert.ok(STOPWORDS.has(w), `STOPWORDS should contain Chinese "${w}"`);
    }
  });

  test("STOPWORDS contains common prose filler", () => {
    for (const w of ["step", "usage", "example", "result", "error"]) {
      assert.ok(STOPWORDS.has(w), `STOPWORDS should contain "${w}"`);
    }
  });

  test("no duplicates within STOPWORDS (Set dedups automatically)", () => {
    // Re-flatten the per-category arrays and check union size matches
    const union = new Set([
      ...ENGLISH_STOPWORDS,
      ...PROGRAMMING_STOPWORDS,
      ...PROSE_STOPWORDS,
      ...CHINESE_STOPWORDS,
    ]);
    assert.equal(STOPWORDS.size, union.size, "STOPWORDS Set size must match union of category arrays");
  });

  test("all entries are lowercase strings (no casing variants)", () => {
    for (const w of STOPWORDS) {
      assert.equal(typeof w, "string");
      // "type" etc. are already lowercase by construction
      assert.equal(w, w.toLowerCase(), `STOPWORDS entry must be lowercase: "${w}"`);
    }
  });

  test("STOPWORDS does not contain common entities (should not over-filter)", () => {
    // Sanity: the words below are legitimate entity candidates and
    // must NOT be in the stopword set, or entity extraction will be useless.
    const notStopwords = ["alice", "bob", "postgres", "kubernetes", "openai", "typescript"];
    for (const w of notStopwords) {
      assert.ok(!STOPWORDS.has(w), `STOPWORDS must not contain "${w}"`);
    }
  });
});
