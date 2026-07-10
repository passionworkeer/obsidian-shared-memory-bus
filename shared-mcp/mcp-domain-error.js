/**
 * shared-mcp/mcp-domain-error.js — MCP error envelope (Q-MED-3).
 *
 * Thin wrapper that adapts `bus/domain-error.js` to the MCP wire shape
 * `{ ok: false, error: string, code?: string }` (with optional stable code).
 *
 * Why this exists:
 *   The MCP server's tool results use `errorResult(message, code?)` to
 *   return errors. The `code` is a stable machine-readable identifier
 *   clients can branch on (e.g. BRIDGE_UNREACHABLE → reconnect logic).
 *
 *   `bus/domain-error.js` is the canonical error envelope for the
 *   embedding-provider subsystem. This module lets MCP handlers:
 *     1. Throw `DomainError` from anywhere
 *     2. Have it caught at the MCP boundary
 *     3. Get translated to the MCP `{ ok: false, error, code }` wire shape
 *
 * Q-MED-3 status (2026-07-10): full migration of ~30 throw sites is
 * tracked separately. This module enables incremental adoption:
 * any new code can `throw new DomainError(MCP_CODES.X, msg)` and get
 * the right wire shape, without requiring the 30 sites to migrate.
 *
 * Wire shape (preserved from `errorResult` in `shared-mcp/omni-handlers.js`):
 *   { ok: false, error: "human readable", code: "MACHINE_CODE" }
 *
 * Adoption:
 *   - New code: throw `DomainError` with `MCP_CODES.*` or `COMMON_CODES.*`
 *   - Existing code: keep using `errorResult(msg, code?)`; both work.
 */

import { DomainError, COMMON_CODES } from "../bus/domain-error.js";

/**
 * MCP-specific error codes. Subset of `COMMON_CODES` plus MCP-bridge
 * extensions. Use these for new throw sites; old ones keep their string codes.
 */
export const MCP_CODES = Object.freeze({
  ...COMMON_CODES,
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  SUBSET_NOT_EXPOSED: "SUBSET_NOT_EXPOSED",
  SCRIPT_MISSING: "SCRIPT_MISSING",
  SUBPROCESS_FAILED: "SUBPROCESS_FAILED",
  BRIDGE_UNREACHABLE: "BRIDGE_UNREACHABLE",
});

/**
 * Convert any thrown value into the MCP wire shape `{ ok, error, code? }`.
 *
 * - DomainError → uses .code, .message
 * - Error       → INTERNAL + .message
 * - string      → INTERNAL + the string
 * - other       → INTERNAL + String(value)
 *
 * @param {unknown} err
 * @param {string} [fallbackMessage] - when err has no message
 * @returns {{ ok: false, error: string, code: string }}
 */
export function mcpErrorResult(err, fallbackMessage) {
  if (err instanceof DomainError) {
    return {
      ok: false,
      error: err.message || fallbackMessage || "domain-error",
      code: err.code,
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      error: err.message || fallbackMessage || "internal-error",
      code: MCP_CODES.INTERNAL,
    };
  }
  return {
    ok: false,
    error: typeof err === "string" ? err : (fallbackMessage || String(err)),
    code: MCP_CODES.INTERNAL,
  };
}

export { DomainError, COMMON_CODES };
