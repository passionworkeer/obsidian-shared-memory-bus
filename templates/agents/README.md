# Agent Templates

Use these templates when a new host needs a repeatable integration shape instead of a one-off local tweak.

## Per-Agent Skill Directory

**Preferred for all supported agents:** `.agents/skills/` in the repository root.
Each file in this directory targets one specific agent (Claude Code, Codex, OpenClaw, Trae, Cursor, Copilot) with the optimal integration path, vault resolution mechanism, and token budget guidance for that agent.

| Agent | File |
|-------|------|
| Claude Code | `.agents/skills/claude-code.md` |
| Codex | `.agents/skills/codex.md` |
| OpenClaw | `.agents/skills/openclaw.md` |
| Trae | `.agents/skills/trae.md` |
| Cursor | `.agents/skills/cursor.md` |
| Copilot | `.agents/skills/copilot.md` |

Each per-agent file includes:
- The root `SKILL.md` as its canonical entry point
- Vault path resolution mechanism specific to that agent
- Token budget guidance (~8000 chars medium / memory_wake_up for light)
- Durable writeback target: `inbox/<agent>.md`
- MCP JSON snippets for host-native wiring

## Portable Skill Template (`portable-skill/`)

Use when the agent can read instruction files, skills, or prompt libraries.
Best for portable read order, durable writeback rules, and multi-agent decomposition guidance.
**Note:** The root `SKILL.md` is now the canonical universal entry point. The `portable-skill/SKILL.md` template now serves as a legacy gateway that references the root SKILL.md.

## Thin Plugin Template (`thin-plugin/`)

Start here only when the host needs native lifecycle hooks, settings UI, or a host-owned install surface.
Keep it thin and point real behavior back to shared HTTP MCP plus the portable skill layer.

## Decision Rule

1. Use shared HTTP MCP for transport and process deduplication.
2. Add the portable skill template when the host can consume instruction files.
3. Add the thin plugin template only when the host truly needs native hooks or UI.

See `docs/ARCHITECTURE.md` for the full integration rationale.
