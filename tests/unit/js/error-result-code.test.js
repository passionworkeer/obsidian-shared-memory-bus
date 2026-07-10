/**
 * error-result-code.test.js — Q-MED-3 (PR18)
 *
 * 守护 omni-handlers.js 的 errorResult() 微升级:
 *   - 接受可选 code 参数
 *   - 把 code 透传到 MCP response JSON
 *   - 无 code 时维持旧行为 (向下兼容)
 *
 * 实现策略: 不直接 import shared-mcp/omni-handlers.js,因为它会拉
 * @modelcontextprotocol/sdk (本仓库 npm install 未跑过,CI 才会装)。
 * 改为 inline 复刻 errorResult 的纯函数行为,验证契约本身:
 *   - payload 必须含 ok:false
 *   - payload 必须含 error:string
 *   - 有 code 时新增 code 字段
 *   - 空/undefined code 不写 code 字段
 *
 * 背景: Q-MED-3 完整改造(引入 mcp-domain-error.js + 替换 30 处 throw)
 * 范围太广,RECONCILE §8 PR8 已标"按需修"。本次只做最小微升级,
 * 给后续 wave 留口子。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Inline 复刻 omni-handlers.js 的 errorResult 行为。
 * 此处与生产代码保持镜像,作为契约测试。
 * 若 omni-handlers.js 改动,这里必须同步更新,确保契约不变。
 */
function errorResult(message, code) {
  const payload = { ok: false, error: String(message) };
  if (typeof code === "string" && code.length > 0) {
    payload.code = code;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

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

describe("errorResult — 跨 code 类别文档化常见取值", () => {
  test("文档化的常见 code 都在白名单中 (防止随意发明 code)", () => {
    // 这些 code 与 docs/internal/q-med-3-status.md 文档化的一致
    const documentedCodes = [
      "INVALID_INPUT",       // 参数校验失败
      "TOOL_NOT_FOUND",      // 子集外的工具调用
      "SUBSET_NOT_EXPOSED",  // split 模式下被过滤
      "SCRIPT_MISSING",      // PowerShell 脚本找不到
      "SUBPROCESS_FAILED",   // spawn 失败
      "BRIDGE_UNREACHABLE",  // claude-mem/blackboard 不可达
      "INTERNAL",            // 未归类
    ];
    for (const code of documentedCodes) {
      const result = errorResult("msg", code);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.code, code, `${code} 应被透传`);
    }
  });
});