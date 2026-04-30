import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Pure function implementations (mirrored from memory-bridge.js)
// ---------------------------------------------------------------------------

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function jsonErrorResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
  };
}

function truncateText(value, maxLength = 400) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = value == null ? "" : String(value).trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function describeClaudeMemFailure({ route, envelope }) {
  const summary = {
    route,
    status: envelope.status,
    statusText: envelope.statusText,
    contentType: envelope.contentType,
  };
  if (envelope.json !== null) {
    summary.response = envelope.json;
  } else if (envelope.text) {
    summary.responseText = truncateText(envelope.text);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// jsonResult tests
// ---------------------------------------------------------------------------

describe("jsonResult", () => {
  test("wraps payload with content array", () => {
    const result = jsonResult({ ok: true, count: 5 });
    assert.ok(Array.isArray(result.content));
    assert.strictEqual(result.content.length, 1);
  });

  test("content type is text", () => {
    const result = jsonResult({ key: "value" });
    assert.strictEqual(result.content[0].type, "text");
  });

  test("isError is absent (success)", () => {
    const result = jsonResult({ ok: true });
    assert.strictEqual(result.isError, undefined);
  });

  test("payload is indented JSON", () => {
    const result = jsonResult({ nested: { deep: true } });
    assert.ok(result.content[0].text.includes("  "));
  });
});

// ---------------------------------------------------------------------------
// jsonErrorResult tests
// ---------------------------------------------------------------------------

describe("jsonErrorResult", () => {
  test("isError is true", () => {
    const result = jsonErrorResult({ ok: false });
    assert.strictEqual(result.isError, true);
  });

  test("wraps error payload", () => {
    const result = jsonErrorResult({ ok: false, error: "not found" });
    assert.strictEqual(result.content[0].text.includes("not found"), true);
  });
});

// ---------------------------------------------------------------------------
// errorResult tests
// ---------------------------------------------------------------------------

describe("errorResult", () => {
  test("wraps string message into ok=false error envelope", () => {
    const result = errorResult("something went wrong");
    assert.strictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.error, "something went wrong");
  });

  test("coerces non-string to string", () => {
    const result = errorResult(404);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.error, "404");
  });

  test("Error objects stringified correctly", () => {
    // String(new Error("test error")) = "Error: test error" (includes "Error:" prefix)
    const err = new Error("test error");
    const result = errorResult(err);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.error, "Error: test error");
  });
});

// ---------------------------------------------------------------------------
// truncateText tests
// ---------------------------------------------------------------------------

describe("truncateText", () => {
  test("short text: unchanged", () => {
    assert.strictEqual(truncateText("hello", 400), "hello");
  });

  test("exact maxLength: unchanged", () => {
    assert.strictEqual(truncateText("hello", 5), "hello");
  });

  test("truncates with ... suffix", () => {
    const result = truncateText("hello world", 8);
    assert.strictEqual(result, "hello wo...");
    assert.strictEqual(result.length, 11); // 8 + 3
  });

  test("default maxLength is 400", () => {
    const short = "a".repeat(300);
    assert.strictEqual(truncateText(short), short);
  });

  test("longer than default: truncated with ...", () => {
    const long = "x".repeat(500);
    const result = truncateText(long);
    assert.strictEqual(result.endsWith("..."), true);
    assert.strictEqual(result.length, 403); // 400 + 3
  });

  test("null/undefined treated as empty string", () => {
    assert.strictEqual(truncateText(null, 50), "");
    assert.strictEqual(truncateText(undefined, 50), "");
  });

  test("numbers coerced to string", () => {
    const result = truncateText(12345678901234567890, 10);
    assert.strictEqual(result, "1234567890...");
  });

  test("maxLength smaller than content: truncates", () => {
    assert.strictEqual(truncateText("hello world", 4), "hell...");
  });

  test("CJK characters count correctly", () => {
    // 10 CJK chars > maxLength=5
    const result = truncateText("你好世界和朋友", 5);
    assert.strictEqual(result.endsWith("..."), true);
  });
});

// ---------------------------------------------------------------------------
// firstNonEmpty tests
// ---------------------------------------------------------------------------

describe("firstNonEmpty", () => {
  test("returns first non-empty trimmed value", () => {
    assert.strictEqual(firstNonEmpty(["", "  ", "found"]), "found");
  });

  test("stops at first non-empty", () => {
    assert.strictEqual(firstNonEmpty(["a", "b", "c"]), "a");
  });

  test("whitespace-only strings ignored", () => {
    assert.strictEqual(firstNonEmpty(["  ", "\t", "valid"]), "valid");
  });

  test("all empty: returns empty string", () => {
    assert.strictEqual(firstNonEmpty(["", null, undefined, "  "]), "");
  });

  test("all empty values: returns empty string", () => {
    assert.strictEqual(firstNonEmpty([]), "");
    assert.strictEqual(firstNonEmpty([null]), "");
    assert.strictEqual(firstNonEmpty([undefined]), "");
  });

  test("null in array: skipped", () => {
    assert.strictEqual(firstNonEmpty([null, "found"]), "found");
  });

  test("0 and false are NOT empty (truthy)", () => {
    assert.strictEqual(firstNonEmpty([0, "second"]), "0");
    assert.strictEqual(firstNonEmpty([false, "second"]), "false");
  });

  test("empty string: treated as empty", () => {
    assert.strictEqual(firstNonEmpty(["", "found"]), "found");
  });
});

// ---------------------------------------------------------------------------
// describeClaudeMemFailure tests
// ---------------------------------------------------------------------------

describe("describeClaudeMemFailure", () => {
  const baseEnvelope = {
    status: 404,
    statusText: "Not Found",
    contentType: "application/json",
    json: null,
    text: "Route not found",
  };

  test("extracts status fields", () => {
    const result = describeClaudeMemFailure({ route: "/api/test", envelope: baseEnvelope });
    assert.strictEqual(result.route, "/api/test");
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.statusText, "Not Found");
    assert.strictEqual(result.contentType, "application/json");
  });

  test("with JSON response: sets response field", () => {
    const envelope = {
      ...baseEnvelope,
      json: { error: "not found", code: 404 },
    };
    const result = describeClaudeMemFailure({ route: "/api/test", envelope });
    assert.deepStrictEqual(result.response, { error: "not found", code: 404 });
    assert.strictEqual(result.responseText, undefined);
  });

  test("without JSON: truncates text and sets responseText", () => {
    const result = describeClaudeMemFailure({ route: "/api/test", envelope: baseEnvelope });
    assert.strictEqual(result.responseText, "Route not found");
    assert.strictEqual(result.response, undefined);
  });

  test("text longer than 400 chars: truncated with ...", () => {
    const envelope = {
      ...baseEnvelope,
      json: null,
      text: "x".repeat(500),
    };
    const result = describeClaudeMemFailure({ route: "/api/test", envelope });
    assert.strictEqual(result.responseText.endsWith("..."), true);
    assert.strictEqual(result.responseText.length, 403);
  });
});
