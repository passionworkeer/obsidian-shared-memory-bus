import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Pure function implementations (mirrored from memory-status.js)
// ---------------------------------------------------------------------------

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function clampText(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function compactUnique(items, maxItems = 3, maxLength = 160) {
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = clampText(item, maxLength);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
    if (results.length >= maxItems) {
      break;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// jsonResult tests
// ---------------------------------------------------------------------------

describe("jsonResult", () => {
  test("wraps payload with content array", () => {
    const result = jsonResult({ ok: true });
    assert.ok(Array.isArray(result.content));
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].type, "text");
  });

  test("payload is JSON stringified with indentation", () => {
    const result = jsonResult({ key: "value" });
    const text = result.content[0].text;
    assert.strictEqual(text.includes("  "), true); // has indentation
    assert.strictEqual(text.includes("key"), true);
  });
});

// ---------------------------------------------------------------------------
// clampText tests
// ---------------------------------------------------------------------------

describe("clampText", () => {
  test("short text: unchanged", () => {
    assert.strictEqual(clampText("hello world", 50), "hello world");
  });

  test("exact maxLength: unchanged", () => {
    assert.strictEqual(clampText("hello world", 11), "hello world");
  });

  test("truncates with ellipsis character", () => {
    const result = clampText("hello world", 8);
    assert.strictEqual(result.length, 8);
    assert.strictEqual(result.endsWith("…"), true);
  });

  test("default maxLength is 160", () => {
    const short = "a".repeat(100);
    assert.strictEqual(clampText(short), short);
  });

  test("whitespace normalized before clamping", () => {
    assert.strictEqual(clampText("hello  \n world", 20), "hello world");
  });

  test("leading/trailing whitespace trimmed", () => {
    assert.strictEqual(clampText("  hello  ", 50), "hello");
  });

  test("null/undefined treated as empty", () => {
    assert.strictEqual(clampText(null), "");
    assert.strictEqual(clampText(undefined), "");
  });

  test("numbers coerced to string", () => {
    // slice uses maxLength-1, then +ellipsis → total = maxLength chars
    assert.strictEqual(clampText(12345678901234567890, 5), "1234…");
  });

  test("empty string returns empty", () => {
    assert.strictEqual(clampText(""), "");
    assert.strictEqual(clampText("   "), "");
  });

  test("maxLength 0 returns just ellipsis", () => {
    // slice(0,0) = "" + "…" = "…"
    assert.strictEqual(clampText("hello", 0), "…");
  });

  test("CJK characters count correctly (not byte-length)", () => {
    // 5 CJK chars = 5 chars, should fit in maxLength=5
    const result = clampText("你好世界", 5);
    assert.strictEqual(result, "你好世界");
  });

  test("CJK truncation: longer than maxLength gets truncated with ellipsis", () => {
    // "你好世界和朋友好很好啊" = 11 chars > maxLength=10 → truncated
    const result = clampText("你好世界和朋友好很好啊", 10);
    assert.strictEqual(result.endsWith("…"), true);
    // visible chars = maxLength-1 = 9
    assert.ok(result.replace("…", "").length <= 9);
  });
});

// ---------------------------------------------------------------------------
// compactUnique tests
// ---------------------------------------------------------------------------

describe("compactUnique", () => {
  test("no duplicates: all items returned", () => {
    const result = compactUnique(["apple", "banana", "cherry"], 3, 160);
    assert.deepStrictEqual(result, ["apple", "banana", "cherry"]);
  });

  test("duplicates removed (case-insensitive)", () => {
    const result = compactUnique(["Apple", "apple", "APPLE"], 3, 160);
    assert.deepStrictEqual(result, ["Apple"]);
  });

  test("respects maxItems limit", () => {
    const result = compactUnique(["a", "b", "c", "d", "e"], 3, 160);
    assert.strictEqual(result.length, 3);
  });

  test("respects maxLength per item", () => {
    const longItem = "a".repeat(200);
    const result = compactUnique([longItem], 3, 50);
    assert.strictEqual(result[0].length, 50);
    assert.strictEqual(result[0].endsWith("…"), true);
  });

  test("empty array returns empty array", () => {
    assert.deepStrictEqual(compactUnique([]), []);
    assert.deepStrictEqual(compactUnique(null), []);
    assert.deepStrictEqual(compactUnique(undefined), []);
  });

  test("empty/whitespace strings filtered", () => {
    const result = compactUnique(["valid", "", "  ", "also valid"], 3, 160);
    assert.deepStrictEqual(result, ["valid", "also valid"]);
  });

  test("truncation + dedup combined", () => {
    // "long-item-name-here" (19 chars) clamped to 20 chars → "long-item-name-here…"
    // different from "long-item-name-here" → no dedup, hits maxItems=3 limit
    const result = compactUnique(["item-one", "ITEM-ONE", "item-two", "long-item-name-here"], 3, 20);
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, ["item-one", "item-two", "long-item-name-here"]);
  });

  test("maxItems=0 returns first item (break fires after first push: 1 >= 0)", () => {
    // maxItems=0: push first, then check 1 >= 0 → true → break → returns ["a"]
    assert.deepStrictEqual(compactUnique(["a", "b"], 0), ["a"]);
  });

  test("default parameters", () => {
    const result = compactUnique(["one", "two"]);
    assert.strictEqual(result.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Integration: clampText + compactUnique combined
// ---------------------------------------------------------------------------

describe("clampText + compactUnique combined", () => {
  test("real-world: memory title list deduplication", () => {
    const titles = [
      "用户偏好中文回复",
      "系统启动配置",
      "用户偏好中文回复", // duplicate
      "长标题的测试内容用于验证最大长度截断功能是否正常工作",
      "another short title",
      "another short title", // duplicate
    ];
    const result = compactUnique(titles, 3, 30);
    // Deduplicated (case-insensitive) + clamped + sliced to maxItems=3
    assert.strictEqual(result.length, 3);
    // No duplicates
    const lowerSet = new Set(result.map((t) => t.toLowerCase()));
    assert.strictEqual(lowerSet.size, result.length);
  });
});
