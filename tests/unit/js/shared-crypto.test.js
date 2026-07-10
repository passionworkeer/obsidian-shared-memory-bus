/**
 * tests/unit/js/shared-crypto.test.js
 * =====================================
 * Unit tests for bus/shared-crypto.js — config-hash and adapter
 * normalization helpers. All functions are pure (no I/O).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmbeddingConfigHash,
  normalizeString,
  normalizeEmbeddingAdapter,
} from "../../../bus/shared-crypto.js";

describe("shared-crypto — normalizeString", () => {
  test("trims whitespace", () => {
    assert.equal(normalizeString("  hello  "), "hello");
  });
  test("coerces null/undefined to empty", () => {
    assert.equal(normalizeString(null), "");
    assert.equal(normalizeString(undefined), "");
  });
  test("stringifies numbers (does not reject them)", () => {
    // 42 is truthy → stringified; 0 is falsy → "" (0 || "" is "")
    assert.equal(normalizeString(42), "42");
    assert.equal(normalizeString(0), "");
  });
  test("returns empty for empty input", () => {
    assert.equal(normalizeString(""), "");
  });
});

describe("shared-crypto — normalizeEmbeddingAdapter", () => {
  test("lowercases input", () => {
    assert.equal(normalizeEmbeddingAdapter("HASH"), "hash");
    assert.equal(normalizeEmbeddingAdapter("OpenAI"), "openai-compatible");
  });

  test("'openai' alias maps to 'openai-compatible'", () => {
    assert.equal(normalizeEmbeddingAdapter("openai"), "openai-compatible");
  });

  test("'hashing' alias maps to 'hash'", () => {
    assert.equal(normalizeEmbeddingAdapter("hashing"), "hash");
  });

  test("sentence-transformer aliases map to 'transformer'", () => {
    assert.equal(normalizeEmbeddingAdapter("sentence-transformer"), "transformer");
    assert.equal(normalizeEmbeddingAdapter("sentence-transformers"), "transformer");
  });

  test("unknown names pass through lowercase", () => {
    assert.equal(normalizeEmbeddingAdapter("custom-backend"), "custom-backend");
  });

  test("falls back to provided fallback when empty", () => {
    // The fallback is lowercased but NOT remapped through the alias table.
    // Callers that want the alias mapping must pass an already-mapped
    // fallback (e.g. "openai-compatible" rather than "openai").
    assert.equal(normalizeEmbeddingAdapter("", "hash"), "hash");
    assert.equal(normalizeEmbeddingAdapter(null, "openai"), "openai");
  });
});

describe("shared-crypto — buildEmbeddingConfigHash", () => {
  test("returns 16 hex characters", () => {
    const hash = buildEmbeddingConfigHash({ backend: "hash", modelName: "hashing-v1" });
    assert.equal(hash.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(hash));
  });

  test("is deterministic for the same inputs", () => {
    const a = buildEmbeddingConfigHash({ backend: "hash", modelName: "hashing-v1" });
    const b = buildEmbeddingConfigHash({ backend: "hash", modelName: "hashing-v1" });
    assert.equal(a, b);
  });

  test("different backends produce different hashes", () => {
    const a = buildEmbeddingConfigHash({ backend: "hash", modelName: "m1" });
    const b = buildEmbeddingConfigHash({ backend: "openai", modelName: "m1" });
    assert.notEqual(a, b);
  });

  test("different models produce different hashes", () => {
    const a = buildEmbeddingConfigHash({ backend: "openai", modelName: "text-embedding-3-small" });
    const b = buildEmbeddingConfigHash({ backend: "openai", modelName: "text-embedding-3-large" });
    assert.notEqual(a, b);
  });

  test("strips trailing slashes from baseUrl for openai-compatible", () => {
    const a = buildEmbeddingConfigHash({
      backend: "openai-compatible",
      modelName: "m1",
      baseUrl: "https://api.example.com/v1/",
    });
    const b = buildEmbeddingConfigHash({
      backend: "openai-compatible",
      modelName: "m1",
      baseUrl: "https://api.example.com/v1",
    });
    assert.equal(a, b);
  });

  test("ignores baseUrl for non-openai backends", () => {
    const a = buildEmbeddingConfigHash({
      backend: "hash",
      modelName: "m1",
      baseUrl: "https://different.com",
    });
    const b = buildEmbeddingConfigHash({
      backend: "hash",
      modelName: "m1",
      baseUrl: "https://other.com",
    });
    assert.equal(a, b);
  });

  // Q-HIGH-6: cross-language parity (pinned JS reference, matches Python output).
  //
  // background: Python counterpart at retrieval/embedding_providers.py:47-59
  // uses json.dumps(..., ensure_ascii=False, separators=(",", ":")). JS uses
  // JSON.stringify defaults. Keys are in identical order in both implementations
  // ({"backend": ..., "model": ..., "baseUrl": ...}, no whitespace), so for
  // ASCII-only model/baseUrl strings both serializations produce identical
  // bytes — hence identical SHA-1 hashes. Pinned 2026-07-10 against the Python
  // binary in repo, see retrieval/embedding_providers.py:47 for the source.
  //
  // If you change either serialization, run a Python verification first
  // (rebuild_expected_hash.py helper) and update these constants together.
  test("parity pinned value: hash backend hashing-v1 (Q-HIGH-6)", () => {
    assert.equal(
      buildEmbeddingConfigHash({ backend: "hash", modelName: "hashing-v1" }),
      "e9e06904388700cb",
    );
  });
  test("parity pinned value: openai-compatible text-embedding-3-small (Q-HIGH-6)", () => {
    assert.equal(
      buildEmbeddingConfigHash({
        backend: "openai-compatible",
        modelName: "text-embedding-3-small",
        baseUrl: "https://api.example.com/v1",
      }),
      "fe398c9c8d4bc7ba",
    );
  });
  test("parity pinned value: transformer all-MiniLM-L6-v2 (Q-HIGH-6)", () => {
    assert.equal(
      buildEmbeddingConfigHash({
        backend: "transformer",
        modelName: "all-MiniLM-L6-v2",
      }),
      "c47b2ee4718c14c7",
    );
  });
});
