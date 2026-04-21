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
## Shared Obsidian Memory Bus

- Follow CLAUDE.md for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode and GitHub Copilot.
- Resolve <obsidian-vault> from AI_MEMORY_OBSIDIAN_VAULT, OBSIDIAN_VAULT_ROOT, or the active vault in Obsidian.
- Before substantive work, read <obsidian-vault>/02-KB/OBSIDIAN.md, <obsidian-vault>/02-KB/MEMORY.md, <obsidian-vault>/02-KB/WORKING.md, <obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md, and <obsidian-vault>/00-System/ai-memory/generated/tool-startup/copilot.md.
- Durable writeback targets: <obsidian-vault>/00-System/ai-memory/inbox/opencode.md (OpenCode), <obsidian-vault>/00-System/ai-memory/inbox/copilot.md (GitHub Copilot)
- Current task tracking target: <obsidian-vault>/02-KB/WORKING.md
- For tasks with 2 or more independent slices, default to multi-agent/subagent decomposition.
- Use matching skills from .claude/skills, .agents/skills, skills/, and .agents/skills/ when available.
<!-- SHARED-MEMORY-BUS:END -->
