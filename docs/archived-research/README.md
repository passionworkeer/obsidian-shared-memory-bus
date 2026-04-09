# Research & Analysis

Working documents and analysis from studying the source systems that informed this architecture.

## System Studies
| File | Description |
|------|-------------|
| [`openclaw-memory-architecture.md`](openclaw-memory-architecture.md) | OpenClaw memory architecture deep-dive (Chinese, 2026-04-03) |

## Archived Operations Scripts
Scripts that were retired and are kept for reference only.

| File | Description |
|------|-------------|
| `ops/migrate-memory-v2.js` | Memory v2 migration script (superseded by current layered memory architecture) |
| `ops/repair-codex-runtime.ps1` | Codex runtime repair helper (superseded by `install-client-integrations.ps1`) |
| `ops/verify-integrations.ps1` | Integration verification (renamed to `install-client-integrations.ps1`; kept for compatibility reference) |

See also:
- [`docs/adr/`](%20docs/adr/) — Architecture decision records including ADR-002 benchmark against OpenClaw
- [`docs/MEMORY-ARCHITECTURE-CRITIQUE.md`](../MEMORY-ARCHITECTURE-CRITIQUE.md) — Known limitations and design debt
