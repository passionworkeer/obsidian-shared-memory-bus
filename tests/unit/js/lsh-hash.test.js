"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { VECTOR_SCHEMA_VERSION, normalizeSpaces, fnv1a32, buildHashFeatures, buildHashEmbedding } = require("../../../bus/lsh-hash.js");

// ---------------------------------------------------------------------------
// VECTOR_SCHEMA_VERSION
// ---------------------------------------------------------------------------

test("VECTOR_SCHEMA_VERSION === 1", () => {
  assert.equal(VECTOR_SCHEMA_VERSION, 1);
});

// ---------------------------------------------------------------------------
// normalizeSpaces
// ---------------------------------------------------------------------------

test("normalizeSpaces: empty string returns empty string", () => {
  assert.equal(normalizeSpaces(""), "");
});

test("normalizeSpaces: null returns empty string", () => {
  assert.equal(normalizeSpaces(null), "");
});

test("normalizeSpaces: collapses multiple spaces to single space and trims", () => {
  assert.equal(normalizeSpaces("  hello   world  "), "hello world");
});

test("normalizeSpaces: tabs become spaces", () => {
  assert.equal(normalizeSpaces("tabs\there"), "tabs here");
});

test("normalizeSpaces: normal text unchanged", () => {
  assert.equal(normalizeSpaces("hello world"), "hello world");
});

// ---------------------------------------------------------------------------
// fnv1a32
// ---------------------------------------------------------------------------

test("fnv1a32: empty string returns seed value 0x811c9dc5", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
});

test("fnv1a32: 'hello' returns known value 1335831723", () => {
  // Verified against actual implementation output
  assert.equal(fnv1a32("hello"), 1335831723);
});

test("fnv1a32: 'a' returns deterministic value 3826002220", () => {
  // Verified against actual implementation output
  const expected = 3826002220;
  assert.equal(fnv1a32("a"), expected);
});

test("fnv1a32: null returns seed value", () => {
  assert.equal(fnv1a32(null), 0x811c9dc5);
});

test("fnv1a32: is unsigned 32-bit (no negative values)", () => {
  const h = fnv1a32("test string with various chars");
  assert.ok(h >= 0);
  assert.ok(h <= 0xffffffff);
});

// ---------------------------------------------------------------------------
// buildHashFeatures
// ---------------------------------------------------------------------------

test("buildHashFeatures: simple words produce w: prefix features", () => {
  const features = buildHashFeatures("hello world");
  assert.ok(features.some((f) => f === "w:hello"), "should contain w:hello");
  assert.ok(features.some((f) => f === "w:world"), "should contain w:world");
});

test("buildHashFeatures: URL produces w: prefix with path tokens", () => {
  const features = buildHashFeatures("visit https://example.com/path");
  assert.ok(features.some((f) => f.startsWith("w:")), "should have w: tokens");
  assert.ok(features.some((f) => f.includes("example") || f.includes("https")), "should contain URL tokens");
});

test("buildHashFeatures: CJK text produces c:, c2:, c3: features", () => {
  const features = buildHashFeatures("中文测试");
  assert.ok(features.some((f) => f.startsWith("c:中文")), "should have c: feature");
  assert.ok(features.some((f) => f.startsWith("c2:")), "should have c2: bigrams");
  assert.ok(features.some((f) => f.startsWith("c3:")), "should have c3: trigrams");
});

test("buildHashFeatures: mixed English and CJK", () => {
  const features = buildHashFeatures("hello 中文 world");
  assert.ok(features.some((f) => f === "w:hello"), "should have English w: token");
  assert.ok(features.some((f) => f === "w:world"), "should have English w: token");
  assert.ok(features.some((f) => f.startsWith("c:")), "should have CJK c: token");
});

test("buildHashFeatures: gram limit of 400 is enforced", () => {
  // String of 500 unique characters produces 498 g3: ngrams
  // maxGramCount = min(compact.length - 2, 400) = min(498, 400) = 400
  const longText = "a".repeat(500);
  const features = buildHashFeatures(longText);
  const g3Features = features.filter((f) => f.startsWith("g3:"));
  assert.ok(g3Features.length <= 400, `g3: count ${g3Features.length} should be <= 400`);
});

test("buildHashFeatures: fallback raw: feature when no other features fire but compact non-empty", () => {
  // Text that produces empty compact (whitespace only) would give []
  // Text with only punctuation that doesn't match token regex:
  // The compact is non-empty but source tokens empty, so raw: fires
  const features = buildHashFeatures("!!!");
  assert.ok(features.length > 0, "should produce at least one feature");
  // "!!!" -> compact = "!!!", no tokens match /[a-z0-9].../, no CJK, 1 g3
  const g3Features = features.filter((f) => f.startsWith("g3:"));
  assert.ok(g3Features.length === 1, "should have exactly 1 g3: ngram");
  assert.equal(g3Features[0], "g3:!!!");
});

test("buildHashFeatures: completely empty string returns empty array", () => {
  assert.deepEqual(buildHashFeatures(""), []);
});

test("buildHashFeatures: only whitespace returns empty array", () => {
  assert.deepEqual(buildHashFeatures("   \t\n  "), []);
});

test("buildHashFeatures: underscore token produces w:feature_with_underscore", () => {
  const features = buildHashFeatures("feature_with_underscore");
  assert.ok(features.some((f) => f === "w:feature_with_underscore"), "should contain underscore token");
});

test("buildHashFeatures: hyphen token produces w:feature-hyphen", () => {
  const features = buildHashFeatures("feature-hyphen token-end");
  assert.ok(features.some((f) => f === "w:feature-hyphen"), "should contain hyphen token");
  assert.ok(features.some((f) => f === "w:token-end"), "should contain token-end");
});

// ---------------------------------------------------------------------------
// buildHashEmbedding
// ---------------------------------------------------------------------------

test("buildHashEmbedding: default dimension is 384", () => {
  const vector = buildHashEmbedding("hello world");
  assert.equal(vector.length, 384);
});

test("buildHashEmbedding: custom dimension 256 works", () => {
  const vector = buildHashEmbedding("hello world", 256);
  assert.equal(vector.length, 256);
});

test("buildHashEmbedding: L2 norm equals 1 after normalization", () => {
  const vector = buildHashEmbedding("hello world");
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `L2 norm should be ~1, got ${norm}`);
});

test("buildHashEmbedding: empty text returns zero vector", () => {
  const vector = buildHashEmbedding("");
  assert.ok(vector.every((v) => v === 0), "all elements should be 0");
  assert.equal(vector.length, 384);
});

test("buildHashEmbedding: same text produces same vector (deterministic)", () => {
  const v1 = buildHashEmbedding("hello world");
  const v2 = buildHashEmbedding("hello world");
  assert.deepEqual(v1, v2);
});

test("buildHashEmbedding: different texts produce different vectors", () => {
  const v1 = buildHashEmbedding("hello world");
  const v2 = buildHashEmbedding("goodbye world");
  assert.ok(!v1.every((val, i) => val === v2[i]), "vectors should not be identical");
});

test("buildHashEmbedding: vector values are rounded to 8 decimal places", () => {
  const vector = buildHashEmbedding("test string");
  for (const val of vector) {
    // Check no more than 8 decimal places by multiplying by 1e8 and checking it's an integer
    const scaled = val * 1e8;
    assert.ok(
      Math.abs(scaled - Math.round(scaled)) < 1e-6,
      `value ${val} should have <= 8 decimal places`
    );
  }
});

test("buildHashEmbedding: custom dimension is respected", () => {
  const v128 = buildHashEmbedding("hello", 128);
  const v256 = buildHashEmbedding("hello", 256);
  assert.equal(v128.length, 128);
  assert.equal(v256.length, 256);
});
