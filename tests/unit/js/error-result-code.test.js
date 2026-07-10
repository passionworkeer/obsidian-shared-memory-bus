/**
 * error-result-code.test.js — Q-MED-3 (PR18)
 *
 * 守护 omni-handlers.js 的 errorResult() 微升级:
 *   - 接受可选 code 参数
 *   - 把 code 透传到 MCP response JSON
 *   - 无 code 时维持旧行为 (向下兼容)
 *
 * 背景: Q-MED-3 完整改造(引入 mcp-domain-error.js + 替换 30 处 throw)
 * 范围太广,RECONCILE §8 PR8 已标"按需修"。本次只做最小微升级,
 * 给后续 wave 留口子。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { errorResult } from "../../../shared-mcp/omni-handlers.js";

describe("errorResult — 向后兼容 (无 code)", () => {
  test("单 message 参数返回原 ok:false/error:string 形态", () => {
    const result = errorResult("something broke");
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "something broke");
    // 不应有 code 字段(避免破坏现有 client 解析)
    assert.ok(!("code" in payload));
  });
});

describe("errorResult — code 透传", () => {
  test("传 code 时把 code 加到 JSON payload", () => {
    const result = errorResult("bridge unreachable", "BRIDGE_UNREACHABLE");
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "bridge unreachable");
    assert.equal(payload.code, "BRIDGE_UNREACHABLE");
  });

  test("不同 code 值原样透传 (UPPER_SNAKE_CASE)", () => {
    const codes = ["INVALID_INPUT", "TOOL_NOT_FOUND", "SCRIPT_MISSING", "INTERNAL"];
    for (const code of codes) {
      const result = errorResult("msg", code);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.code, code);
    }
  });

  test("undefined code 等价于无 code (维持旧行为)", () => {
    const result = errorResult("msg", undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.ok(!("code" in payload));
  });

  test("null code 也应忽略 (不写入 payload.code)", () => {
    const result = errorResult("msg", null);
    const payload = JSON.parse(result.content[0].text);
    assert.ok(!("code" in payload));
  });

  test("空字符串 code 视为无 code (避免空字符串污染)", () => {
    const result = errorResult("msg", "");
    const payload = JSON.parse(result.content[0].text);
    assert.ok(!("code" in payload), "空字符串 code 不应写入 payload");
  });
});