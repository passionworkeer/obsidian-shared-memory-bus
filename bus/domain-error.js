/**
 * bus/domain-error.js — unified error envelope for the memory bus.
 *
 * Domain errors carry a stable machine-readable `code`, a human-readable
 * `message`, and an optional `cause`. JSON.stringify and HTTP responses
 * go through `toJSON()` so the wire shape stays consistent across CLI
 * commands, MCP tool calls, and metrics HTTP endpoints.
 *
 * Wire shape:
 *   { error: { code: string, message: string, cause?: string } }
 *
 * Conventions for `code`:
 *   - UPPER_SNAKE_CASE
 *   - One of the COMMON_CODES below, or a domain-specific extension.
 *   - Never localized; the message is the human-readable surface.
 *
 * Adoption: this module is currently scoped to the embedding-provider
 * subsystem. As of 2026-06-29 there are 5 production call sites (in
 * bus/embedding-providers/{openai-compatible,gemini,transformer}-provider.js
 * and bus/embedding-provider-registry.js) plus 1 test. Broader migration of
 * `throw new Error(...)` sites to DomainError is out of scope for the
 * current wave and is tracked separately.
 */

export const COMMON_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  IO_ERROR: 'IO_ERROR',
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE',
  INTERNAL: 'INTERNAL',
});

export class DomainError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    const payload = { code: this.code, message: this.message };
    if (this.cause !== undefined) {
      payload.cause = this.cause instanceof Error
        ? this.cause.message
        : String(this.cause);
    }
    return { error: payload };
  }
}

export function toErrorPayload(err) {
  if (err instanceof DomainError) return err.toJSON();
  return {
    error: {
      code: COMMON_CODES.INTERNAL,
      message: err?.message ?? String(err),
    },
  };
}
