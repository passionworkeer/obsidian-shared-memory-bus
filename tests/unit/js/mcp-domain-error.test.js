/**
 * Tests for shared-mcp/mcp-domain-error.js (Q-MED-3 incremental adoption).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpErrorResult, DomainError, MCP_CODES, COMMON_CODES } from "../../../shared-mcp/mcp-domain-error.js";

test("mcpErrorResult: DomainError → uses .code and .message", () => {
  const err = new DomainError(MCP_CODES.BRIDGE_UNREACHABLE, "bridge-down");
  const result = mcpErrorResult(err);
  assert.deepEqual(result, { ok: false, error: "bridge-down", code: "BRIDGE_UNREACHABLE" });
});

test("mcpErrorResult: plain Error → INTERNAL code, error.message", () => {
  const err = new Error("boom");
  const result = mcpErrorResult(err);
  assert.deepEqual(result, { ok: false, error: "boom", code: "INTERNAL" });
});

test("mcpErrorResult: string → INTERNAL, no change to message", () => {
  const result = mcpErrorResult("just a string");
  assert.deepEqual(result, { ok: false, error: "just a string", code: "INTERNAL" });
});

test("mcpErrorResult: undefined → INTERNAL, uses fallback", () => {
  const result = mcpErrorResult(undefined, "fallback-msg");
  assert.deepEqual(result, { ok: false, error: "fallback-msg", code: "INTERNAL" });
});

test("MCP_CODES includes expected MCP-specific codes", () => {
  assert.equal(MCP_CODES.BRIDGE_UNREACHABLE, "BRIDGE_UNREACHABLE");
  assert.equal(MCP_CODES.SUBSET_NOT_EXPOSED, "SUBSET_NOT_EXPOSED");
  assert.equal(MCP_CODES.TOOL_NOT_FOUND, "TOOL_NOT_FOUND");
  // Subset of COMMON_CODES re-exported
  assert.equal(MCP_CODES.INVALID_INPUT, COMMON_CODES.INVALID_INPUT);
  assert.equal(MCP_CODES.INTERNAL, COMMON_CODES.INTERNAL);
});

test("mcpErrorResult re-export: DomainError is the same class as bus/domain-error", async () => {
  const { DomainError: BusDomainError } = await import("../../../bus/domain-error.js");
  assert.equal(DomainError, BusDomainError, "should re-export same class");
});
