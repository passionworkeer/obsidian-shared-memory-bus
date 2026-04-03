# Agent Templates

Use these templates when a new host needs a repeatable integration shape instead of a one-off local tweak.

## Included

- `portable-skill/`
  - Start here when the host can read instruction files, skills, or prompt libraries.
  - Best for portable read order, durable writeback rules, and multi-agent decomposition guidance.
- `thin-plugin/`
  - Start here only when the host needs native lifecycle hooks, settings UI, or a host-owned install surface.
  - Keep it thin and point real behavior back to shared HTTP MCP plus the portable skill layer.

## Decision Rule

1. Use shared HTTP MCP for transport and process deduplication.
2. Add the portable skill template when the host can consume instruction files.
3. Add the thin plugin template only when the host truly needs native hooks or UI.

See `docs/INTEGRATION-MODES.md` and `docs/NEW-AGENT-INTEGRATION.md` for the full rationale.
