import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "url";

const _thisTestFile = fileURLToPath(import.meta.url);
const _testDir = path.dirname(_thisTestFile);
const _projectRoot = path.resolve(_testDir, "../../../");

// ---------------------------------------------------------------------------
// normalizeSpaces tests
// ---------------------------------------------------------------------------

// Import the module directly - functions should be exported
const {
  normalizeSpaces,
  buildEmbeddingConfigHash,
  isNoise,
  fallbackId,
  extractFieldTexts,
  buildParentSearchText,
  hashFieldText,
  fieldTextsUnchanged,
} = await import(pathToFileURL(path.join(_projectRoot, "bus", "generate-embeddings.js")));

describe("normalizeSpaces", () => {
  test("normal text: no change", () => {
    assert.strictEqual(normalizeSpaces("hello world"), "hello world");
  });

  test("multiple spaces collapsed to one", () => {
    assert.strictEqual(normalizeSpaces("hello   world"), "hello world");
  });

  test("leading and trailing whitespace trimmed", () => {
    assert.strictEqual(normalizeSpaces("  hello  "), "hello");
  });

  test("tabs and newlines collapsed", () => {
    assert.strictEqual(normalizeSpaces("hello\t\nworld"), "hello world");
  });

  test("null/undefined treated as empty string", () => {
    assert.strictEqual(normalizeSpaces(null), "");
    assert.strictEqual(normalizeSpaces(undefined), "");
  });

  test("numbers coerced to string", () => {
    assert.strictEqual(normalizeSpaces(123), "123");
  });
});

// ---------------------------------------------------------------------------
// buildEmbeddingConfigHash tests
// ---------------------------------------------------------------------------

describe("buildEmbeddingConfigHash", () => {
  test("identical inputs produce identical hash", () => {
    const input = { backend: "openai", modelName: "gpt-4o-mini", baseUrl: "https://api.openai.com" };
    const h1 = buildEmbeddingConfigHash(input);
    const h2 = buildEmbeddingConfigHash(input);
    assert.strictEqual(h1, h2);
  });

  test("different backend produces different hash", () => {
    const h1 = buildEmbeddingConfigHash({ backend: "openai", modelName: "gpt-4o-mini" });
    const h2 = buildEmbeddingConfigHash({ backend: "anthropic", modelName: "gpt-4o-mini" });
    assert.notStrictEqual(h1, h2);
  });

  test("different modelName produces different hash", () => {
    const h1 = buildEmbeddingConfigHash({ backend: "openai", modelName: "gpt-4o-mini" });
    const h2 = buildEmbeddingConfigHash({ backend: "openai", modelName: "gpt-4o" });
    assert.notStrictEqual(h1, h2);
  });

  test("different baseUrl produces different hash (openai-compatible)", () => {
    const h1 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" });
    const h2 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "https://api.anthropic.com" });
    assert.notStrictEqual(h1, h2);
  });

  test("baseUrl trailing slash normalized", () => {
    const h1 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1/" });
    const h2 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" });
    assert.strictEqual(h1, h2);
  });

  test("hash is 16 characters", () => {
    const hash = buildEmbeddingConfigHash({ backend: "hash", modelName: "all-MiniLM-L6-v2" });
    assert.strictEqual(hash.length, 16);
  });

  test("baseUrl case normalized for openai-compatible", () => {
    const h1 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "HTTPS://API.OPENAI.COM" });
    const h2 = buildEmbeddingConfigHash({ backend: "openai-compatible", modelName: "gpt-4o-mini", baseUrl: "https://api.openai.com" });
    assert.strictEqual(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// isNoise tests
// ---------------------------------------------------------------------------

describe("isNoise", () => {
  test("normal text: not noise", () => {
    assert.strictEqual(isNoise("I prefer concise replies"), false);
    assert.strictEqual(isNoise("The project deadline is Friday"), false);
  });

  test("too short: treated as noise", () => {
    assert.strictEqual(isNoise("hi"), true);
    assert.strictEqual(isNoise("ok"), true);
  });

  test("exact 4 chars: treated as noise", () => {
    assert.strictEqual(isNoise("test"), true);
  });

  test("exact 5 chars: not noise (boundary)", () => {
    assert.strictEqual(isNoise("hello"), false);
  });

  test("Sender pattern: noise", () => {
    assert.strictEqual(isNoise("Sender(passionworkeer): Hello"), true);
    assert.strictEqual(isNoise("SENDER (Admin): Message"), true);
  });

  test("System: prefix: noise", () => {
    assert.strictEqual(isNoise("System: Boot complete"), true);
  });

  test("Subagent Context: noise", () => {
    assert.strictEqual(isNoise("[Subagent Context] Starting task"), true);
    assert.strictEqual(isNoise("Subagent Context received"), true);
  });

  test("Exec completed: noise", () => {
    assert.strictEqual(isNoise("Exec completed in 1.2s"), true);
  });

  test("Exec failed: noise", () => {
    assert.strictEqual(isNoise("Exec failed: timeout"), true);
  });

  test("A new session was started: noise", () => {
    assert.strictEqual(isNoise("A new session was started"), true);
  });

  test("Date header [Mon...]: noise", () => {
    assert.strictEqual(isNoise("[Mon Apr 10 2026] Starting..."), true);
    assert.strictEqual(isNoise("[Sun Dec 25 08:00:00] Log entry"), true);
  });

  test("Run your Session Startup: noise", () => {
    assert.strictEqual(isNoise("Run your Session Startup hook"), true);
  });

  test("empty string: noise", () => {
    assert.strictEqual(isNoise(""), true);
  });

  test("whitespace only: noise", () => {
    assert.strictEqual(isNoise("   "), true);
  });

  test("CJK text with length >= 5: not noise", () => {
    assert.strictEqual(isNoise("用户偏好中文回复"), false);
  });

  test("mixed content with sufficient length: not noise", () => {
    assert.strictEqual(isNoise("Sender: I like short replies but this is actually a full sentence"), false);
  });
});

// ---------------------------------------------------------------------------
// fallbackId tests
// ---------------------------------------------------------------------------

describe("fallbackId", () => {
  test("identical inputs produce identical id", () => {
    const entry = { tool: "test", t: "n" };
    const id1 = fallbackId(entry, "title", "content");
    const id2 = fallbackId(entry, "title", "content");
    assert.strictEqual(id1, id2);
  });

  test("different title produces different id", () => {
    const entry = { tool: "test", t: "n" };
    const id1 = fallbackId(entry, "title1", "content");
    const id2 = fallbackId(entry, "title2", "content");
    assert.notStrictEqual(id1, id2);
  });

  test("different content produces different id", () => {
    const entry = { tool: "test", t: "n" };
    const id1 = fallbackId(entry, "title", "content1");
    const id2 = fallbackId(entry, "title", "content2");
    assert.notStrictEqual(id1, id2);
  });

  test("missing entry fields use empty string", () => {
    const id1 = fallbackId({}, "title", "content");
    const id2 = fallbackId({ tool: "" }, "title", "content");
    assert.strictEqual(id1, id2);
  });

  test("id is 16 characters", () => {
    const id = fallbackId({ tool: "test" }, "title", "content");
    assert.strictEqual(id.length, 16);
  });
});

// ---------------------------------------------------------------------------
// extractFieldTexts tests
// ---------------------------------------------------------------------------

describe("extractFieldTexts", () => {
  test("basic entry: title and content extracted", () => {
    const result = extractFieldTexts({ title: "  My  Title  ", content: "  Hello  World  " });
    assert.strictEqual(result.title, "My Title");
    assert.strictEqual(result.content, "Hello World");
    assert.deepStrictEqual(result.facts, []);
    assert.deepStrictEqual(result.concepts, []);
  });

  test("string facts: extracted as array", () => {
    const result = extractFieldTexts({
      title: "Test",
      content: "Content",
      facts: ["fact one", "fact two"],
    });
    assert.deepStrictEqual(result.facts, ["fact one", "fact two"]);
  });

  test("object facts with value arrays: flattened", () => {
    const result = extractFieldTexts({
      title: "Test",
      facts: [{ value: ["f1", "f2"] }, "f3"],
    });
    assert.deepStrictEqual(result.facts, ["f1", "f2", "f3"]);
  });

  test("empty strings in facts: filtered out", () => {
    const result = extractFieldTexts({
      title: "Test",
      facts: ["valid fact", "", "   ", "another"],
    });
    assert.deepStrictEqual(result.facts, ["valid fact", "another"]);
  });

  test("string concepts: extracted as array", () => {
    const result = extractFieldTexts({
      title: "Test",
      concepts: ["concept one", "concept two"],
    });
    assert.deepStrictEqual(result.concepts, ["concept one", "concept two"]);
  });

  test("object concepts with value arrays: flattened", () => {
    const result = extractFieldTexts({
      title: "Test",
      concepts: [{ value: ["c1", "c2"] }, "c3"],
    });
    assert.deepStrictEqual(result.concepts, ["c1", "c2", "c3"]);
  });

  test("missing fields: empty arrays / strings", () => {
    const result = extractFieldTexts({});
    assert.strictEqual(result.title, "");
    assert.strictEqual(result.content, "");
    assert.deepStrictEqual(result.facts, []);
    assert.deepStrictEqual(result.concepts, []);
  });

  test("null/undefined fields handled gracefully", () => {
    const result = extractFieldTexts({ title: null, content: undefined, facts: null });
    assert.strictEqual(result.title, "");
    assert.strictEqual(result.content, "");
    assert.deepStrictEqual(result.facts, []);
  });
});

// ---------------------------------------------------------------------------
// buildParentSearchText tests
// ---------------------------------------------------------------------------

describe("buildParentSearchText", () => {
  test("all fields joined with spaces", () => {
    const result = buildParentSearchText({
      title: "Meeting Notes",
      content: "Sprint planning",
      agent: "claude",
      project: "backend",
      type: "n",
      tool: "memory-wake-up",
    });
    assert.ok(result.includes("Meeting Notes"));
    assert.ok(result.includes("Sprint planning"));
    assert.ok(result.includes("claude"));
    assert.ok(result.includes("backend"));
  });

  test("missing fields: ignored", () => {
    const result = buildParentSearchText({ title: "Only Title" });
    assert.strictEqual(result, "Only Title");
  });

  test("whitespace normalized", () => {
    const result = buildParentSearchText({ title: "  Title  ", content: "  Content  " });
    assert.strictEqual(result.includes("  "), false);
  });

  test("truncated to 6000 chars", () => {
    const longText = "x".repeat(7000);
    const result = buildParentSearchText({ title: longText });
    assert.ok(result.length <= 6000);
  });
});

// ---------------------------------------------------------------------------
// hashFieldText tests
// ---------------------------------------------------------------------------

describe("hashFieldText", () => {
  test("identical text produces identical hash", () => {
    const h1 = hashFieldText("hello world");
    const h2 = hashFieldText("hello world");
    assert.strictEqual(h1, h2);
  });

  test("different text produces different hash", () => {
    const h1 = hashFieldText("hello");
    const h2 = hashFieldText("world");
    assert.notStrictEqual(h1, h2);
  });

  test("empty string produces a hash", () => {
    const h = hashFieldText("");
    assert.strictEqual(h.length, 64); // SHA-256 hex = 64 chars
  });

  test("hash is SHA-256 format (64 hex chars)", () => {
    const h = hashFieldText("test content");
    assert.ok(/^[a-f0-9]{64}$/.test(h), `Expected 64-char hex, got: ${h}`);
  });
});

// ---------------------------------------------------------------------------
// fieldTextsUnchanged tests
// ---------------------------------------------------------------------------

describe("fieldTextsUnchanged", () => {
  test("all fields match: returns true", () => {
    const existingEntry = {
      fieldTexts: {
        title: "abc",
        content: "def",
      },
    };
    const newHashes = {
      title: "abc",
      content: "def",
    };
    assert.strictEqual(fieldTextsUnchanged(newHashes, existingEntry), true);
  });

  test("one field differs: returns false", () => {
    const existingEntry = {
      fieldTexts: {
        title: "abc",
        content: "def",
      },
    };
    const newHashes = {
      title: "abc",
      content: "CHANGED",
    };
    assert.strictEqual(fieldTextsUnchanged(newHashes, existingEntry), false);
  });

  test("new field added: returns false", () => {
    const existingEntry = {
      fieldTexts: {
        title: "abc",
      },
    };
    const newHashes = {
      title: "abc",
      content: "def",
    };
    assert.strictEqual(fieldTextsUnchanged(newHashes, existingEntry), false);
  });

  test("no fieldTexts: returns false", () => {
    const existingEntry = {};
    const newHashes = { title: "abc" };
    assert.strictEqual(fieldTextsUnchanged(newHashes, existingEntry), false);
  });

  test("null entry: returns false", () => {
    assert.strictEqual(fieldTextsUnchanged({}, null), false);
  });
});
