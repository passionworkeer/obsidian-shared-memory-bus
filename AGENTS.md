# Obsidian Shared Memory Bus

## Scope
- This repository owns the shared memory bus runtime, installer, generated memory artifacts, and multi-client MCP integration contracts.
- Canonical durable memory layer: `E:\.ai-memory\` (see SKILL.md for full v2 architecture). This repo is the orchestration/runtime layer.

## Read Order
1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/NEW-AGENT-INTEGRATION.md`
4. `docs/TROUBLESHOOTING.md`

## Validation
- Run `scripts/validate-layout.ps1` after touching install/runtime layout.
- Run `ops/check-memory-integrity.js --strict` after changing structured-memory contracts or generated artifacts.
- Run `verify-client-integrations.ps1` after changing client integration files or shared MCP startup behavior.

## Shared Memory Overlay

<!-- SHARED-MEMORY-BUS:START -->
## Shared Memory Bus (v2)

- Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux)
- **MCP-capable agents** (OpenCode with memory MCP on port 9338): call `memory_boot(project="obsidian-shared-memory-bus")` on session start.
- **Passive agents** (no MCP): read `E:\.ai-memory\CONTEXT.md` before substantive work — this file has everything needed to answer "who am I".
- Durable writeback: `E:\.ai-memory\projects/obsidian-shared-memory-bus.jsonl` is auto-written by Stop Hook (no manual write needed).
- Fallback writeback: `E:\.ai-memory\inbox/opencode.md` for cross-session facts.
- For tasks with 2 or more independent slices, default to multi-agent/subagent decomposition.
- Use matching skills from .agents/skills/ when available.
<!-- SHARED-MEMORY-BUS:END -->
